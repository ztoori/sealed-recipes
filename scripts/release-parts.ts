/**
 * Owner action: cut a runner release from the approved submissions (SRS-1 §11).
 *   npm run release:parts            # dry run: lists what would be released
 *   npm run release:parts -- --yes   # writes the release
 *
 * For each approved submission it:
 *   1. writes the source to runner/src/parts/<namespace>-<name>.ts and the manifest (with that path) to standard/parts.json;
 *   2. adds the handler to runner/src/parts/registry.ts: in HANDLERS for reviewed and signing parts, in SANDBOXED for
 *      open parts (those never load in the runner's own process);
 *   3. appends a release record to standard/reviews.json: hashes, tier, the automated checks' hash and the signed approvals;
 *   4. pins the new code hash in AUDITED_CODEHASH. The release log is inside the code hash, so a buyer who checks the
 *      runner's attestation also checks who admitted every part.
 * Then restart the runner (or deploy the new image) so it attests the new release.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeCodehash } from '../core/src/codehash.js';
import { exportNameOf } from '../runner/src/sandbox.js';
import { verifyRecord, type ReleaseLog, type ReleaseRecord, type ReviewerSet } from '../core/src/review.js';
import { sha256Hex } from '../core/src/canonical.js';
import { SubmissionStore } from '../server/src/review.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const write = process.argv.includes('--yes');
const store = new SubmissionStore(process.env.SRS_REVIEW_DIR ?? resolve(root, '.data/reviews'));
const approved = store.all().filter((s) => s.status === 'approved');
if (!approved.length) { console.log('[release] no approved submissions'); process.exit(0); }

const partsPath = resolve(root, 'standard/parts.json'), logPath = resolve(root, 'standard/reviews.json'), regPath = resolve(root, 'runner/src/parts/registry.ts');
const catalog = JSON.parse(readFileSync(partsPath, 'utf8'));
const log = JSON.parse(readFileSync(logPath, 'utf8')) as ReleaseLog;
const reviewers = JSON.parse(readFileSync(resolve(root, 'standard/reviewers.json'), 'utf8')) as ReviewerSet;
let registry = readFileSync(regPath, 'utf8');
const release = log.release + 1;
const today = new Date().toISOString().slice(0, 10);

for (const s of approved) {
  const file = `runner/src/parts/${s.part.split('@')[0].replace(/[^a-z0-9]+/g, '-')}.ts`;
  const name = exportNameOf(s.source);
  if (!name) throw new Error(`${s.part}: no exported PartHandler`);
  const manifest = { ...s.manifest, implementation: file };
  const rec: ReleaseRecord = {
    part: s.part, tier: s.tier, author: s.author, implementation: file,
    manifest_hash: s.manifest_hash, source_sha256: sha256Hex(s.source.replace(/\r\n/g, '\n')),
    basis: s.tier === 'open' ? 'automated' : 'review', submission: s.id, checks_hash: s.checks_hash,
    approvals: s.reviews.filter((r) => r.verdict === 'approve').map((r) => ({ reviewer: r.reviewer, checklist: r.checklist, notes: r.notes, at: r.at, signature: r.signature })),
    released_at: today,
  };
  // the record must admit the part exactly as it ships: check it the way the runner will
  const problem = rec.basis === 'automated' ? (s.checks?.passed ? null : 'automated checks did not pass') : verifyRecord(rec, manifest, rec.source_sha256, reviewers);
  if (problem) throw new Error(`${s.part}: ${problem}`);
  console.log(`[release] ${s.part} (${s.tier}, ${rec.basis === 'automated' ? 'automated checks' : `${rec.approvals.length} approval(s)`}) → ${file}`);
  if (!write) continue;
  writeFileSync(resolve(root, file), s.source);
  catalog.parts.push(manifest);
  if (s.tier === 'open') registry = registry.replace('  // <release:sandboxed>', `  '${s.part}': { file: '${file}', exportName: '${name}' },\n  // <release:sandboxed>`);
  else registry = registry
    .replace('// <release:imports>', `import { ${name} as ${name}_r${release} } from './${file.split('/').pop()!.replace(/\.ts$/, '.js')}';\n// <release:imports>`)
    .replace('  // <release:handlers>', `  '${s.part}': ${name}_r${release},\n  // <release:handlers>`);
  log.records.push(rec);
  store.update(s.id, (x) => { x.status = 'released'; x.released_at = today; });
}
if (!write) { console.log('[release] dry run: add --yes to write the release'); process.exit(0); }
log.release = release;
writeFileSync(partsPath, JSON.stringify(catalog, null, 2) + '\n');
writeFileSync(logPath, JSON.stringify(log, null, 2) + '\n');
writeFileSync(regPath, registry);
const { codehash } = computeCodehash(root);
writeFileSync(resolve(root, 'AUDITED_CODEHASH'), codehash + '\n');
console.log(`[release] release ${release} pinned: ${codehash}\n[release] restart the runner (npm run demo) so it attests this release`);
