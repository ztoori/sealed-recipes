import type { QuoteRequest, QuoteResponse, StatusResponse } from '../../../core/src/oneclick.js';
import type { PartHandler, Holding, NearTx } from '../types.js';

const TERMINAL = new Set(['SUCCESS', 'FAILED', 'REFUNDED', 'INCOMPLETE_DEPOSIT']);

/**
 * Swap each token into `target` through the 1Click API.
 *  - intents.confidential-swap → `confidentiality: "basic"` (deposits and withdrawals unlinkable on-chain)
 *  - intents.public-swap       → `confidentiality: "public"`
 * Non-custodial: the runner never holds user funds. It prepares the NEP-141
 * `ft_transfer`s to the quoted deposit addresses; the buyer's wallet signs them once.
 *
 * Durable (exactly-once deposits): before asking for approval the part saves its quotes (write-ahead), and after
 * approval it saves the signed tx hashes before submitting them. A runner that restarts mid-part resumes from that
 * state: it never re-quotes after quotes were shown to the buyer, and never asks the buyer to sign twice for an
 * approval the marketplace already relayed. Model-checked in verification/tla/DurableRuns.tla (DepositsOnce).
 * `fraction_bps` swaps only part of each balance (e.g. 5000 = half), for workflows that sell in tranches.
 */
