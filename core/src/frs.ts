/**
 * FRS-1 (Fungible Recipe Standard) — the no-code / low-code composition standard.
 * A part declares typed ports; a recipe wires parts into a DAG. This module
 * validates recipes, type-checks wiring, computes cost/capabilities, derives the
 * public listing (what a marketplace may see) and finds drop-in part swaps.
 */
import { hashObject } from './canonical.js';

export type PortSpec = { type: string; description?: string };
export type ParamSpec = { type: string; default?: unknown; secret?: boolean; description?: string };

/**
 * Disclosure (FRS-1 §2.1). Every part declares its four layers so buyers can judge whether it could be rebuilt
 * if its supplier disappeared.
 *  - Parts on open-weights models carry low withdrawal risk: anyone can re-host the weights.
 *  - Parts on closed models carry high withdrawal risk: the provider can retire, change or reprice the model at any time.
 * open = published, sealed = escrowed to the TEE runner (rebuildable without anyone seeing it), closed = held only by the supplier.
 */
export type LayerAccess = 'open' | 'sealed' | 'closed';
export interface Disclosure {
  model: { kind: 'none' | 'open-weights' | 'closed'; name?: string; host?: string };
  instructions: LayerAccess;
  harness: LayerAccess;
  verification: LayerAccess;
  runtime: 'bundled' | 'remote';
}
export type Risk = 'low' | 'medium' | 'high';
export interface Limits { max_ms: number; max_http_calls: number; max_model_calls: number; max_output_bytes: number }

export function withdrawalRisk(d: Disclosure): Risk {
  if (d.model.kind === 'closed') return 'high';
  if (d.runtime === 'remote') return d.harness === 'closed' || d.verification === 'closed' ? 'high' : 'medium';
  return 'low';
}
const RISK_ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2 };
export const maxRisk = (rs: Risk[]): Risk => rs.reduce<Risk>((a, b) => (RISK_ORDER[b] > RISK_ORDER[a] ? b : a), 'low');

export interface JobType {
  id: string; name: string; description: string;
  inputs: Record<string, { type: string; label?: string; default?: unknown; options?: string[]; placeholder?: string; required?: boolean; generator?: 'fresh-implicit' }>;
  output: string;
  metric: { name: string; unit: 'payment-token'; description: string } | null;
}

export interface PartManifest {
  id: string; // "<name>@<semver>"
  name: string;
  category: 'source' | 'guard' | 'transform' | 'action' | 'sink';
  author: string;
  summary: string;
  inputs: Record<string, PortSpec>;
  outputs: Record<string, PortSpec>;
  params: Record<string, ParamSpec>;
  capabilities: string[];
  fee_per_call: string; // payment-token smallest units
  implementation?: string;
  disclosure: Disclosure;
  limits: Limits;
}

export interface TypeDef { description: string; extends: string | null }

export interface Catalog { frs: '1.0'; kind: 'part-catalog'; types: Record<string, TypeDef>; parts: PartManifest[]; jobs?: JobType[] }

export interface FormField {
  id: string;
  label: string;
  type: string;
  required?: boolean;
  default?: unknown;
  options?: string[];
  placeholder?: string;
  generator?: 'fresh-implicit';
}

export interface RecipeNode {
  id: string;
  part: string;
  inputs: Record<string, string>; // port -> ref ("form.x" | "const.x" | "<node>.<port>")
  params: Record<string, unknown>;
  ui?: { x: number; y: number };
}

export interface Recipe {
  frs: '1.0';
  kind: 'recipe';
  meta: { ticker: string; name: string; creator: string; description: string };
  form: FormField[];
  nodes: RecipeNode[];
  consts?: Record<string, { type: string; value: unknown }>;
  output: string; // "<node>.<port>"
  /** job type this recipe competes for (recipe intents); its form must match the job's inputs */
  implements?: string;
  listing: { price_per_run: string; royalty_bps: number; total_shares: string; bond?: string };
}

export type Severity = 'error' | 'warning';
export interface Diagnostic { severity: Severity; code: string; message: string; node?: string; port?: string }

export interface ValidationResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  order: string[]; // topological execution order
  partsUsed: string[]; // part ids, one per node, in execution order
  capabilities: string[];
  partFees: bigint;
  outputType?: string;
  risk: Risk;
}

