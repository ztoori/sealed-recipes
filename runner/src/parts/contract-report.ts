import type { PartHandler, ContractFacts, ContractVerdict, ReportItem } from '../types.js';

export const contractReport: PartHandler = async (inputs, ctx) => {
  const f = inputs.facts as ContractFacts, v = inputs.verdict as ContractVerdict;
  const advice = { low: 'No red flags found. Still only approve what you meant to do.', medium: 'Proceed with care: approve small amounts and check what you sign.', high: 'Do not connect your wallet or sign anything for this contract.' }[v.risk];
  const items: ReportItem[] = [
    { label: 'Verdict', detail: `${v.risk} risk (${v.source === 'nearai-tee' ? 'private AI, signature verified' : 'rules'}). ${advice}`, tag: v.risk === 'low' ? 'ok' : v.risk === 'medium' ? 'warn' : 'bad' },
    ...v.reasons.map((r) => ({ label: 'Signal', detail: r })),
    { label: 'Upgradable', detail: !f.has_code ? 'n/a' : f.full_access_keys ? `yes, by ${f.full_access_keys} full-access key holder(s)` : 'no: the contract is locked', tag: f.full_access_keys ? 'warn' : 'ok' },
    { label: 'Source', detail: f.source?.link ? `${f.source.link} (v${f.source.version ?? '?'})` : 'not published (no NEP-330 metadata)', tag: f.source ? 'ok' : 'warn' },
  ];
  const report = { title: `${f.account}: ${v.risk} risk`, items };
  ctx.log(report.title);
  return { report };
};
