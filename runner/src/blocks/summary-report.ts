import type { BlockHandler, Flag, Holding } from '../types.js';

export const summaryReport: BlockHandler = async (inputs, ctx) => {
  const flags = inputs.flags as Flag[];
  const holdings = inputs.holdings as Holding[];
  const scams = flags.filter((f) => f.verdict === 'SCAM');
  const report = {
    title: scams.length ? `${scams.length} token(s) you should never touch` : 'No scam tokens found',
    scanned: holdings.length,
    safe_value_usd: +holdings.filter((h) => !scams.some((s) => s.assetId === h.assetId)).reduce((s, h) => s + h.usd, 0).toFixed(2),
    flagged: scams.map((s) => ({ symbol: s.symbol, contract: s.assetId.replace(/^nep141:/, ''), reason: s.reason })),
  };
  ctx.log(report.title, report);
  return { report };
};