export const TICKER_RE = /^[A-Z0-9]{3,6}$/;

/** true when `actual` can be used where `expected` is required (nominal subtyping via `extends`). */
export function isAssignable(types: Record<string, TypeDef>, actual: string, expected: string): boolean {
  let t: string | null = actual;
  const seen = new Set<string>();
  while (t && !seen.has(t)) {
    if (t === expected) return true;
    seen.add(t);
    t = types[t]?.extends ?? null;
  }
  return false;
}

export function partIndex(catalog: Catalog): Map<string, PartManifest> {
  return new Map(catalog.parts.map((b) => [b.id, b]));
}

function resolveRefType(
  ref: string,
  recipe: Recipe,
  nodes: Map<string, RecipeNode>,
  parts: Map<string, PartManifest>,
): { type?: string; dep?: string; error?: string } {
  const dot = ref.indexOf('.');
  if (dot < 1) return { error: `malformed reference "${ref}"` };
  const head = ref.slice(0, dot);
  const tail = ref.slice(dot + 1);
  if (head === 'form') {
    const f = recipe.form.find((x) => x.id === tail);
    return f ? { type: f.type } : { error: `form field "${tail}" does not exist` };
  }
  if (head === 'const') {
    const c = recipe.consts?.[tail];
    return c ? { type: c.type } : { error: `const "${tail}" does not exist` };
  }
  const n = nodes.get(head);
  if (!n) return { error: `node "${head}" does not exist` };
  const b = parts.get(n.part);
  if (!b) return { error: `node "${head}" uses unknown part` };
  const p = b.outputs[tail];
  return p ? { type: p.type, dep: head } : { error: `part ${b.id} has no output "${tail}"` };
}