interface SwapState { phase: 'approval' | 'submitted'; quotes: { h: Holding; q: QuoteResponse }[]; txHashes?: string[] }
export const intentsSwap: PartHandler = async (inputs, ctx) => {
  const confidential = ctx.manifest.id.startsWith('intents.confidential-swap');
  const tokens = [...(inputs.tokens as Holding[])];
  const to = String(inputs.to);
  const target = String(inputs.target);
  const slippage = Number(ctx.params.slippage_bps ?? 100);
  if (ctx.params.batch_order === 'largest-first') tokens.sort((a, b) => b.usd - a.usd);
  const jwt = ctx.secrets.oneClickJwt;
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json', ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) };

  const fraction = BigInt(Math.round(Number(ctx.params.fraction_bps ?? 10_000)));
  if (fraction <= 0n || fraction > 10_000n) throw new Error('fraction_bps must be in 1..10000');
  const rs = ctx.resumeState as SwapState | undefined;
  const quotes: { h: Holding; q: QuoteResponse }[] = rs ? rs.quotes : [];
  if (rs) ctx.log(`resuming after a runner restart: ${rs.quotes.length} swap(s), ${rs.phase === 'submitted' ? 'deposits already signed' : 'waiting for approval'}`);
  for (const h0 of rs ? [] : tokens) {
    const h = { ...h0, amount: ((BigInt(h0.amount) * fraction) / 10_000n).toString() };
    if (h.amount === '0') { ctx.log(`skip ${h.symbol}: nothing to swap at this fraction`); continue; }
    if (h.assetId === target) { ctx.log(`skip ${h.symbol}: already the target asset`); continue; }
    const req: QuoteRequest = {
      dry: ctx.mode === 'quote', swapType: 'EXACT_INPUT', slippageTolerance: slippage,
      originAsset: h.assetId, depositType: 'ORIGIN_CHAIN',
      destinationAsset: target, amount: h.amount,
      refundTo: h.owner, refundType: 'ORIGIN_CHAIN',
      recipient: to, recipientType: 'DESTINATION_CHAIN',
      confidentiality: confidential ? 'basic' : 'public',
      deadline: new Date(Date.now() + 9 * 60_000).toISOString(),
      referral: 'sealed-recipes', quoteWaitingTimeMs: 3000,
    };
    const res = await ctx.http(`${ctx.endpoints.oneclick}/v0/quote`, { method: 'POST', headers, body: JSON.stringify(req) });
    if (!res.ok) { ctx.log(`no route for ${h.symbol} (${res.status}); left in wallet`); continue; }
    const q = (await res.json()) as QuoteResponse;
    quotes.push({ h, q });
    ctx.log(`quote ${h.symbol} → ${q.quote.amountOutFormatted} out ($${q.quote.amountOutUsd}), ${confidential ? 'confidential' : 'public'}`, { correlationId: q.correlationId });
  }
  if (!quotes.length) { ctx.log('nothing to swap'); return { receipts: [] }; }
  if (ctx.mode === 'quote') {
    // dry run for recipe intents: priced by real (dry) 1Click quotes, nothing is deposited or signed
    const receipts = quotes.map(({ h, q }) => ({ symbol: h.symbol, assetIn: h.assetId, assetOut: target, amountIn: q.quote.amountInFormatted, amountOut: q.quote.amountOutFormatted, amountOutUnits: q.quote.amountOut, minAmountOutUnits: q.quote.minAmountOut ?? q.quote.amountOut, status: 'QUOTED', confidentiality: confidential ? 'basic' : 'public' }));
    ctx.log(`priced ${receipts.length} swap(s) without executing`);
    return { receipts };
  }

  const transactions: NearTx[] = quotes.map(({ h, q }) => ({
    receiverId: h.contract,
    actions: [{ type: 'FunctionCall', params: { methodName: 'ft_transfer', args: { receiver_id: q.quote.depositAddress!, amount: q.quote.amountIn }, gas: '50000000000000', deposit: '1' } }],
  }));
  let approval: { approved: boolean; txHashes: string[] };
  if (rs?.phase === 'submitted') approval = { approved: true, txHashes: rs.txHashes ?? [] };
  else {
    if (!rs) await ctx.saveState({ phase: 'approval', quotes } satisfies SwapState); // write-ahead: quotes are fixed now
    // an approval relayed before a restart only counts for the exact quotes it was given for (saved above)
    const prior = rs ? ctx.priorApproval : undefined;
    approval = prior ?? await ctx.requestApproval({
      title: `Approve ${transactions.length} deposit${transactions.length > 1 ? 's' : ''} to NEAR Intents`,
      signer: quotes[0].h.owner,
      transactions,
      summary: quotes.map(({ h, q }) => ({ symbol: h.symbol, amount: q.quote.amountInFormatted, usd: Number(q.quote.amountInUsd), to: q.quote.depositAddress! })),
    });
    if (prior) ctx.log('the buyer already approved these deposits before the restart; not asking again');
    if (!approval.approved) throw new Error('buyer rejected the deposit transactions');
    await ctx.saveState({ phase: 'submitted', quotes, txHashes: approval.txHashes } satisfies SwapState);
  }

  // submitting the same tx hash twice is idempotent at 1Click, so a restart after this point is harmless
  for (let i = 0; i < quotes.length; i++) {
    await ctx.http(`${ctx.endpoints.oneclick}/v0/deposit/submit`, { method: 'POST', headers, body: JSON.stringify({ txHash: approval.txHashes[i], depositAddress: quotes[i].q.quote.depositAddress, nearSenderAccount: quotes[i].h.owner }) });
  }
  ctx.log(`submitted ${quotes.length} deposit tx hash(es) to 1Click`);

  const receipts: Record<string, unknown>[] = [];
  const pending = new Map(quotes.map((x, i) => [x.q.quote.depositAddress!, { ...x, i }]));
  const last = new Map<string, string>();
  const started = Date.now();
  let delay = 750;
  while (pending.size && Date.now() - started < 8 * 60_000) {
    for (const [addr, x] of pending) {
      const s = (await ctx.http(`${ctx.endpoints.oneclick}/v0/status?depositAddress=${addr}`, { headers }).then((r) => r.json())) as StatusResponse;
      if (last.get(addr) !== s.status) { last.set(addr, s.status); ctx.log(`${x.h.symbol}: ${s.status}`, { depositAddress: addr, status: s.status }); }
      if (TERMINAL.has(s.status)) {
        pending.delete(addr);
        receipts.push({ symbol: x.h.symbol, assetIn: x.h.assetId, assetOut: target, minAmountOutUnits: x.q.quote.minAmountOut ?? '0', amountIn: x.q.quote.amountInFormatted, amountOut: s.swapDetails.amountOutFormatted ?? '0', amountOutUnits: s.swapDetails.amountOut ?? '0', status: s.status, depositAddress: addr, originTx: s.swapDetails.originChainTxHashes[0]?.hash, destinationTx: s.swapDetails.destinationChainTxHashes[0]?.hash, confidentiality: confidential ? 'basic' : 'public' });
      }
    }
    // back off between status rounds (0.75 s growing to 10 s) so a long settlement stays inside max_http_calls
    if (pending.size) { await new Promise((r) => setTimeout(r, delay)); delay = Math.min(10_000, Math.round(delay * 1.5)); }
  }
  if (pending.size) throw new Error(`${pending.size} swap(s) did not reach a terminal status in time`);
  const ok = receipts.filter((r) => r.status === 'SUCCESS');
  ctx.log(`${ok.length}/${receipts.length} swaps settled to ${to.slice(0, 10)}…`, { receipts });
  return { receipts };
};
