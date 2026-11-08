/**
 * Part admission on the marketplace (SRS-1 §11): signed submissions, automated checks, and approvals by the
 * owner-appointed reviewers, by tier. The marketplace only prepares a release: `npm run release:parts` (an owner
 * action) writes admitted parts and their records into the repo, and the runner verifies those records at start.
 *
 *   open      automated checks pass → approved, no human review
 *   reviewed  automated checks pass → 1 appointed reviewer approves
 *   signing   automated checks pass → 2 independent appointed reviewers approve
 *   any reviewer rejecting → changes requested; the author submits a new version
 */
import type express from 'express';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hashObject, sha256Hex } from '../../core/src/canonical.js';
import { validatePartManifest, lintPartSource } from '../../core/src/partkit.js';
import {
  checklistFor, partTier, reviewedManifestHash, reviewMessage, securityScan, shapeProblem, submissionMessage, TIER_INFO, TYPE_SAMPLES, KNOWN_HOSTS, verifySignature,
  type ReviewerSet, type Tier,
} from '../../core/src/review.js';
import type { Catalog, Diagnostic, PartManifest } from '../../core/src/srs.js';
import { guardedFetch } from '../../runner/src/executor.js';
import { compilePart, exportNameOf, runSandboxed, stageCompiled } from '../../runner/src/sandbox.js';
import { readReleaseLog } from '../../runner/src/admission.js';
import { REAL_ENDPOINTS } from '../../runner/src/executor.js';
import type { ApprovalRequest } from '../../runner/src/types.js';
import bs58 from 'bs58';

export type Status = 'checking' | 'failed_checks' | 'in_review' | 'approved' | 'changes_requested' | 'released';
export interface Review { reviewer: string; verdict: 'approve' | 'reject'; checklist: string[]; notes: string; at: string; signature: string }
export interface BehaviourRun { mode: 'quote' | 'run'; ok: boolean; error?: string; ms: number; hosts: string[]; violations: string[]; approvals: ApprovalRequest[]; saves: number; logs: string[]; outputs: Record<string, string> }
export interface CheckReport { passed: boolean; manifest: Diagnostic[]; lint: Diagnostic[]; scan: Diagnostic[]; facts: ReturnType<typeof securityScan>['facts']; behaviour: BehaviourRun[]; notes: string[] }
export interface Submission {
  id: string; part: string; author: string; manifest: PartManifest; source: string;
  manifest_hash: string; source_sha256: string; tier: Tier; tier_reasons: string[];
  submitted_at: string; signature: string; status: Status;
  checks?: CheckReport; checks_hash?: string; reviews: Review[]; released_at?: string;
}

export class ReviewError extends Error {}

/** Submissions live in one JSON file the release script also reads. Re-read on every request so both stay in step. */
export class SubmissionStore {
  constructor(readonly dir: string) { mkdirSync(dir, { recursive: true }); }
  private get path() { return resolve(this.dir, 'submissions.json'); }
  all(): Submission[] { return existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) as Submission[] : []; }
  save(list: Submission[]) { const tmp = `${this.path}.${randomBytes(4).toString('hex')}.tmp`; writeFileSync(tmp, JSON.stringify(list, null, 1)); renameSync(tmp, this.path); }
  update(id: string, fn: (s: Submission) => void) { const list = this.all(); const s = list.find((x) => x.id === id); if (!s) throw new ReviewError('unknown submission'); fn(s); this.save(list); return s; }
}

const paramSample = (type: string, def: unknown) => def ?? (type === 'number' ? 0 : type === 'string[]' ? [] : type === 'boolean' ? false : '');

/**
 * The automated checks every submission gets, whatever its tier: SRS-1 manifest conformance, the static source checks,
 * the security scan, and a behaviour test in the sandbox, once as a quote (dry run) and once as a run. The behaviour
 * test feeds sample values for each input type, answers the part's HTTP calls from the local mocks of the declared
 * hosts only, declines every wallet request, and records what the part tried to do.
 */
