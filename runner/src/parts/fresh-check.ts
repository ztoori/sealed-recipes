import type { PartHandler } from '../types.js';

/** A fresh address must not exist on-chain: NEAR RPC view_account → UNKNOWN_ACCOUNT. */
export const freshCheck: PartHandler = async (inputs, ctx) => {
  const addr = String(inputs.recipient);
  if (!/^[0-9a-f]{64}$/.test(addr)) throw new Error('fresh recipient must be an implicit (64-hex) account generated client-side');
  const r = await ctx.http(ctx.endpoints.rpc, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'frs', method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: addr } }),
  }).then((x) => x.json() as Promise<{ result?: unknown; error?: { cause?: { name?: string } } }>);
  if (r.result) throw new Error('recipient already exists on-chain — not fresh');
  if (r.error?.cause?.name !== 'UNKNOWN_ACCOUNT') throw new Error('unexpected RPC response: ' + JSON.stringify(r.error));
  ctx.log(`${addr.slice(0, 10)}…${addr.slice(-6)} has no on-chain history (UNKNOWN_ACCOUNT)`);
  return { fresh: addr };
};
