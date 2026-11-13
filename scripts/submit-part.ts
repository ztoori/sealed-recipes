// Submit any part through the standard admission flow on a local marketplace (SRS_URL, default http://127.0.0.1:8080):
// register the manifest on the local contract, submit manifest + source signed by the author (demo wallet), wait for
// the automated checks. An open-tier part is approved by passing them; `npm run release:parts -- --yes` releases it.
//   npx tsx scripts/submit-part.ts <manifest.json> <source.ts>
import { readFileSync } from 'node:fs';
import { hashObject, sha256Hex } from '../core/src/canonical.js';
import { demoWalletSign } from '../core/src/creator.js';
import { reviewedManifestHash, submissionMessage } from '../core/src/review.js';
import { base64 } from '../core/src/seal.js';
const BASE = process.env.SRS_URL ?? 'http://127.0.0.1:8080';
const api = async (p: string, body?: unknown) => { const r = await fetch(BASE + p, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const t = await r.text(); if (!r.ok) throw new Error(`${p} → ${r.status} ${t}`); return JSON.parse(t); };
const [manifestPath, sourcePath] = process.argv.slice(2);
if (!manifestPath || !sourcePath) { console.error('usage: tsx scripts/submit-part.ts <manifest.json> <source.ts>'); process.exit(2); }
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const source = readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n');
const author: string = manifest.author;
const version = manifest.id.split('@')[1];
await api('/api/chain/tx', { signer: author, method: 'register_part', args: { id: manifest.id, version, fee_per_call: manifest.fee_per_call, manifest_hash: hashObject(manifest) } });
console.log(`registered ${manifest.id} on the local contract`);
const signature = base64.enc(demoWalletSign(author, submissionMessage(manifest.id, reviewedManifestHash(manifest), sha256Hex(source), author)));
const s = await api('/api/parts/submissions', { manifest, source, signature });
console.log('submitted', s.id, s.tier);
for (let i = 0; i < 90; i++) {
  const list = await api('/api/parts/submissions');
  const x = (Array.isArray(list) ? list : list.submissions).find((y: { id: string }) => y.id === s.id);
  if (x && x.status !== 'checking') {
    console.log('status:', x.status);
    if (x.status !== 'approved') {
      const c = (await api(`/api/parts/submissions/${s.id}`)).checks ?? {};
      for (const d of [...(c.manifest ?? []), ...(c.lint ?? []), ...(c.scan ?? [])]) console.log(`  ${d.severity} ${d.code}: ${d.message}`);
      for (const n of c.notes ?? []) console.log('  note:', n);
      for (const b of c.behaviour ?? []) console.log(`  ${b.mode}: ${b.ok ? 'ok' : 'failed'} ${b.ms} ms${b.error ? ' error: ' + b.error : ''}${b.violations?.length ? ' violations: ' + b.violations.join('; ') : ''} outputs: ${JSON.stringify(b.outputs)}`);
      process.exit(1);
    }
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 1000));
}
console.log('timeout'); process.exit(1);
