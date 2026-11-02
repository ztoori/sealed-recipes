import type { PartHandler, Flag, Holding } from '../types.js';

/** Deterministic guard: anything 1Click solvers will not quote is treated as unsafe. */
export const allowlistShield: PartHandler = async (inputs, ctx) => {
  const holdings = inputs.holdings as Holding[];
  const res = await ctx.http(`${ctx.endpoints.oneclick}/v0/tokens`);
  const listed = new Set(((await res.json()) as { assetId: string }[]).map((t) => t.assetId));
  const flags: Flag[] = holdings.map((h) => ({ assetId: h.assetId, symbol: h.symbol, verdict: listed.has(h.assetId) ? 'OK' : 'SCAM', reason: listed.has(h.assetId) ? 'listed by 1Click' : 'not quoted by any solver', source: 'allowlist' }));
  ctx.log(`${flags.filter((f) => f.verdict === 'SCAM').length} unlisted token(s) excluded`);
  return { clean: holdings.filter((h) => listed.has(h.assetId)), flags };
};
