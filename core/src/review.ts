/**
 * Admission of parts (SRS-1 §11). A part is code other people's recipes run on buyers' wallets, so how much it must
 * prove before it runs depends on what it can do:
 *
 *   open     pure, or reads only public NEAR data from the known hosts. Automated checks only; it then runs in the
 *            runner's sandbox (its own process: no file system, no processes, no network except ctx.http to its
 *            declared hosts). Admission is permissionless.
 *   reviewed sends buyer data somewhere new: an AI model, a remote service, or a host outside the known NEAR data
 *            hosts. Automated checks plus one appointed reviewer.
 *   signing  asks the buyer to sign transactions (wallet:approve). Automated checks plus two independent appointed
 *            reviewers: no sandbox can tell whether a transaction is the one the buyer meant to sign.
 *
 * The same functions run in the browser (the part builder and the review queue), on the marketplace (automated
 * checks) and in the runner (it refuses any part whose release record does not verify).
 */
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { hashObject } from './canonical.js';
import { base64 } from './seal.js';
import type { Diagnostic, PartManifest } from './srs.js';

export type Tier = 'open' | 'reviewed' | 'signing';

/** Hosts that serve public NEAR chain data and swap quotes. What a part sends there is already public. */
export const KNOWN_HOSTS = ['api.fastnear.com', 'rpc.mainnet.fastnear.com', '1click.chaindefuser.com'];

export const TIER_INFO: Record<Tier, { label: string; approvals: number; short: string; why: string; runs: string }> = {
  open: {
    label: 'Open', approvals: 0, short: 'automated checks only',
    why: 'Pure, or reads only public NEAR data from the known hosts.',
    runs: 'Admitted without human review once the automated checks pass. Runs in the sandbox: its own process, no file system, no processes, no network except its declared hosts.',
  },
  reviewed: {
    label: 'Reviewed', approvals: 1, short: '1 appointed reviewer',
    why: 'Sends buyer data somewhere new: an AI model, a remote service or a host outside the known NEAR data hosts.',
    runs: 'Automated checks plus one appointed reviewer, who checks that every host is needed and only the data it needs goes there.',
  },
  signing: {
    label: 'Signing', approvals: 2, short: '2 independent reviewers',
    why: 'Asks the buyer to sign transactions.',
    runs: 'Automated checks plus two independent appointed reviewers. No sandbox can tell whether a transaction is the one the buyer meant to sign, so people check it.',
  },
};

/** The tier a manifest falls in, and why. */
export function partTier(m: PartManifest): { tier: Tier; reasons: string[] } {
  const caps = m.capabilities ?? [];
  const hosts = caps.filter((c) => c.startsWith('net:')).map((c) => c.slice(4));
  if (caps.includes('wallet:approve')) return { tier: 'signing', reasons: ['asks the buyer to sign transactions (wallet:approve)'] };
  const reasons: string[] = [];
  if (m.disclosure?.model?.kind && m.disclosure.model.kind !== 'none') reasons.push(`calls an AI model (${m.disclosure.model.name ?? m.disclosure.model.kind})`);
  if (m.disclosure?.runtime === 'remote') reasons.push('runs as a remote service');
  const unknown = hosts.filter((h) => !KNOWN_HOSTS.includes(h));
  if (unknown.length) reasons.push(`reaches hosts outside the known NEAR data hosts: ${unknown.join(', ')}`);
  if (reasons.length) return { tier: 'reviewed', reasons };
  return { tier: 'open', reasons: [hosts.length ? `reads only public NEAR data (${hosts.join(', ')})` : 'pure: no network'] };
}

export interface ChecklistItem { id: string; label: string }
/** What a human reviewer confirms, by what the part can do. Open parts have no checklist: nobody signs off on them. */
export function checklistFor(m: PartManifest): ChecklistItem[] {
  const { tier } = partTier(m);
  if (tier === 'open') return [];
  const items: ChecklistItem[] = [
    { id: 'purpose', label: 'It does what its summary says, and nothing more' },
    { id: 'hosts', label: 'Every declared host is needed, and only the data it needs is sent there' },
    { id: 'hidden', label: 'No hidden behaviour: obfuscation, time bombs, special-cased accounts or amounts' },
  ];
  if (m.disclosure?.model?.kind && m.disclosure.model.kind !== 'none') items.push({ id: 'model', label: 'Model output is checked before it is used, and cannot steer the part into unsafe results' });
  if (tier === 'signing') {
    items.push({ id: 'tx', label: 'Every transaction it asks the buyer to sign matches what the buyer is shown: receivers, methods, amounts' });
    items.push({ id: 'quote', label: 'Quote mode is read-only, and the part saves state before every irreversible step' });
  }
  return items;
}

