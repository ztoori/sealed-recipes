import type { BlockHandler, Holding } from '../types.js';

export const dustFilter: BlockHandler = async (inputs, ctx) => {
  const holdings = inputs.holdings as Holding[];
  const threshold = Number(inputs.threshold_usd ?? 1);
  const min = Number(ctx.params.min_swap_usd ?? 0.1);
  const keep = new Set((ctx.params.keep_symbols as string[] | undefined) ?? []);
  const dust: Holding[] = [];
  for (const h of holdings) {
    const why = keep.has(h.symbol) ? 'kept by creator rule' : h.usd >= threshold ? `above $${threshold}` : h.usd < min ? `below solver minimum $${min}` : null;
    if (why) ctx.log(`skip ${h.symbol} ($${h.usd.toFixed(2)}): ${why}`); else dust.push(h);
  }
  ctx.log(`${dust.length} dust balance(s) worth $${dust.reduce((s, h) => s + h.usd, 0).toFixed(2)} selected`, { dust: dust.map((d) => ({ symbol: d.symbol, usd: d.usd })) });
  return { dust };
};
