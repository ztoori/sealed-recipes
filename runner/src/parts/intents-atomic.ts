import { randomBytes } from 'node:crypto';
import { base64 } from '../../../core/src/seal.js';
import type { Nep413Payload, SignedNep413 } from '../../../core/src/nep413.js';
import type { PartHandler, Holding, NearTx } from '../types.js';

const VERIFIER = 'intents.near';
interface RelayQuote { quote_hash: string; defuse_asset_identifier_in: string; defuse_asset_identifier_out: string; amount_in: string; amount_out: string; expiration_time: string }
interface AtomicState { phase: 'approval' | 'published'; quotes: { h: Holding; q: RelayQuote }[]; payload: Nep413Payload; intent_hash?: string; signed?: SignedNep413 }

/**
 * All-or-nothing swap of every token into `target`, through the NEAR Intents Verifier (intents.near) and the
 * Solver Relay. The buyer's wallet deposits the tokens into the Verifier and signs ONE NEP-413 payload holding a
 * token_diff per swap plus a single ft_withdraw of the proceeds to `to`. The relay adds the solvers' mirror diffs
 * and the Verifier executes the batch atomically: either every swap and the withdrawal happen, or none does and
 * the deposits stay in the buyer's Verifier balance (withdrawable at any time).
 *
 * Trade-offs versus intents.confidential-swap (1Click): atomic, but swaps through the Verifier are public on NEAR,
 * and there is no confidentiality mode here. Durable like the other swap: quotes and the payload are saved before
 * the buyer signs, and the intent hash before it is published, so a restarted runner never re-signs or re-sends.
 */
export const intentsAtomic: PartHandler = async (inputs, ctx) => {
  const tokens = [...(inputs.tokens as Holding[])].filter((h) => h.assetId !== String(inputs.target));
  const to = String(inputs.to);
  const target = String(inputs.target);
  const rpc = async <T>(method: string, params: unknown): Promise<T> => {
    const r = await ctx.http(`${ctx.endpoints.solverRelay}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params: [params] }) });
    const j = (await r.json()) as { result?: T; error?: { message: string } };
    if (j.error) throw new Error(`solver relay ${method}: ${j.error.message}`);
    return j.result as T;
  };

  const rs = ctx.resumeState as AtomicState | undefined;
  let quotes = rs?.quotes ?? [];
  if (!rs) {
    for (const h of tokens) {
      const qs = await rpc<RelayQuote[]>('quote', { defuse_asset_identifier_in: h.assetId, defuse_asset_identifier_out: target, exact_amount_in: h.amount });
      const best = [...(qs ?? [])].sort((a, b) => (BigInt(b.amount_out) > BigInt(a.amount_out) ? 1 : -1))[0];
      if (!best) { ctx.log(`no solver quote for ${h.symbol}; left in wallet`); continue; }
      quotes.push({ h, q: best });
      ctx.log(`solver quote ${h.symbol} → ${best.amount_out} units of the target (firm, ${best.quote_hash.slice(0, 8)}…)`);
    }
  }
  if (!quotes.length) { ctx.log('nothing to swap'); return { receipts: [] }; }
  if (ctx.mode === 'quote') {
    // solver quotes are firm amounts: promised = expected; nothing is deposited or signed
    return { receipts: quotes.map(({ h, q }) => ({ symbol: h.symbol, assetIn: h.assetId, assetOut: target, amountIn: h.amount, amountOutUnits: q.amount_out, minAmountOutUnits: q.amount_out, status: 'QUOTED', confidentiality: 'public', atomic: true })) };
  }

  const total = quotes.reduce((s, { q }) => s + BigInt(q.amount_out), 0n);
  const owner = quotes[0].h.owner;
  const payload: Nep413Payload = rs?.payload ?? {
    recipient: VERIFIER,
    nonce: base64.enc(randomBytes(32)),
    message: JSON.stringify({
      signer_id: owner,
      deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
      intents: [
        ...quotes.map(({ h, q }) => ({ intent: 'token_diff', diff: { [h.assetId]: `-${q.amount_in}`, [target]: q.amount_out } })),
        { intent: 'ft_withdraw', token: target.replace(/^nep141:/, ''), receiver_id: to, amount: total.toString() },
      ],
    }),
  };

  let published = rs?.phase === 'published' ? rs.intent_hash : undefined;
  if (!published) {
    let signed = rs?.signed;
    if (!signed) {
      if (!rs) await ctx.saveState({ phase: 'approval', quotes, payload } satisfies AtomicState); // write-ahead
      const deposits: NearTx[] = quotes.map(({ h }) => ({ receiverId: h.contract, actions: [{ type: 'FunctionCall', params: { methodName: 'ft_transfer_call', args: { receiver_id: VERIFIER, amount: h.amount, msg: '' }, gas: '50000000000000', deposit: '1' } }] }));
      const prior = rs ? ctx.priorApproval : undefined;
      const approval = prior ?? await ctx.requestApproval({
        title: `Deposit ${deposits.length} token${deposits.length > 1 ? 's' : ''} and sign one all-or-nothing swap`,
        signer: owner, transactions: deposits, sign_message: payload,
        sign_summary: `${quotes.length} swaps + 1 withdrawal to ${to.slice(0, 10)}…, executed together or not at all`,
        summary: quotes.map(({ h }) => ({ symbol: h.symbol, amount: h.amount, usd: h.usd, to: VERIFIER })),
      });
      if (!approval.approved || !approval.signed) throw new Error('buyer did not sign the bundle');
      signed = approval.signed;
    }
    const r = await rpc<{ status: string; intent_hash: string }>('publish_intent', { quote_hashes: quotes.map(({ q }) => q.quote_hash), signed_data: signed });
    published = r.intent_hash;
    await ctx.saveState({ phase: 'published', quotes, payload, intent_hash: published } satisfies AtomicState);
    ctx.log(`published one bundle: ${quotes.length} swaps + withdrawal (intent ${published.slice(0, 10)}…)`);
  }

  let st: { status: string; reason?: string; data?: { hash: string } } = { status: 'PENDING' };
  for (let i = 0, delay = 300; i < 60 && (st.status === 'PENDING' || st.status === 'TX_BROADCASTED'); i++, delay = Math.min(5000, delay * 2)) {
    st = await rpc('get_status', { intent_hash: published });
    if (st.status === 'PENDING' || st.status === 'TX_BROADCASTED') await new Promise((ok) => setTimeout(ok, delay));
  }
  if (st.status !== 'SETTLED') {
    ctx.log(`bundle NOT executed (${st.reason ?? st.status}): no swap happened; deposits stay in your intents.near balance`);
    throw new Error(`atomic bundle reverted: ${st.reason ?? st.status}`);
  }
  ctx.log(`settled atomically in one execute_intents (${st.data?.hash ?? ''}): ${quotes.length}/${quotes.length} swaps and the withdrawal`);
  return { receipts: quotes.map(({ h, q }) => ({ symbol: h.symbol, assetIn: h.assetId, assetOut: target, amountIn: h.amount, amountOutUnits: q.amount_out, minAmountOutUnits: q.amount_out, amountOut: q.amount_out, status: 'SUCCESS', confidentiality: 'public', atomic: true, tx: st.data?.hash })) };
};