// ------------------------------------------------------------------ security scan (stricter than lintPartSource)

/** Modules a part may import. Everything else (fs, net, http, child_process, worker_threads, vm, npm packages) is refused. */
export const ALLOWED_IMPORTS = [
  '../types.js', './near-rpc.js', './nearai-verified.js',
  '../../../core/src/attestation.js', '../../../core/src/nearai.js', '../../../core/src/nep413.js',
  '../../../core/src/oneclick.js', '../../../core/src/seal.js', '../../../core/src/canonical.js',
  'node:crypto',
];

export interface ScanFacts { imports: string[]; hostsInCode: string[]; receivers: string[]; methods: string[] }

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * Static security checks on a part's source. They look for the ways code escapes its contract: other modules,
 * ambient authority (process, globals), code generation, prototype tricks, hidden strings and hosts it never
 * declared. They are a filter, not a proof: the sandbox and, for higher tiers, people do the rest.
 */
export function securityScan(src: string, m: PartManifest): { diagnostics: Diagnostic[]; facts: ScanFacts } {
  const d: Diagnostic[] = [];
  const err = (code: string, message: string) => d.push({ severity: 'error', code, message });
  const warn = (code: string, message: string) => d.push({ severity: 'warning', code, message });
  const code = stripComments(src);
  const imports = [...code.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"\n;]*?from\s*['"]([^'"]+)['"]/g), ...code.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)].map((x) => x[1]);
  for (const i of new Set(imports)) if (!ALLOWED_IMPORTS.includes(i)) err('import', `imports "${i}": parts may only import ${ALLOWED_IMPORTS.filter((x) => !x.startsWith('node:')).length} runner helpers and node:crypto`);
  const rules: [RegExp, string, string][] = [
    [/\bimport\s*\(/, 'dynamic-import', 'dynamic import() loads code the review never saw'],
    [/\brequire\s*\(|\bmodule\.exports\b/, 'require', 'require() is not available to parts'],
    [/\bprocess\b/, 'process', 'parts may not touch process (environment, exit, native bindings)'],
    [/\bglobalThis\b|(^|[^\w.])global\s*[.[]|\bwindow\b/, 'globals', 'parts may not reach the global object'],
    [/\beval\s*\(|new\s+Function\b|(^|[^\w.])Function\s*\(/, 'codegen', 'code generated from strings cannot be reviewed'],
    [/\.constructor\b|\[\s*['"`]constructor['"`]\s*\]|__proto__|\bReflect\b|\bProxy\b|\bObject\.(setPrototypeOf|defineProperty)\b/, 'prototype', 'prototype and reflection tricks can escape the part interface'],
    [/\bWebAssembly\b|\bSharedArrayBuffer\b|\bAtomics\b|\bWorker\b/, 'native', 'WebAssembly, workers and shared memory are not available to parts'],
    [/(^|[^\w.])(fetch|XMLHttpRequest|WebSocket|EventSource)\b/, 'network', 'network access goes through ctx.http only'],
    [/\batob\b|\bfromCharCode\b|\bfromCodePoint\b/, 'obfuscation', 'decoding text at run time hides what the code does'],
    [/(\\x[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}|\\u\{[0-9a-fA-F]+\}){3,}/, 'obfuscation', 'escaped strings hide what the code does'],
  ];
  for (const [re, c, msg] of rules) if (re.test(code)) err(c, msg);
  if (/['"`][A-Za-z0-9+/=]{120,}['"`]/.test(code)) warn('encoded', 'a long encoded string: a reviewer should decode it');
  if (/Buffer\.from\([^)]*['"](base64|hex)['"]\s*\)/.test(code)) warn('decode', 'decodes base64 or hex at run time: check what');
  const declared = new Set((m.capabilities ?? []).filter((c) => c.startsWith('net:')).map((c) => c.slice(4)));
  const hostsInCode = [...new Set([...code.matchAll(/\b(?:https?|wss?):\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map((x) => x[1].toLowerCase()))];
  for (const h of hostsInCode) if (!declared.has(h)) err('host', `the code names ${h}, which the manifest does not declare`);
  const receivers = [...new Set([...code.matchAll(/receiverId\s*:\s*([^,}\n]+)/g)].map((x) => x[1].trim()))];
  const methods = [...new Set([...code.matchAll(/methodName\s*:\s*([^,}\n]+)/g)].map((x) => x[1].trim()))];
  if ((receivers.length || methods.length) && !(m.capabilities ?? []).includes('wallet:approve')) err('tx', 'builds transactions but does not declare wallet:approve');
  return { diagnostics: d, facts: { imports: [...new Set(imports)], hostsInCode, receivers, methods } };
}

// ------------------------------------------------------------------ sample inputs for the behaviour test

/** One plausible value per standard type, from the demo world, so the sandboxed test exercises real code paths. */
export const TYPE_SAMPLES: Record<string, unknown> = {
  'near.account': 'bob.testnet',
  'address.near': 'bob.testnet',
  'address.near.fresh': '1f6d8a0c3b7e4e2d9a5c6b8e7f0a1d2c3b4e5f60718293a4b5c6d7e8f9a0b1c2',
  'asset.id': 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  usd: 25,
  percent: 25,
  'token.holdings': [
    { owner: 'bob.testnet', assetId: 'nep141:token.v2.ref-finance.near', contract: 'token.v2.ref-finance.near', symbol: 'REF', name: 'Ref Finance', decimals: 18, amount: '141700000000000000000', usd: 13.02, listed: true },
    { owner: 'bob.testnet', assetId: 'nep141:usdt.tether-token.near', contract: 'usdt.tether-token.near', symbol: 'USDT', name: 'Tether USD', decimals: 6, amount: '7120000', usd: 7.12, listed: true },
  ],
  'token.flags': [],
  'swap.plan': [],
  'swap.receipts': [],
  report: { title: 'Sample report', items: [] },
  'key.list': [
    { public_key: 'ed25519:8hSHprDq2StXwMtNd43wDTXQYsjXcD4MJTXQYsjXcD4M', kind: 'function-call', receiver: 'app.gone.near', methods: [], allowance: '250000000000000000000000', nonce: 7, action: 'revoke', reason: 'the app no longer exists' },
    { public_key: 'ed25519:5FwoV3MFB94ExfgycBvUQaTbTfgSdfgSdfgSdfgSdfgS', kind: 'full', nonce: 1, action: 'review', reason: 'full access: never removed automatically' },
  ],
  'stake.list': [{ pool: 'astro-stakers.poolv1.near', staked: '0', unstaked: '4200000000000000000000000', can_withdraw: true, fee_pct: 5, active: true }],
  'contract.facts': { account: 'v2.ref-finance.near', exists: true, has_code: true, full_access_keys: 0, source: null, listed_token: false },
  'contract.verdict': { risk: 'low', reasons: [], source: 'rules' },
};
const LIST_TYPES = new Set(['token.holdings', 'token.flags', 'swap.plan', 'swap.receipts', 'key.list', 'stake.list']);
/** A light shape check of an output value against its declared type. */
export function shapeProblem(type: string, v: unknown): string | null {
  if (v === undefined) return 'missing';
  if (LIST_TYPES.has(type)) return Array.isArray(v) ? null : 'should be a list';
  if (type === 'usd' || type === 'percent') return typeof v === 'number' ? null : 'should be a number';
  if (type.startsWith('near.account') || type.startsWith('address.') || type === 'asset.id') return typeof v === 'string' ? null : 'should be a string';
  return v !== null && typeof v === 'object' ? null : 'should be an object';
}

// ------------------------------------------------------------------ submissions, reviews and the release log

export interface ReviewerSet { owner: string; reviewers: { account: string; public_key: string }[] }
export interface Approval { reviewer: string; checklist: string[]; notes?: string; at: string; signature: string }
/** One part's entry in the release log (standard/reviews.json), which the runner's code hash covers. */
export interface ReleaseRecord {
  part: string; tier: Tier; author: string; implementation: string;
  manifest_hash: string; source_sha256: string;
  /** genesis: shipped by the owner before the review process existed. automated: open tier, checks passed. review: approved by reviewers. */
  basis: 'genesis' | 'automated' | 'review';
  submission?: string; checks_hash?: string; approvals: Approval[]; released_at: string;
}
export interface ReleaseLog { srs: '1.0'; kind: 'release-log'; release: number; records: ReleaseRecord[] }

/** The manifest as reviewed: everything except where the release puts the file (`implementation`). */
export const reviewedManifestHash = (m: PartManifest) => { const { implementation: _i, ...rest } = m; return hashObject(rest); };

export const submissionMessage = (partId: string, manifestHash: string, sourceSha: string, author: string) =>
  `srs-part-submission-v1|${partId}|${manifestHash}|${sourceSha}|${author}`;
export const reviewMessage = (submission: string, partId: string, manifestHash: string, sourceSha: string, reviewer: string, verdict: 'approve' | 'reject', checklist: string[]) =>
  `srs-part-review-v1|${submission}|${partId}|${manifestHash}|${sourceSha}|${reviewer}|${verdict}|${[...checklist].sort().join(',')}`;

export function verifySignature(message: string, signatureB64: string, publicKey: string): boolean {
  try { return nacl.sign.detached.verify(utf8ToBytes(message), base64.dec(signatureB64), bs58.decode(publicKey.replace(/^ed25519:/, ''))); } catch { return false; }
}

/**
 * Does this release record admit this part? Returns the problem, or null. The runner calls it for every part at start
 * and refuses to run a part that fails; buyers verify the same release by its code hash.
 */
export function verifyRecord(rec: ReleaseRecord | undefined, m: PartManifest, sourceSha: string, set: ReviewerSet): string | null {
  if (!rec) return 'no release record';
  if (rec.manifest_hash !== reviewedManifestHash(m)) return 'manifest differs from the reviewed one';
  if (m.implementation && rec.implementation !== m.implementation) return 'implementation path differs from the release record';
  if (rec.source_sha256 !== sourceSha) return 'code differs from the reviewed code';
  const { tier } = partTier(m);
  if (rec.tier !== tier) return `recorded as ${rec.tier}, but the manifest makes it ${tier}`;
  if (rec.basis === 'genesis') return null;
  if (rec.basis === 'automated') return tier === 'open' && rec.checks_hash ? null : 'only open parts are admitted on automated checks alone';
  const need = TIER_INFO[tier].approvals;
  const items = checklistFor(m).map((c) => c.id);
  const seen = new Set<string>();
  for (const a of rec.approvals) {
    const r = set.reviewers.find((x) => x.account === a.reviewer);
    if (!r) return `${a.reviewer} is not an appointed reviewer`;
    if (a.reviewer === rec.author) return 'the author cannot review their own part';
    if (seen.has(a.reviewer)) continue;
    if (!items.every((i) => a.checklist.includes(i))) return `${a.reviewer} did not confirm every checklist item`;
    if (!verifySignature(reviewMessage(rec.submission ?? '', rec.part, rec.manifest_hash, rec.source_sha256, a.reviewer, 'approve', a.checklist), a.signature, r.public_key)) return `${a.reviewer}'s signature does not verify`;
    seen.add(a.reviewer);
  }
  return seen.size >= need ? null : `needs ${need} independent approvals, has ${seen.size}`;
}

// ------------------------------------------------------------------ line diff for reviewers

export type DiffLine = { op: ' ' | '+' | '-'; text: string };
/** Line diff (LCS). Parts are small; the quadratic table is fine. */
export function diffLines(a: string, b: string): DiffLine[] {
  const x = a.split('\n'), y = b.split('\n');
  const n = x.length, m = y.length;
  const t = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ op: ' ', text: x[i] }); i++; j++; }
    else if (t[i + 1][j] >= t[i][j + 1]) out.push({ op: '-', text: x[i++] });
    else out.push({ op: '+', text: y[j++] });
  }
  while (i < n) out.push({ op: '-', text: x[i++] });
  while (j < m) out.push({ op: '+', text: y[j++] });
  return out;
}
