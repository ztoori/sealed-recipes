import { randomBytes } from 'node:crypto';
import { verifyChat, checkReportDataBinding, checkNras, type ChatSignature, type Check } from '../../../core/src/nearai.js';
import type { BlockHandler, Flag, Holding } from '../types.js';

/**
 * Private AI guard on NEAR AI Cloud. The creator's classifier prompt (`policy`) is a
 * sealed param: it is decrypted only inside the runner TEE and sent to a model TEE
 * over TLS that terminates inside NEAR AI Cloud's gateway TEE.
 * Every verdict is verified: chat signature → attested signing_address → TDX/NVIDIA.
 */
export const spamShield: BlockHandler = async (inputs, ctx) => {
  const holdings = inputs.holdings as Holding[];
  const model = String(ctx.params.model ?? 'Qwen/Qwen3-30B-A3B-Instruct-2507');
  const policy = String(ctx.params.policy ?? 'Flag scam tokens. Answer JSON only.');
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${ctx.secrets.nearAiKey ?? ''}` };

  // 1) attestation with a fresh nonce
  const nonce = randomBytes(32).toString('hex');
  const att = await ctx.http(`${ctx.endpoints.nearai}/v1/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa&nonce=${nonce}`, { headers }).then((r) => r.json()) as {
    model_attestations: { signing_address: string; nvidia_payload?: string; intel_quote?: string; report_data?: string; tee?: string }[];
  };
  const node = att.model_attestations[0];
  ctx.log(`model attestation received for ${model}; TEE signing address ${node.signing_address}`);

  // 2) classification
  const facts = holdings.map((h) => ({ contract: h.contract, symbol: h.symbol, name: h.name, usd: h.usd, quoted_by_solvers: h.listed }));
  const requestBody = JSON.stringify({ model, temperature: 0, stream: false, messages: [
    { role: 'system', content: policy + '\nReturn {"verdicts":[{"contract":string,"verdict":"SCAM"|"OK","reason":string}]}' },
    { role: 'user', content: JSON.stringify(facts) },
  ] });
  const res = await ctx.http(`${ctx.endpoints.nearai}/v1/chat/completions`, { method: 'POST', headers, body: requestBody });
  const responseBody = await res.text();
  if (!res.ok) throw new Error(`NEAR AI Cloud ${res.status}: ${responseBody.slice(0, 160)}`);
  const completion = JSON.parse(responseBody) as { id: string; choices: { message: { content: string } }[] };
  const raw = completion.choices[0].message.content.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(json)?/g, '').trim();
  const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as { verdicts: { contract: string; verdict: string; reason: string }[] };

  // 3) verify the signed response against the attested key
  let sig: ChatSignature | undefined;
  for (let i = 0; i < 5 && !sig; i++) {
    const s = await ctx.http(`${ctx.endpoints.nearai}/v1/signature/${completion.id}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`, { headers });
    if (s.ok) sig = (await s.json()) as ChatSignature; else await new Promise((r) => setTimeout(r, 300 * (i + 1)));
  }
  const checks: Check[] = [];
  if (!sig) throw new Error('could not fetch chat signature');
  // provider_tee signatures must come from the attested model key; gateway-kind signatures come from the
  // NEAR AI gateway TEE and are checked against the key in its own signature record (see docs/THREAT_MODEL.md)
  const v = verifyChat(requestBody, responseBody, sig, sig.signature_kind === 'gateway' ? sig.signing_address : node.signing_address);
  if (sig.signature_kind === 'gateway') checks.push({ id: 'chat.kind', label: 'Signed by the NEAR AI gateway TEE (gateway attestation not re-verified here)', status: 'skip', detail: sig.signing_address });
  checks.push({ id: 'chat.hash', label: 'Signed text = sha256(request):sha256(response)', status: v.signedTextMatches ? 'pass' : 'fail', detail: `${v.requestHash.slice(0, 12)}…:${v.responseHash.slice(0, 12)}…` });
  checks.push({ id: 'chat.signer', label: 'Signature recovers to attested TEE address', status: v.signerMatchesAttestation ? 'pass' : 'fail', detail: v.recovered });
  if (node.report_data) checks.push(...checkReportDataBinding(node.report_data, node.signing_address, nonce));
  if (node.nvidia_payload) {
    try {
      const nras = await ctx.http(`${ctx.endpoints.nras}/v3/attest/gpu`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: node.nvidia_payload }).then((r) => r.json());
      checks.push(...checkNras(nras, nonce));
    } catch (e) { checks.push({ id: 'nras', label: 'NVIDIA NRAS GPU attestation', status: 'fail', detail: (e as Error).message }); }
  } else checks.push({ id: 'nras', label: 'NVIDIA NRAS GPU attestation', status: 'skip', detail: 'no nvidia_payload (local mock of NEAR AI Cloud)' });
  if (!node.intel_quote) checks.push({ id: 'tdx', label: 'Intel TDX quote (dcap-qvl)', status: 'skip', detail: 'no intel_quote (local mock of NEAR AI Cloud)' });
  else checks.push({ id: 'tdx', label: 'Intel TDX quote present (verify with dcap-qvl)', status: 'pass', detail: `${node.intel_quote.length / 2} bytes` });
  if (checks.some((c) => c.status === 'fail')) throw new Error('NEAR AI Cloud verification failed: ' + checks.filter((c) => c.status === 'fail').map((c) => c.label).join(', '));
  ctx.log(`AI verdicts verified: ${checks.filter((c) => c.status === 'pass').length} checks passed`, { checks, chat_id: completion.id, signing_address: node.signing_address, mock: node.tee === 'mock' });

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