export async function runChecks(m: PartManifest, source: string, catalog: Catalog, rewrites: Map<string, string>): Promise<CheckReport> {
  const manifest = validatePartManifest(m, catalog, { isNew: true });
  const lint = lintPartSource(source, m);
  const { diagnostics: scan, facts } = securityScan(source, m);
  const notes: string[] = [];
  const behaviour: BehaviourRun[] = [];
  const staticErrors = [...manifest, ...lint, ...scan].some((d) => d.severity === 'error');
  if (staticErrors) notes.push('Behaviour test skipped: fix the static errors first.');
  else {
    let file = '', exportName = exportNameOf(source) ?? '';
    try { file = stageCompiled(await compilePart(source)); } catch (e) { notes.push('Does not compile for the sandbox: ' + (e as Error).message); }
    if (file && exportName) {
      const inputs = Object.fromEntries(Object.entries(m.inputs).map(([p, s]) => [p, TYPE_SAMPLES[s.type] ?? null]));
      const params = Object.fromEntries(Object.entries(m.params).map(([k, s]) => [k, paramSample(s.type, s.default)]));
      for (const mode of ['quote', 'run'] as const) {
        const r: BehaviourRun = { mode, ok: false, ms: 0, hosts: [], violations: [], approvals: [], saves: 0, logs: [], outputs: {} };
        const guarded = guardedFetch(m.id, m.capabilities, rewrites);
        const t0 = Date.now();
        try {
          const out = await runSandboxed(
            { file, exportName, inputs, maxMs: m.limits?.max_ms ?? 10_000, ctx: { nodeId: 'review', manifest: m, params, mode, endpoints: REAL_ENDPOINTS } },
            {
              http: async (url, init) => {
                const host = new URL(url).host;
                if (!r.hosts.includes(host)) r.hosts.push(host);
                try { return await guarded(url, init); } catch (e) { r.violations.push((e as Error).message); throw e; }
              },
              requestApproval: async (req) => {
                r.approvals.push(req);
                if (mode === 'quote') r.violations.push('asked the buyer to sign during a quote (quotes must be read-only)');
                return { approved: false, txHashes: [] };
              },
              saveState: async () => { r.saves++; if (mode === 'quote') r.violations.push('saved state during a quote'); },
              log: (msg) => { if (r.logs.length < 40) r.logs.push(msg); },
              wait: async () => {},
            },
          );
          r.ok = true;
          for (const [p, s] of Object.entries(m.outputs)) { const problem = shapeProblem(s.type, out[p]); r.outputs[p] = problem ?? 'ok'; }
          for (const p of Object.keys(out)) if (!m.outputs[p]) r.outputs[p] = 'not declared';
        } catch (e) { r.error = (e as Error).message; }
        r.ms = Date.now() - t0;
        behaviour.push(r);
      }
    } else if (file) notes.push('No `export const <name>: PartHandler` found.');
  }
  const behaviourErrors = behaviour.some((b) => b.violations.length || /exceeded max_ms|sandbox exited/.test(b.error ?? '') || Object.values(b.outputs).some((v) => v !== 'ok'));
  const passed = !staticErrors && behaviour.length === 2 && !behaviourErrors;
  return { passed, manifest, lint, scan, facts, behaviour, notes };
}

export interface ReviewDeps {
  root: string; catalog: Catalog; port: number; store: SubmissionStore;
  onchainManifestHash: (id: string) => string | undefined;
  demoPublicKey: (account: string) => Uint8Array;
}