export function validateRecipe(recipe: Recipe, catalog: Catalog): ValidationResult {
  const d: Diagnostic[] = [];
  const parts = partIndex(catalog);
  const types = catalog.types;
  const err = (code: string, message: string, node?: string, port?: string) => d.push({ severity: 'error', code, message, node, port });
  const warn = (code: string, message: string, node?: string, port?: string) => d.push({ severity: 'warning', code, message, node, port });

  if (recipe.frs !== '1.0' || recipe.kind !== 'recipe') err('frs.version', 'recipe must declare frs "1.0" and kind "recipe"');
  if (!TICKER_RE.test(recipe.meta?.ticker ?? '')) err('meta.ticker', 'ticker must be 3-6 chars A-Z/0-9');
  if (!recipe.meta?.name) err('meta.name', 'recipe needs a name');

  const formIds = new Set<string>();
  for (const f of recipe.form ?? []) {
    if (formIds.has(f.id)) err('form.duplicate', `duplicate form field "${f.id}"`);
    formIds.add(f.id);
    if (!types[f.type]) err('form.type', `form field "${f.id}" has unknown type "${f.type}"`);
  }
  if ((recipe.form ?? []).length > 6) warn('form.long', 'FRS-1 recommends at most 6 form fields (one short form, no chat)');

  const nodes = new Map<string, RecipeNode>();
  for (const n of recipe.nodes ?? []) {
    if (nodes.has(n.id)) err('node.duplicate', `duplicate node id "${n.id}"`, n.id);
    if (n.id === 'form' || n.id === 'const') err('node.reserved', `"${n.id}" is a reserved name`, n.id);
    nodes.set(n.id, n);
  }
  if (nodes.size === 0) err('recipe.empty', 'a recipe needs at least one part');

  const deps = new Map<string, Set<string>>();
  const usedForm = new Set<string>();
  for (const n of nodes.values()) {
    deps.set(n.id, new Set());
    const b = parts.get(n.part);
    if (!b) { err('node.part', `unknown part "${n.part}"`, n.id); continue; }
    for (const [port, spec] of Object.entries(b.inputs)) {
      const ref = n.inputs?.[port];
      if (!ref) { err('port.unwired', `input "${port}" (${spec.type}) is not connected`, n.id, port); continue; }
      const r = resolveRefType(ref, recipe, nodes, parts);
      if (r.error) { err('port.ref', r.error, n.id, port); continue; }
      if (ref.startsWith('form.')) usedForm.add(ref.slice(5));
      if (r.dep) deps.get(n.id)!.add(r.dep);
      if (r.type && !isAssignable(types, r.type, spec.type)) {
        err('port.type', `"${port}" expects ${spec.type} but ${ref} is ${r.type}`, n.id, port);
      }
    }
    for (const port of Object.keys(n.inputs ?? {})) {
      if (!b.inputs[port]) warn('port.extra', `part ${b.id} has no input "${port}"`, n.id, port);
    }
    for (const [k, spec] of Object.entries(b.params)) {
      if (n.params?.[k] === undefined && spec.default === undefined && spec.secret) {
        warn('param.missing', `param "${k}" not set; part default behaviour applies`, n.id);
      }
    }
  }
  for (const f of formIds) if (!usedForm.has(f)) warn('form.unused', `form field "${f}" is not used by any part`);

  // Kahn topological sort with stable order (declaration order)
  const order: string[] = [];
  const indeg = new Map([...deps].map(([k, v]) => [k, v.size]));
  const ready = [...nodes.keys()].filter((k) => indeg.get(k) === 0);
  while (ready.length) {
    const k = ready.shift()!;
    order.push(k);
    for (const [m, ds] of deps) {
      if (ds.has(k)) {
        indeg.set(m, indeg.get(m)! - 1);
        if (indeg.get(m) === 0) ready.push(m);
      }
    }
  }
  if (order.length !== nodes.size) err('graph.cycle', 'parts form a cycle; FRS-1 recipes must be acyclic');

  let outputType: string | undefined;
  const o = resolveRefType(recipe.output ?? '', recipe, nodes, parts);
  if (o.error) err('recipe.output', `output: ${o.error}`); else outputType = o.type;

  // dead-end nodes (outputs consumed by nothing and not the recipe output)
  const consumed = new Set<string>();
  for (const n of nodes.values()) for (const ref of Object.values(n.inputs ?? {})) consumed.add(ref.split('.')[0]);
  consumed.add((recipe.output ?? '').split('.')[0]);
  for (const n of nodes.values()) if (!consumed.has(n.id)) warn('node.deadend', `output of "${n.id}" is never used (you still pay its fee)`, n.id);

  const partsUsed = order.map((id) => nodes.get(id)!.part).filter((b) => parts.has(b));
  const capabilities = [...new Set(partsUsed.flatMap((b) => parts.get(b)!.capabilities))].sort();
  const partFees = partsUsed.reduce((s, b) => s + BigInt(parts.get(b)!.fee_per_call), 0n);
  const risk = maxRisk(partsUsed.map((b) => (parts.get(b)!.disclosure ? withdrawalRisk(parts.get(b)!.disclosure) : 'high')));
  for (const id of new Set(partsUsed)) if (parts.get(id)!.disclosure?.model.kind === 'closed') warn('part.closed-model', `${id} runs on a closed model: its provider can withdraw or reprice it at any time (high withdrawal risk)`);

  if (recipe.implements) {
    const job = catalog.jobs?.find((j) => j.id === recipe.implements);
    if (!job) err('job.unknown', `unknown job type "${recipe.implements}"`);
    else {
      for (const [id, spec] of Object.entries(job.inputs)) {
        const f = recipe.form.find((x) => x.id === id);
        if (!f) err('job.input', `job ${job.id} needs form field "${id}" (${spec.type})`);
        else if (!isAssignable(types, spec.type, f.type)) err('job.input', `form field "${id}" must accept ${spec.type}`);
      }
      for (const f of recipe.form) if (!job.inputs[f.id]) err('job.input', `form field "${f.id}" is not part of job ${job.id}; buyers posting this job will not provide it`);
      if (outputType && outputType !== job.output) err('job.output', `job ${job.id} expects output ${job.output}, recipe returns ${outputType}`);
    }
  }

  return { ok: !d.some((x) => x.severity === 'error'), diagnostics: d, order, partsUsed, capabilities, partFees, outputType, risk };
}

/** What the marketplace and chain are allowed to see. Wiring and params stay sealed. */
export interface PublicListing {
  ticker: string;
  name: string;
  creator: string;
  description: string;
  form: FormField[];
  parts: string[];
  capabilities: string[];
  output_type: string;
  price_per_run: string;
  royalty_bps: number;
  total_shares: string;
  interface_hash: string;
  implements: string | null;
  risk: Risk;
  disclosures: { part: string; model: Disclosure['model']; runtime: Disclosure['runtime']; risk: Risk }[];
  privacy: 'confidential' | 'public' | 'n/a';
}

