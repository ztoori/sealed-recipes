import { hashObject } from '../../core/src/canonical.js';
import { validateRecipe, refsOf, evalWhen, checkValue, type Binding, type Catalog, type Recipe, type FormField } from '../../core/src/srs.js';
import { randomBytes } from 'node:crypto';
import type { ApprovalRequest, ApprovalResult, PartHandler, Emit, Endpoints } from './types.js';
import { enforceLimits } from './limits.js';
import { HANDLERS, SANDBOXED } from './parts/registry.js';
export { HANDLERS, SANDBOXED };
import type { Admission } from './admission.js';
import { outboundFetch } from '../../core/src/outbound.js';

/** Set once at start by the runner (runner/src/admission.ts). Unset only in unit tests that exercise parts directly. */
let ADMISSION: Admission | null = null;
export function setAdmission(a: Admission | null) { ADMISSION = a; }

export const REAL_ENDPOINTS: Endpoints = {
  fastnear: 'https://api.fastnear.com',
  rpc: 'https://rpc.mainnet.fastnear.com',
  oneclick: 'https://1click.chaindefuser.com',
  nearai: 'https://cloud-api.near.ai',
  nras: 'https://nras.attestation.nvidia.com',
  solverRelay: 'https://solver-relay-v2.chaindefuser.com',
};

/** host → base URL used in local mode (e.g. "api.fastnear.com=http://localhost:8080/mock/fastnear"). */
export function parseRewrites(spec = ''): Map<string, string> {
  return new Map(spec.split(',').filter(Boolean).map((kv) => { const [h, ...rest] = kv.split('='); return [h.trim(), rest.join('=').trim()]; }));
}

/** fetch limited to the part's declared `net:<host>` capabilities. */
export function guardedFetch(partId: string, capabilities: string[], rewrites: Map<string, string>) {
  const allowed = new Set(capabilities.filter((c) => c.startsWith('net:')).map((c) => c.slice(4)));
  return async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    if (!allowed.has(u.host)) throw new Error(`capability violation: ${partId} may not reach ${u.host} (declared: ${[...allowed].join(', ') || 'none'})`);
    const base = rewrites.get(u.host);
    const target = base ? base.replace(/\/$/, '') + u.pathname + u.search : url;
    const timeout = AbortSignal.timeout(20_000);
    // third-party services are rate-limited, cached and retried safely (core/src/outbound.ts); local mocks are not
    return outboundFetch(target, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
  };
}

export function validateInputs(form: FormField[], inputs: Record<string, unknown>): string[] {
  const errs: string[] = [];
  for (const f of form) {
    const v = inputs[f.id] ?? f.default;
    if (v === undefined || v === '') { if (f.required) errs.push(`${f.label} is required`); continue; }
    if (f.type === 'usd' && !(Number(v) >= 0)) errs.push(`${f.label} must be a positive number`);
    if (f.type === 'percent' && !(Number(v) > 0 && Number(v) < 100)) errs.push(`${f.label} must be a percentage between 0 and 100`);
    if ((f.type === 'near.account' || f.type === 'address.near') && !/^[a-z0-9._-]{2,64}$/.test(String(v))) errs.push(`${f.label} is not a NEAR account`);
    if (f.options && !f.options.includes(String(v))) errs.push(`${f.label} must be one of ${f.options.join(', ')}`);
  }
  return errs;
}

export interface ExecDeps {
  catalog: Catalog;
  emit: Emit;
  rewrites: Map<string, string>;
  secrets: { nearAiKey?: string; oneClickJwt?: string };
  requestApproval: (nodeId: string, req: ApprovalRequest) => Promise<ApprovalResult>;
  mode?: 'run' | 'quote';
  /** durable runs: where to continue from (decrypted checkpoint) */
  resume?: ResumePoint;
  /** called after every completed part, and by parts before irreversible steps (write-ahead) */
  checkpoint?: (cp: ResumePoint, partsDone: string[]) => Promise<void>;
  /** approvals relayed after the last checkpoint, by node (from the marketplace's log) */
  priorApprovals?: Record<string, ApprovalResult>;
}

