import type { PartHandler, ContractFacts, ContractVerdict } from '../types.js';
import { verifiedChat, verdictJson } from './nearai-verified.js';

/**
 * Private AI verdict on a contract (NEAR AI Cloud, verified like every AI part). The creator's policy is sealed: it
 * typically knows lookalike patterns and which signals matter. Input is the on-chain facts, never the user's wallet.
 */
export const aiContractRisk: PartHandler = async (inputs, ctx) => {
  const facts = inputs.facts as ContractFacts;
  const policy = String(ctx.params.policy ?? 'Judge whether interacting with this NEAR contract is risky.');
  const { content } = await verifiedChat(ctx, policy + '\nReturn {"risk":"low"|"medium"|"high","reasons":[string]}', JSON.stringify({ kind: 'contract', ...facts }));
  const v = verdictJson<{ risk: string; reasons: string[] }>(content);
  const risk = (['low', 'medium', 'high'].includes(v.risk) ? v.risk : 'high') as ContractVerdict['risk'];
  ctx.log(`AI verdict: ${risk} risk`, { reasons: v.reasons });
  return { verdict: { risk, reasons: (v.reasons ?? []).slice(0, 6).map(String), source: 'nearai-tee' } satisfies ContractVerdict };
};

/**
 * Deterministic rules on the same facts. Cheaper and open; no model. `lookalikes` (sealed) lists well-known names a
 * phishing contract tends to imitate.
 */
export const rulesContractRisk: PartHandler = async (inputs, ctx) => {
  const f = inputs.facts as ContractFacts;
  const brands = (ctx.params.lookalikes as string[] | undefined) ?? [];
  const reasons: string[] = [];
  let risk: ContractVerdict['risk'] = 'low';
  const bump = (r: ContractVerdict['risk'], why: string) => { reasons.push(why); if (r === 'high' || (r === 'medium' && risk === 'low')) risk = r; };
  if (!f.exists) bump('high', 'the account does not exist');
  else if (!f.has_code) bump('high', 'not a contract: a plain account with no code');
  else {
    const brand = brands.find((b) => f.account.includes(b) && !f.account.endsWith(`.${b}.near`) && f.account !== `${b}.near`);
    if (brand && !f.listed_token && !f.source) bump('high', `name imitates "${brand}" but has no verifiable source`);
    if (f.full_access_keys > 0) bump(f.source ? 'medium' : 'high', `${f.full_access_keys} full-access key(s): whoever holds them can replace the code at any time`);
    if (!f.source) bump('medium', 'no NEP-330 source metadata: the code cannot be matched to a published repository');
    if (f.source?.link) reasons.push(`publishes source: ${f.source.link}`);
    if (f.listed_token) reasons.push('listed as a token by NEAR Intents solvers');
  }
  ctx.log(`rules verdict: ${risk} risk`, { reasons });
  return { verdict: { risk, reasons, source: 'rules' } satisfies ContractVerdict };
};