export function mountReview(app: express.Express, deps: ReviewDeps, guard: (fn: (req: express.Request, res: express.Response) => unknown) => express.RequestHandler, j: (res: express.Response, v: unknown) => void) {
  const { reviewers, log } = (() => { const r = readReleaseLog(deps.root); return { reviewers: r.reviewers as ReviewerSet, log: r.log }; })();
  const base = `http://127.0.0.1:${deps.port}/mock`;
  // the behaviour test talks to the local mocks of the known hosts; any other host fails, which the report shows
  const rewrites = new Map([
    ['api.fastnear.com', `${base}/fastnear`], ['rpc.mainnet.fastnear.com', `${base}/rpc`], ['1click.chaindefuser.com', `${base}/1click`],
    ['cloud-api.near.ai', `${base}/nearai`], ['solver-relay-v2.chaindefuser.com', `${base}/solver-relay`],
  ]);
  const summary = (s: Submission) => ({ id: s.id, part: s.part, name: s.manifest.name, author: s.author, tier: s.tier, status: s.status, submitted_at: s.submitted_at, passed: s.checks?.passed ?? null,
    approvals: s.reviews.filter((r) => r.verdict === 'approve').length, needed: TIER_INFO[s.tier].approvals, released_at: s.released_at });

  /** what anyone can check: tiers, known hosts, the appointed reviewers and the current release log */
  app.get('/api/parts/admission', (_, res) => j(res, { tiers: TIER_INFO, known_hosts: KNOWN_HOSTS, reviewers, release: log.release, records: log.records }));

  app.get('/api/parts/submissions', (_, res) => j(res, deps.store.all().slice().reverse().map(summary)));
  app.get('/api/parts/submissions/:id', guard((req, res) => {
    const s = deps.store.all().find((x) => x.id === req.params.id);
    if (!s) throw new ReviewError('unknown submission');
    // the version this one replaces, if any, so reviewers read a diff instead of the whole file
    const name = s.part.split('@')[0];
    const prev = [...deps.catalog.parts].reverse().find((p) => p.id.split('@')[0] === name && p.id !== s.part && p.implementation);
    const previous = prev ? { id: prev.id, source: readFileSync(resolve(deps.root, prev.implementation!), 'utf8') } : null;
    j(res, { ...s, checklist: checklistFor(s.manifest), needed: TIER_INFO[s.tier].approvals, previous, reviewers: reviewers.reviewers.map((r) => r.account) });
  }));

  /** an author submits manifest + source, signed by their wallet; the manifest must already be registered on-chain */
  app.post('/api/parts/submissions', guard(async (req, res) => {
    const { manifest, source, signature } = req.body as { manifest: PartManifest; source: string; signature: string };
    if (!manifest?.id || typeof source !== 'string' || source.length > 200_000) throw new ReviewError('expected a manifest and its source');
    const author = manifest.author;
    const manifest_hash = reviewedManifestHash(manifest), source_sha256 = sha256Hex(source.replace(/\r\n/g, '\n'));
    if (!verifySignature(submissionMessage(manifest.id, manifest_hash, source_sha256, author), signature, 'ed25519:' + bs58.encode(deps.demoPublicKey(author)))) throw new ReviewError(`not signed by ${author}`);
    if (deps.catalog.parts.some((p) => p.id === manifest.id)) throw new ReviewError(`${manifest.id} is already released: bump the version`);
    if (deps.onchainManifestHash(manifest.id) !== hashObject(manifest)) throw new ReviewError('register this exact manifest on-chain first (step 1)');
    const list = deps.store.all();
    if (list.some((x) => x.part === manifest.id && ['checking', 'in_review', 'approved'].includes(x.status))) throw new ReviewError(`${manifest.id} already has a submission in progress`);
    const { tier, reasons } = partTier(manifest);
    const s: Submission = { id: sha256Hex(`${manifest_hash}|${source_sha256}|${Date.now()}`).slice(0, 12), part: manifest.id, author, manifest, source, manifest_hash, source_sha256,
      tier, tier_reasons: reasons, submitted_at: new Date().toISOString(), signature, status: 'checking', reviews: [] };
    deps.store.save([...list, s]);
    j(res, summary(s));
    // checks run after the response; the queue shows "checking" until they finish
    try {
      const report = await runChecks(manifest, source, deps.catalog, rewrites);
      deps.store.update(s.id, (x) => {
        x.checks = report; x.checks_hash = sha256Hex(JSON.stringify(report));
        x.status = !report.passed ? 'failed_checks' : tier === 'open' ? 'approved' : 'in_review';
      });
    } catch (e) { deps.store.update(s.id, (x) => { x.status = 'failed_checks'; x.checks = { passed: false, manifest: [], lint: [], scan: [], facts: { imports: [], hostsInCode: [], receivers: [], methods: [] }, behaviour: [], notes: ['Checks crashed: ' + (e as Error).message] }; }); }
  }));

  /** an appointed reviewer approves (every checklist item confirmed) or requests changes, signed by their wallet */
  app.post('/api/parts/submissions/:id/review', guard((req, res) => {
    const { reviewer, verdict, checklist, notes, signature } = req.body as { reviewer: string; verdict: 'approve' | 'reject'; checklist: string[]; notes?: string; signature: string };
    const r = reviewers.reviewers.find((x) => x.account === reviewer);
    const s = deps.store.update(String(req.params.id), (x) => {
      if (!r) throw new ReviewError(`${reviewer} is not an appointed reviewer`);
      if (x.status !== 'in_review') throw new ReviewError(`this submission is ${x.status.replace('_', ' ')}, not in review`);
      if (reviewer === x.author) throw new ReviewError('authors cannot review their own parts');
      if (x.reviews.some((v) => v.reviewer === reviewer)) throw new ReviewError(`${reviewer} already reviewed this submission`);
      if (verdict !== 'approve' && verdict !== 'reject') throw new ReviewError('verdict must be approve or reject');
      const items = checklistFor(x.manifest).map((c) => c.id);
      if (verdict === 'approve' && !items.every((i) => checklist?.includes(i))) throw new ReviewError('confirm every checklist item to approve');
      if (verdict === 'reject' && !notes?.trim()) throw new ReviewError('say what has to change');
      if (!verifySignature(reviewMessage(x.id, x.part, x.manifest_hash, x.source_sha256, reviewer, verdict, checklist ?? []), signature, r.public_key)) throw new ReviewError(`not signed by ${reviewer}`);
      x.reviews.push({ reviewer, verdict, checklist: checklist ?? [], notes: notes ?? '', at: new Date().toISOString(), signature });
      if (verdict === 'reject') x.status = 'changes_requested';
      else if (x.reviews.filter((v) => v.verdict === 'approve').length >= TIER_INFO[x.tier].approvals) x.status = 'approved';
    });
    j(res, summary(s));
  }));
}