/** Everything needed to continue a run: completed nodes, their outputs, parts billed so far, and the state of the
 *  node in progress. Sealed to the runner's own key and signed before it leaves the runner. */
export interface ResumePoint { index: number; values: Record<string, unknown>; used: string[]; node?: string; partState?: unknown; skipped?: string[] }

/**
 * partsUsed: the parts to bill, sorted (SRS-1 §6.1): every declared node with bill "declared" (the default), only the
 * nodes that ran with bill "executed". skipped: nodes that did not run (sealed; reported only to the buyer).
 * outputHash commits to the output with a random salt that only the buyer receives, so a short output (a verdict)
 * cannot be confirmed by guessing.
 */
export interface ExecResult { ok: boolean; output: unknown; partsUsed: string[]; outputHash: string; salt: string; skipped: string[]; error?: string }

export async function execute(runId: string, recipe: Recipe, inputs: Record<string, unknown>, deps: ExecDeps): Promise<ExecResult> {
  const v = validateRecipe(recipe, deps.catalog);
  if (!v.ok) throw new Error('sealed recipe failed SRS-1 validation: ' + v.diagnostics.map((d) => d.message).join('; '));
  const inErr = validateInputs(recipe.form, inputs);
  if (inErr.length) throw new Error(inErr.join('; '));
  const values = new Map<string, unknown>(); // "<node>.<port>" | "form.x" | "const.x"; a skipped node has no entries
  for (const f of recipe.form) values.set(`form.${f.id}`, inputs[f.id] ?? f.default);
  for (const [k, c] of Object.entries(recipe.consts ?? {})) values.set(`const.${k}`, c.value);
  const manifests = new Map(deps.catalog.parts.map((b) => [b.id, b]));
  const used: string[] = [...(deps.resume?.used ?? [])];
  const skipped = new Set<string>(deps.resume?.skipped ?? []);
  const start = deps.resume?.index ?? 0;
  for (const [k, v] of Object.entries(deps.resume?.values ?? {})) values.set(k, v);
  const nodeValues = () => Object.fromEntries([...values].filter(([k]) => !k.startsWith('form.') && !k.startsWith('const.')));
  // SRS-1 §3.3: a reference is present unless it points at a skipped node; a list of references takes the first present one
  const present = (ref: string) => !skipped.has(ref.slice(0, ref.indexOf('.')));
  const resolve = (b: Binding): { ok: boolean; value?: unknown } => { const r = refsOf(b).find(present); return r ? { ok: true, value: values.get(r) } : { ok: false }; };
  if (start > 0 || deps.resume?.partState !== undefined) deps.emit('resumed', { from_part: start, of: v.order.length, mid_part: deps.resume?.node ?? null });
  const salt = randomBytes(16).toString('hex');

  try {
    for (let idx = start; idx < v.order.length; idx++) {
      const nodeId = v.order[idx];
      const node = recipe.nodes.find((n) => n.id === nodeId)!;
      const m = manifests.get(node.part)!;
      // SRS-1 §3.5: skip when a required input is absent (its source was skipped) or the condition does not hold
      const missing = Object.entries(node.inputs).filter(([, b]) => !resolve(b).ok).map(([p]) => p);
      // a condition on a skipped node sees no value: "empty" holds, "match" and "some" do not (this is how a fallback runs only when its primary was skipped)
      const why = missing.length ? `input ${missing.join(', ')} has no value` : node.when && !evalWhen(node.when, resolve(node.when.ref).value) ? 'its condition does not hold' : null;
      if (why) {
        skipped.add(nodeId);
        deps.emit('part_skipped', { node: nodeId, part: m.id, name: m.name, reason: why });
        if (deps.checkpoint && (deps.mode ?? 'run') === 'run') await deps.checkpoint({ index: idx + 1, values: nodeValues(), used: [...used], skipped: [...skipped] }, []);
        continue;
      }
      // only parts whose release record verifies run; open-tier parts run in the sandbox (SRS-1 §11)
      if (ADMISSION && !ADMISSION.admitted.has(node.part)) throw new Error(`${node.part} is not admitted in this runner release: ${ADMISSION.refused.get(node.part) ?? 'no release record'}`);
      const handler = ADMISSION?.sandboxed.get(node.part) ?? HANDLERS[node.part];
      if (!handler) throw new Error(`runner has no implementation for ${node.part}`);
      const partInputs = Object.fromEntries(Object.entries(node.inputs).map(([p, b]) => [p, resolve(b).value]));
      const params = { ...Object.fromEntries(Object.entries(m.params).map(([k, s]) => [k, s.default])), ...node.params };
      const t0 = Date.now();
      const resumeHere = deps.resume?.node === nodeId ? deps.resume.partState : undefined;
      deps.emit('part_start', { node: nodeId, part: m.id, name: m.name, author: m.author, fee: m.fee_per_call, resumed: resumeHere !== undefined, step: idx + 1, of: v.order.length });
      let out: Record<string, unknown>;
      try {
        // per-run resource limits declared in the manifest (SRS-1 §2.2); exceeding one fails the run → buyer refunded
        out = await enforceLimits(m, guardedFetch(m.id, m.capabilities, deps.rewrites), (http, approval) => handler(partInputs, {
          nodeId, manifest: m, params, http,
          log: (msg, data) => deps.emit('part_log', { node: nodeId, msg, data }),
          requestApproval: (req) => approval(() => deps.requestApproval(nodeId, req)),
          endpoints: REAL_ENDPOINTS,
          secrets: deps.secrets,
          mode: deps.mode ?? 'run',
          resumeState: resumeHere,
          priorApproval: deps.priorApprovals?.[nodeId],
          wait: (ms) => approval(() => new Promise<void>((r) => setTimeout(r, ms))),
          saveState: async (partState) => { if (deps.checkpoint && (deps.mode ?? 'run') === 'run') await approval(() => deps.checkpoint!({ index: idx, values: nodeValues(), used: [...used], node: nodeId, partState, skipped: [...skipped] }, [])); },
        }));
        // SRS-1 §1.2: every declared output is present and is a value of its (bound) type
        for (const port of Object.keys(m.outputs)) {
          const t = v.portTypes[`${nodeId}.${port}`];
          if (!(port in out)) throw new Error(`${m.id} returned no "${port}"`);
          const bad = t ? checkValue(deps.catalog.types, t, out[port]) : [];
          if (bad.length) throw new Error(`${m.id} output "${port}" is not a ${t}: ${bad.join('; ')}`);
        }
      } catch (e) {
        // SRS-1 §3.4: on_error "skip" (never allowed on signing parts) continues without this node
        if (node.on_error !== 'skip') throw e;
        skipped.add(nodeId);
        deps.emit('part_skipped', { node: nodeId, part: m.id, name: m.name, reason: `failed: ${(e as Error).message}` });
        if (deps.checkpoint && (deps.mode ?? 'run') === 'run') await deps.checkpoint({ index: idx + 1, values: nodeValues(), used: [...used], skipped: [...skipped] }, []);
        continue;
      }
      for (const port of Object.keys(m.outputs)) values.set(`${nodeId}.${port}`, out[port]);
      used.push(m.id);
      deps.emit('part_done', { node: nodeId, part: m.id, ms: Date.now() - t0, ports: Object.keys(out), step: idx + 1, of: v.order.length });
      if (deps.checkpoint && (deps.mode ?? 'run') === 'run') await deps.checkpoint({ index: idx + 1, values: nodeValues(), used: [...used], skipped: [...skipped] }, [m.id]);
    }
    const result = resolve(recipe.output);
    if (!result.ok) throw new Error('the recipe produced no result on this run: every node its output reads was skipped');
    const output = result.value;
    const partsUsed = (v.bill === 'declared' ? v.partsUsed : used).slice().sort();
    return { ok: true, output, partsUsed, outputHash: hashObject({ run_id: runId, salt, output }), salt, skipped: v.order.filter((id) => skipped.has(id)) };
  } catch (e) {
    const error = (e as Error).message;
    deps.emit('part_error', { error });
    return { ok: false, output: null, partsUsed: [], outputHash: hashObject({ run_id: runId, salt, error }), salt, skipped: [...skipped], error };
  }
}
