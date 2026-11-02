import type { PartHandler, Holding } from '../types.js';

export const dustFilter: PartHandler = async (inputs, ctx) => {
  const holdings = inputs.holdings as Holding[];
  const threshold = Number(inputs.threshold_usd ?? 1);
  const min = Number(ctx.params.min_swap_usd ?? 0.1);
  const keep = new Set((ctx.params.keep_symbols as string[] | undefined) ?? []);
  const dust: Holding[] = [];
  for (const h of holdings) {
    // reasons never reveal the creator's sealed params (keep list, minimum size) to the buyer
    const why = keep.has(h.symbol) ? 'kept (recipe rule)' : h.usd >= threshold ? `above your $${threshold} threshold` : h.usd < min ? 'too small to swap (recipe rule)' : null;
    if (why) ctx.log(`skip ${h.symbol} ($${h.usd.toFixed(2)}): ${why}`); else dust.push(h);
  }
  ctx.log(`${dust.length} dust balance(s) worth $${dust.reduce((s, h) => s + h.usd, 0).toFixed(2)} selected`, { dust: dust.map((d) => ({ symbol: d.symbol, usd: d.usd })) });
  return { dust };
};