export function publicListing(recipe: Recipe, catalog: Catalog): PublicListing {
  const parts = partIndex(catalog);
  const v = validateRecipe(recipe, catalog);
  if (!v.ok) throw new Error('cannot list an invalid recipe: ' + v.diagnostics.filter((x) => x.severity === 'error').map((x) => x.message).join('; '));
  const iface = { form: recipe.form, parts: v.partsUsed, output_type: v.outputType };
  return {
    ticker: recipe.meta.ticker,
    name: recipe.meta.name,
    creator: recipe.meta.creator,
    description: recipe.meta.description,
    form: recipe.form,
    parts: v.partsUsed,
    capabilities: v.capabilities,
    output_type: v.outputType!,
    price_per_run: recipe.listing.price_per_run,
    royalty_bps: recipe.listing.royalty_bps,
    total_shares: recipe.listing.total_shares,
    interface_hash: hashObject(iface),
    implements: recipe.implements ?? null,
    risk: v.risk,
    disclosures: [...new Set(v.partsUsed)].map((id) => { const m = parts.get(id)!; return { part: id, model: m.disclosure.model, runtime: m.disclosure.runtime, risk: withdrawalRisk(m.disclosure) }; }),
    privacy: v.capabilities.includes('wallet:approve') ? (v.partsUsed.some((b) => b.startsWith('intents.confidential-swap')) ? 'confidential' : 'public') : 'n/a',
  };
}

/**
 * Parts that can replace `nodeId`'s part without rewiring: every currently-wired
 * input must still be accepted (contravariant) and every output that downstream
 * nodes consume must still exist with an assignable type (covariant).
 */
export function compatibleSwaps(recipe: Recipe, nodeId: string, catalog: Catalog): PartManifest[] {
  const node = recipe.nodes.find((n) => n.id === nodeId);
  if (!node) return [];
  const parts = partIndex(catalog);
  const current = parts.get(node.part);
  if (!current) return [];
  const nodes = new Map(recipe.nodes.map((n) => [n.id, n]));
  const consumedPorts = new Set<string>();
  for (const n of recipe.nodes) for (const ref of Object.values(n.inputs)) if (ref.startsWith(nodeId + '.')) consumedPorts.add(ref.slice(nodeId.length + 1));
  if (recipe.output.startsWith(nodeId + '.')) consumedPorts.add(recipe.output.slice(nodeId.length + 1));

  return catalog.parts.filter((cand) => {
    if (cand.id === current.id) return false;
    for (const [port, spec] of Object.entries(cand.inputs)) {
      const ref = node.inputs[port];
      if (!ref) return false;
      const r = resolveRefType(ref, recipe, nodes, parts);
      if (!r.type || !isAssignable(catalog.types, r.type, spec.type)) return false;
    }
    for (const port of consumedPorts) {
      const out = cand.outputs[port];
      const curOut = current.outputs[port];
      if (!out || !curOut) return false;
      // every downstream consumer must still accept the new type
      for (const n of recipe.nodes) {
        const b = parts.get(n.part);
        for (const [p, ref] of Object.entries(n.inputs)) {
          if (ref === `${nodeId}.${port}` && b && !isAssignable(catalog.types, out.type, b.inputs[p]?.type ?? out.type)) return false;
        }
      }
    }
    return true;
  });
}

export function swapPart(recipe: Recipe, nodeId: string, newPartId: string, catalog: Catalog): Recipe {
  const cand = partIndex(catalog).get(newPartId);
  if (!cand) throw new Error('unknown part ' + newPartId);
  if (!compatibleSwaps(recipe, nodeId, catalog).some((b) => b.id === newPartId)) throw new Error(`${newPartId} is not a drop-in replacement for node ${nodeId}`);
  return {
    ...recipe,
    nodes: recipe.nodes.map((n) => {
      if (n.id !== nodeId) return n;
      const params: Record<string, unknown> = {};
      for (const [k, spec] of Object.entries(cand.params)) params[k] = n.params[k] ?? spec.default;
      const inputs: Record<string, string> = {};
      for (const k of Object.keys(cand.inputs)) inputs[k] = n.inputs[k];
      return { ...n, part: newPartId, params, inputs };
    }),
  };
}
