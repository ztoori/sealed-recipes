import type { QuoteRequest, QuoteResponse, StatusResponse } from '../../../core/src/oneclick.js';
import type { PartHandler, Holding, NearTx } from '../types.js';

const TERMINAL = new Set(['SUCCESS', 'FAILED', 'REFUNDED', 'INCOMPLETE_DEPOSIT']);

/**
 * Swap each token into `target` through the 1Click API.
 *  - intents.confidential-swap → `confidentiality: "basic"` (deposits and withdrawals unlinkable on-chain)
 *  - intents.public-swap       → `confidentiality: "public"`
 * Non-custodial: the runner never holds user funds. It prepares the NEP-141
 * `ft_transfer`s to the quoted deposit addresses; the buyer's wallet signs them once.
 */
export const intentsSwap: PartHandler = async (inputs, ctx) => {
  const confidential = ctx.manifest.id.startsWith('intents.confidential-swap');
  const tokens = [...(inputs.tokens as Holding[])];
  const to = String(inputs.to);
  const target = String(inputs.target);
  const slippage = Number(ctx.params.slippage_bps ?? 100);
  if (ctx.params.batch_order === 'largest-first') tokens.sort((a, b) => b.usd - a.usd);
  const jwt = ctx.secrets.oneClickJwt;
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json', ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) };

  const quotes: { h: Holding; q: QuoteResponse }[] = [];
  for (const h of tokens) {
    if (h.assetId === target) { ctx.log(`skip ${h.symbol}: already the target asset`); continue; }
    const req: QuoteRequest = {
      dry: ctx.mode === 'quote', swapType: 'EXACT_INPUT', slippageTolerance: slippage,
      originAsset: h.assetId, depositType: 'ORIGIN_CHAIN',
      destinationAsset: target, amount: h.amount,
      refundTo: h.owner, refundType: 'ORIGIN_CHAIN',
      recipient: to, recipientType: 'DESTINATION_CHAIN',
      confidentiality: confidential ? 'basic' : 'public',
      deadline: new Date(Date.now() + 9 * 60_000).toISOString(),
      referral: 'fungible-recipes', quoteWaitingTimeMs: 3000,
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
  const approval = await ctx.requestApproval({
    title: `Approve ${transactions.length} deposit${transactions.length > 1 ? 's' : ''} to NEAR Intents`,
    signer: tokens[0].owner,
    transactions,
    summary: quotes.map(({ h, q }) => ({ symbol: h.symbol, amount: q.quote.amountInFormatted, usd: Number(q.quote.amountInUsd), to: q.quote.depositAddress! })),
  });
  if (!approval.approved) throw new Error('buyer rejected the deposit transactions');

  for (let i = 0; i < quotes.length; i++) {
    await ctx.http(`${ctx.endpoints.oneclick}/v0/deposit/submit`, { method: 'POST', headers, body: JSON.stringify({ txHash: approval.txHashes[i], depositAddress: quotes[i].q.quote.depositAddress, nearSenderAccount: quotes[i].h.owner }) });
  }
  ctx.log(`submitted ${quotes.length} deposit tx hash(es) to 1Click`);

  const receipts: Record<string, unknown>[] = [];
  const pending = new Map(quotes.map((x, i) => [x.q.quote.depositAddress!, { ...x, i }]));
  const last = new Map<string, string>();
  const started = Date.now();
  while (pending.size && Date.now() - started < 8 * 60_000) {
    for (const [addr, x] of pending) {
      const s = (await ctx.http(`${ctx.endpoints.oneclick}/v0/status?depositAddress=${addr}`, { headers }).then((r) => r.json())) as StatusResponse;
      if (last.get(addr) !== s.status) { last.set(addr, s.status); ctx.log(`${x.h.symbol}: ${s.status}`, { depositAddress: addr, status: s.status }); }
      if (TERMINAL.has(s.status)) {
        pending.delete(addr);
        receipts.push({ symbol: x.h.symbol, assetIn: x.h.assetId, assetOut: target, minAmountOutUnits: x.q.quote.minAmountOut ?? '0', amountIn: x.q.quote.amountInFormatted, amountOut: s.swapDetails.amountOutFormatted ?? '0', amountOutUnits: s.swapDetails.amountOut ?? '0', status: s.status, depositAddress: addr, originTx: s.swapDetails.originChainTxHashes[0]?.hash, destinationTx: s.swapDetails.destinationChainTxHashes[0]?.hash, confidentiality: confidential ? 'basic' : 'public' });
      }
    }
    if (pending.size) await new Promise((r) => setTimeout(r, 500));
  }
  if (pending.size) throw new Error(`${pending.size} swap(s) did not reach a terminal status in time`);
  const ok = receipts.filter((r) => r.status === 'SUCCESS');
  ctx.log(`${ok.length}/${receipts.length} swaps settled to ${to.slice(0, 10)}…`, { receipts });
  return { receipts };
};
