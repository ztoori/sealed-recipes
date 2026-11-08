/**
 * Admission at start (SRS-1 §11). The runner reads the release log (standard/reviews.json) and the appointed reviewer
 * set (standard/reviewers.json), both covered by its attested code hash, and checks every catalog part against them:
 * the manifest and the code must be exactly what was admitted, under the rule for the part's tier (automated checks
 * for open parts; one or two signed approvals from appointed reviewers, never the author, for the others).
 * A part that fails is refused: recipes that use it fail before anything runs, and the buyer is refunded.
 * Open-tier parts admitted on automated checks alone are compiled for the sandbox here; they never load in-process.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sha256Hex } from '../../core/src/canonical.js';
import { verifyRecord, type ReleaseLog, type ReleaseRecord, type ReviewerSet } from '../../core/src/review.js';
import type { Catalog } from '../../core/src/srs.js';
import type { PartHandler } from './types.js';
import { SANDBOXED } from './parts/registry.js';
import { compilePart, exportNameOf, runSandboxed, stageCompiled } from './sandbox.js';

export interface Admission { release: number; admitted: Map<string, ReleaseRecord>; refused: Map<string, string>; sandboxed: Map<string, PartHandler> }

export const sourceSha = (root: string, path: string) => sha256Hex(readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n'));

export function readReleaseLog(root: string): { log: ReleaseLog; reviewers: ReviewerSet } {
  const read = <T>(p: string, fallback: T): T => (existsSync(resolve(root, p)) ? JSON.parse(readFileSync(resolve(root, p), 'utf8')) as T : fallback);
  return {
    log: read<ReleaseLog>('standard/reviews.json', { srs: '1.0', kind: 'release-log', release: 0, records: [] }),
    reviewers: read<ReviewerSet>('standard/reviewers.json', { owner: '', reviewers: [] }),
  };
}

/** A PartHandler that runs the part in a fresh sandboxed process, through the runner's guarded, counted ctx. */
export function sandboxedHandler(file: string, exportName: string): PartHandler {
  return (inputs, ctx) => runSandboxed(
    { file, exportName, inputs, maxMs: ctx.manifest.limits?.max_ms ?? 10_000,
      ctx: { nodeId: ctx.nodeId, manifest: ctx.manifest, params: ctx.params, mode: ctx.mode, endpoints: ctx.endpoints, resumeState: ctx.resumeState, priorApproval: ctx.priorApproval } },
    { http: ctx.http, requestApproval: ctx.requestApproval, saveState: ctx.saveState, log: ctx.log, wait: ctx.wait },
  );
}

export async function admitParts(root: string, catalog: Catalog): Promise<Admission> {
  const { log, reviewers } = readReleaseLog(root);
  const admitted = new Map<string, ReleaseRecord>(), refused = new Map<string, string>(), sandboxed = new Map<string, PartHandler>();
  for (const m of catalog.parts) {
    const rec = log.records.find((r) => r.part === m.id);
    let problem: string | null;
    try { problem = m.implementation ? verifyRecord(rec, m, sourceSha(root, m.implementation), reviewers) : 'no implementation file'; } catch (e) { problem = (e as Error).message; }
    if (problem) { refused.set(m.id, problem); continue; }
    if (rec!.basis === 'automated') {
      const entry = SANDBOXED[m.id];
      const src = readFileSync(resolve(root, m.implementation!), 'utf8');
      const name = entry?.exportName ?? exportNameOf(src);
      if (!name) { refused.set(m.id, 'no exported PartHandler'); continue; }
      try { sandboxed.set(m.id, sandboxedHandler(stageCompiled(await compilePart(src)), name)); } catch (e) { refused.set(m.id, 'does not compile for the sandbox: ' + (e as Error).message); continue; }
    }
    admitted.set(m.id, rec!);
  }
  return { release: log.release, admitted, refused, sandboxed };
}
