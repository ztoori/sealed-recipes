/**
 * Live smoke test against the REAL services the runner uses in production.
 * Spends nothing: 1Click quotes are dry:true, FastNEAR/RPC are reads.
 *   npm run live-check                      (1Click + FastNEAR + NEAR RPC)
 *   NEAR_AI_API_KEY=... npm run live-check  (+ NEAR AI Cloud attestation, chat and signature verification)
 * Optional: ONECLICK_JWT (1Click partner JWT): lower fees, and required by 1Click for confidential quotes.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
if (existsSync('.env')) { try { process.loadEnvFile('.env'); } catch { /* older node */ } }
import { OneClick, runPaymentQuoteRequest, USDC_NEAR, ONECLICK_BASE } from '../core/src/oneclick.js';
import { NearAiCloud, verifyChat, checkReportDataBinding, checkNras } from '../core/src/nearai.js';

let fails = 0;
const ok = (m: string) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m: string, e: unknown) => { fails++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}: ${(e as Error).message ?? e}`); };
const skip = (m: string) => console.log(`  \x1b[33mSKIP\x1b[0m ${m}`);

console.log('1Click (NEAR Intents) —', ONECLICK_BASE);
const oc = new OneClick({ mode: 'live', jwt: process.env.ONECLICK_JWT });
try {
  const tokens = await oc.tokens();
  const usdc = tokens.find((t) => t.assetId === USDC_NEAR);
  const wnear = tokens.find((t) => t.assetId === 'nep141:wrap.near');
  if (!usdc || !wnear) throw new Error('USDC or wNEAR not listed');
  ok(`/v0/tokens: ${tokens.length} tokens, wNEAR $${wnear.price}`);
  const fresh = randomBytes(32).toString('hex');
  const swapReq = (confidentiality: 'public' | 'basic') => ({ dry: true, swapType: 'EXACT_INPUT' as const, slippageTolerance: 100, originAsset: wnear.assetId, depositType: 'ORIGIN_CHAIN' as const, destinationAsset: USDC_NEAR, amount: (10n ** 24n).toString(), refundTo: 'srs-live-check.near', refundType: 'ORIGIN_CHAIN' as const, recipient: fresh, recipientType: 'DESTINATION_CHAIN' as const, confidentiality, deadline: new Date(Date.now() + 600_000).toISOString(), referral: 'sealed-recipes' });
  const pub = await oc.quote(swapReq('public'));
  ok(`public dry quote 1 wNEAR → ${pub.quote.amountOutFormatted} USDC to a fresh implicit account`);
  // since Nov 2026 1Click requires partner authentication for confidential quotes
  if (process.env.ONECLICK_JWT) {
    try { const conf = await oc.quote(swapReq('basic')); ok(`confidential dry quote 1 wNEAR → ${conf.quote.amountOutFormatted} USDC`); }
    catch (e) { bad('confidential dry quote (with ONECLICK_JWT)', e); }
  } else skip('confidential dry quote: 1Click requires a partner JWT for confidential quotes; set ONECLICK_JWT (partners.near-intents.org)');
  const arbUsdc = tokens.find((t) => t.assetId === 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near');
  if (arbUsdc) {
    const msg = JSON.stringify({ action: 'run', recipe_id: 'CLNP', run_id: 'r-live-check', inputs_hash: '0'.repeat(64), on_behalf_of: 'bob.near' });
    const pay = await oc.quote({ ...runPaymentQuoteRequest({ originAsset: arbUsdc.assetId, refundTo: '0x000000000000000000000000000000000000dEaD', contractId: 'sealed-recipes.near', price: '750000', msg }), dry: true, deadline: new Date(Date.now() + 600_000).toISOString() });
    ok(`run-payment dry quote: ${pay.quote.amountInFormatted} USDC(Arbitrum) → exactly 0.75 USDC to the contract with customRecipientMsg`);
  } else skip('Arbitrum USDC not listed; run-payment quote skipped');
} catch (e) { bad('1Click', e); }

console.log('FastNEAR + NEAR RPC');
try {
  const r = await fetch('https://api.fastnear.com/v1/account/wrap.near/ft');
  const j = (await r.json()) as { tokens?: unknown[] };
  if (!Array.isArray(j.tokens)) throw new Error('unexpected shape ' + JSON.stringify(j).slice(0, 120));
  ok(`FastNEAR /v1/account/{id}/ft returns ${j.tokens.length} balances for wrap.near`);
  const fresh = randomBytes(32).toString('hex');
  const v = await fetch('https://rpc.mainnet.fastnear.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: fresh } }) }).then((x) => x.json()) as { error?: { cause?: { name?: string } } };
  if (v.error?.cause?.name !== 'UNKNOWN_ACCOUNT') throw new Error('expected UNKNOWN_ACCOUNT, got ' + JSON.stringify(v).slice(0, 160));
  ok('RPC view_account on a random implicit account → UNKNOWN_ACCOUNT (fresh-address check works)');
} catch (e) { bad('FastNEAR/RPC', e); }

console.log('NEAR AI Cloud — private inference + verification');
const key = process.env.NEAR_AI_API_KEY;
if (!key) skip('set NEAR_AI_API_KEY to verify a real TEE-signed completion');
else {
  const model = process.env.NEAR_AI_MODEL ?? 'Qwen/Qwen3-30B-A3B-Instruct-2507';
  const ai = new NearAiCloud(key);
  try {
    const nonce = randomBytes(32).toString('hex');
    const att = await ai.attestation(model, nonce);
    const node = att.model_attestations[0];
    ok(`attestation: signing_address ${node.signing_address}, intel_quote ${node.intel_quote ? node.intel_quote.length / 2 + ' bytes' : 'missing'}`);
    if (typeof node.report_data === 'string') for (const c of checkReportDataBinding(node.report_data, node.signing_address, nonce)) (c.status === 'pass' ? ok : (m: string) => bad(m, c.detail))(c.label);
    if (node.nvidia_payload) {
      const nras = await fetch('https://nras.attestation.nvidia.com/v3/attest/gpu', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: node.nvidia_payload }).then((r) => r.json());
      for (const c of checkNras(nras, nonce)) (c.status === 'pass' ? ok : (m: string) => bad(m, c.detail))(c.label);
    }
    const chat = await ai.chat(model, [{ role: 'user', content: 'Reply with the single word: sealed' }]);
    const sig = await ai.signature(chat.id, model);
    // provider_tee: signed by the model TEE (must equal the attested model key); gateway: signed by the gateway TEE
    const expected = sig.signature_kind === 'gateway' ? sig.signing_address : node.signing_address;
    if (sig.signature_kind === 'gateway') skip('response was re-signed by the gateway TEE; verify the gateway attestation report for that key (docs: gateway verification)');
    const v = verifyChat(chat.requestBody, chat.responseBody, sig, expected);
    if (!v.ok) throw new Error(`signature check failed (text match ${v.signedTextMatches}, signer ${v.recovered})`);
    ok(`chat ${chat.id} signed inside the TEE by ${v.recovered} (${sig.signature_kind ?? 'legacy'}) — verified`);
  } catch (e) { bad('NEAR AI Cloud', e); }
}
console.log(fails ? `\n${fails} check(s) failed` : '\nall live checks passed');
process.exit(fails ? 1 : 0);
