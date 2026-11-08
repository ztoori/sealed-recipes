/**
 * Deterministic hash of the runner's source bundle (Node only).
 * The runner reports it in its attestation; the contract stores the audited value
 * when the owner registers the runner. Edit any runner/core file and the hash changes,
 * so the UI's attestation check turns red — try it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { sha256Hex } from './canonical.js';

export const CODEHASH_ROOTS = ['runner/src', 'core/src', 'standard/parts.json'];

function walk(p: string, out: string[]) {
  const st = statSync(p);
  if (st.isFile()) { out.push(p); return; }
  for (const e of readdirSync(p).sort()) walk(join(p, e), out);
}

export function computeCodehash(repoRoot: string): { codehash: string; files: { path: string; sha256: string }[] } {
  const files: string[] = [];
  for (const r of CODEHASH_ROOTS) walk(join(repoRoot, r), files);
  const entries = files
    .map((f) => ({ path: relative(repoRoot, f).split(sep).join('/'), sha256: sha256Hex(readFileSync(f, 'utf8').replace(/\r\n/g, '\n')) }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  return { codehash: sha256Hex(entries.map((e) => `${e.sha256}  ${e.path}`).join('\n')), files: entries };
}

/** SRS-1 catalog: types and parts (Node only). */
export function loadCatalog(repoRoot: string): import('./srs.js').Catalog {
  return JSON.parse(readFileSync(join(repoRoot, 'standard/parts.json'), 'utf8'));
}
