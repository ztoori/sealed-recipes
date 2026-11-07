import type { PartHandler, Holding } from '../types.js';

/**
 * Concentration cap: for every holding above `max_share` percent of the wallet's value, sell just the excess. Excluded
 * symbols (sealed param; stablecoins by default) are never sold and still count towards the total. Outputs the
 * amounts to sell as token.holdings, so any swap part can execute them.
 */
export const trimPlan: PartHandler = async (inputs, ctx) => {
  const holdings = inputs.holdings as Holding[];
  const cap = Number(inputs.max_share);
  if (!(cap > 0 && cap < 100)) throw new Error('max_share must be between 0 and 100 percent');
  const exclude = new Set((ctx.params.exclude_symbols as string[] | undefined) ?? ['USDC', 'USDT']);
  const minUsd = Number(ctx.params.min_trade_usd ?? 1);
  const total = holdings.reduce((t, h) => t + h.usd, 0);
  const limit = (total * cap) / 100;
  const trim: Holding[] = [];
  for (const h of holdings) {
    const share = total ? (h.usd / total) * 100 : 0;
    if (exclude.has(h.symbol) || h.usd <= limit) continue;
    const excessUsd = h.usd - limit;
    if (excessUsd < minUsd) { ctx.log(`${h.symbol} is ${share.toFixed(1)}%: excess too small to trade`); continue; }
    const bps = BigInt(Math.floor((excessUsd / h.usd) * 10_000));
    const amount = ((BigInt(h.amount) * bps) / 10_000n).toString();
    trim.push({ ...h, amount, usd: +excessUsd.toFixed(4) });
    ctx.log(`${h.symbol} is ${share.toFixed(1)}% of $${total.toFixed(2)}: sell $${excessUsd.toFixed(2)} to bring it to ${cap}%`);
  }
  if (!trim.length) ctx.log(`no position above ${cap}% of $${total.toFixed(2)}`);
  return { trim };
};
