// Submit report.audit (PART_VERSION, default 1.0.0; 1.1.0 adds the audited account as an input) through the standard admission flow on a local marketplace (SRS_URL):
// register the manifest, submit manifest + source signed by the author, wait for the automated checks.
// An open-tier part is approved by passing them; `npm run release:parts -- --yes` then releases it.
import { readFileSync } from 'node:fs';
import { hashObject, sha256Hex } from '../core/src/canonical.js';
import { demoWalletSign } from '../core/src/creator.js';
import { reviewedManifestHash, submissionMessage } from '../core/src/review.js';
import { base64 } from '../core/src/seal.js';
const BASE = process.env.SRS_URL ?? 'http://127.0.0.1:8080';
const api = async (p: string, body?: unknown) => { const r = await fetch(BASE + p, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const t = await r.text(); if (!r.ok) throw new Error(`${p} → ${r.status} ${t}`); return JSON.parse(t); };
const author = 'sealedrecipes.testnet';
const VERSION = process.env.PART_VERSION ?? '1.0.0';
const manifest = {
  id: `report.audit@${VERSION}`, name: 'Account Audit Report', category: 'sink', author,
  summary: "Combines an account's key risks and token flags into one security audit: severity, value at risk and the fixes the owner makes in their own wallet.",
  inputs: { ...(VERSION === '1.0.0' ? {} : { account: { type: 'near.account' } }), keys: { type: 'key.list' }, holdings: { type: 'token.holdings' }, flags: { type: 'token.flags' } },
  outputs: { report: { type: 'report' } }, params: {}, capabilities: [], fee_per_call: '10000',
  disclosure: { model: { kind: 'none' }, instructions: 'open', harness: 'open', verification: 'open', runtime: 'bundled' },
  limits: { max_ms: 1000, max_http_calls: 0, max_model_calls: 0, max_output_bytes: 16000 },
};
const source = readFileSync(process.argv[2], 'utf8').replace(/\r\n/g, '\n');
console.log(await api('/api/chain/tx', { signer: author, method: 'register_part', args: { id: manifest.id, version: VERSION, fee_per_call: manifest.fee_per_call, manifest_hash: hashObject(manifest) } }).then(() => 'registered on the local contract'));
const signature = base64.enc(demoWalletSign(author, submissionMessage(manifest.id, reviewedManifestHash(manifest as never), sha256Hex(source), author)));
const s = await api('/api/parts/submissions', { manifest, source, signature });
console.log('submitted', s.id, s.tier);
for (let i = 0; i < 60; i++) {
  const list = await api('/api/parts/submissions');
  const x = (Array.isArray(list) ? list : list.submissions).find((y: { id: string }) => y.id === s.id);
  if (x && x.status !== 'checking') { console.log('status:', x.status); if (x.status !== 'approved') { console.log(JSON.stringify(x.checks ?? x, null, 1).slice(0, 3000)); process.exit(1); } process.exit(0); }
  await new Promise((r) => setTimeout(r, 1000));
}
console.log('timeout'); process.exit(1);
