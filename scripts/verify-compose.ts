// Which image is the runner running? Checks a saved runner attestation the way the live page does (web/src/compose.ts):
// RTMR3 event digests, RTMR3 replay against the quote, compose hash = sha256(app-compose.json), and the measured
// docker-compose against runner/docker-compose.yml. RTMR3 is read from the quote here; the live page takes it from the
// quote after Intel's signature chain verified it (scripts/verify-quote.ts does that check).
//   curl -s "https://sealedrecipes.xyz/runner/attestation?nonce=$(openssl rand -hex 16)" > att.json
//   npx tsx scripts/verify-compose.ts att.json
import { readFileSync } from 'node:fs';
import { checkCompose } from '../web/src/compose.js';

const att = JSON.parse(readFileSync(process.argv[2] ?? 'att.json', 'utf8'));
if (!att.quote) { console.error('no TDX quote in this attestation (local-dev runner?)'); process.exit(1); }
const q = Buffer.from(String(att.quote).replace(/^0x/, ''), 'hex');
const rtmr3 = q.subarray(48 + 472, 48 + 520).toString('hex'); // TD report body: RTMR3 sits just before REPORTDATA (offset 520)
const pinned = readFileSync(new URL('../runner/docker-compose.yml', import.meta.url), 'utf8');
const r = await checkCompose(att, rtmr3, pinned);
console.log(JSON.stringify({ rtmr3, ...r }, null, 2));
if (!r.ok && att.event_log) {
  const log = (JSON.parse(att.event_log) as { imr: number; event_type: number; event: string; event_payload: string; digest: string }[]).filter((e) => e.imr === 3);
  console.log('RTMR3 events:'); for (const e of log) console.log(`  ${e.event_type.toString(16)} ${e.event} payload=${e.event_payload.slice(0, 80)} digest=${e.digest.slice(0, 16)}…`);
}
process.exit(r.ok ? 0 : 1);
