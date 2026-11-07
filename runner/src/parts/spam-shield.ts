import type { PartHandler, Flag, Holding } from '../types.js';
import { verifiedChat, verdictJson } from './nearai-verified.js';

/**
 * Private AI guard on NEAR AI Cloud. The creator's classifier prompt (`policy`) is a
 * sealed param: it is decrypted only inside the runner TEE and sent to a model TEE
 * over TLS that terminates inside NEAR AI Cloud's gateway TEE.
 * Every verdict is verified: chat signature → attested signing_address → TDX/NVIDIA (see nearai-verified.ts).
 */
export const spamShield: PartHandler = async (inputs, ctx) => {
  const holdings = inputs.holdings as Holding[];
  const policy = String(ctx.params.policy ?? 'Flag scam tokens. Answer JSON only.');
  const facts = holdings.map((h) => ({ contract: h.contract, symbol: h.symbol, name: h.name, usd: h.usd, quoted_by_solvers: h.listed }));
  const { content } = await verifiedChat(ctx, policy + '\nReturn {"verdicts":[{"contract":string,"verdict":"SCAM"|"OK","reason":string}]}', JSON.stringify(facts));
  const parsed = verdictJson<{ verdicts: { contract: string; verdict: string; reason: string }[] }>(content);

  const flags: Flag[] = [];
  const clean: Holding[] = [];
  for (const h of holdings) {
    const vd = parsed.verdicts.find((x) => x.contract === h.contract);
    const scam = vd?.verdict?.toUpperCase() === 'SCAM';
    flags.push({ assetId: h.assetId, symbol: h.symbol, verdict: scam ? 'SCAM' : 'OK', reason: vd?.reason ?? 'no verdict', source: 'nearai-tee' });
    if (!scam) clean.push(h);
  }
  ctx.log(`${flags.filter((f) => f.verdict === 'SCAM').length} scam token(s) quarantined`, { flagged: flags.filter((f) => f.verdict === 'SCAM') });
  return { clean, flags };
};
