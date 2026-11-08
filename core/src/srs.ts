/**
 * SRS-1 (Sealed Recipe Spec) — the no-code / low-code composition spec.
 * A part declares typed ports; a recipe wires parts into a DAG. This module
 * validates recipes, type-checks wiring, computes cost/capabilities, derives the
 * public listing (what a marketplace may see) and finds drop-in part swaps.
 */
import { hashObject } from './canonical.js';

export type PortSpec = { type: string; description?: string };
export type ParamSpec = { type: string; default?: unknown; secret?: boolean; description?: string };

/**
 * Disclosure (SRS-1 §2.1). Every part declares its four layers so buyers can judge whether it could be rebuilt
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

export interface PartManifest {
  id: string; // "<name>@<semver>"
  name: string;
  category: 'source' | 'guard' | 'transform' | 'action' | 'sink';
  author: string;
  summary: string;
  /** SRS-1 §1.3: type variables (single capital letters). A port typed "T" accepts any type within T's bound. */
  type_params?: Record<string, { extends: string | null }>;
  inputs: Record<string, PortSpec>;
  outputs: Record<string, PortSpec>;
  params: Record<string, ParamSpec>;
  capabilities: string[];
  fee_per_call: string; // payment-token smallest units
  implementation?: string;
  disclosure: Disclosure;
  limits: Limits;
}

/**
 * SRS-1 §1.2: the value schema of a type, a small subset of JSON Schema. A value of type A must satisfy the schema
 * of A and of every type A extends. The runner checks every part output against it (a part that returns something
 * else fails the run and the buyer is refunded), and the validator checks constants and conditions against it.
 */
export interface Schema {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';
  enum?: (string | number | boolean | null)[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
}

/** `proof: true` (SRS-1 §1.1): a value of this type can only come from a part that establishes it, never from the buyer's form or a constant. */
export interface TypeDef { description: string; extends: string | null; schema?: Schema; proof?: boolean }

export interface Catalog { srs: '1.0'; kind: 'part-catalog'; types: Record<string, TypeDef>; parts: PartManifest[] }

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

/** A reference ("form.x" | "const.x" | "<node>.<port>"), or (SRS-1 §3.3) a list of references: the first one present. */
export type Binding = string | string[];
/** field → accepted values */
export type Match = Record<string, (string | number | boolean | null)[]>;
/**
 * SRS-1 §3.2: a node runs only when its condition holds. Exactly one test:
 *  - `is`: "nonempty" (default) or "empty" (an empty list, an object with no keys, null, absent or "");
 *  - `match`: the value is an object and every listed field has one of the listed values;
 *  - `some`: the value is a list and at least one item matches every listed field.
 * `not: true` negates the test, which is how a recipe writes the "else" branch.
 */
export interface When { ref: string; is?: 'nonempty' | 'empty'; match?: Match; some?: Match; not?: boolean }

export interface RecipeNode {
  id: string;
  part: string;
  inputs: Record<string, Binding>;
  /** may be omitted: {} */
  params: Record<string, unknown>;
  /** SRS-1 §3.2 */
  when?: When;
  /** SRS-1 §3.4: "skip" lets the recipe continue without this node if its part fails. Not allowed on parts that ask for signatures. */
  on_error?: 'fail' | 'skip';
  ui?: { x: number; y: number };
}

export interface Listing {
  price_per_run: string;
  /** v6: market-driven band; omitted = fixed price */
  pricing?: { price_floor: string; price_ceiling: string; target_runs: number };
  /** share of the creator's cut kept as the recipe's guarantee deposit (0..10000) */
  reserve_bps?: number;
  bond?: string;
  settle_mode?: 'final' | 'checkpoint';
  /** SRS-1 §6.1: "declared" (default) bills every node on success, run or skipped, so settlements do not reveal which branch ran */
  bill?: 'declared' | 'executed';
}

export interface Recipe {
  srs: '1.0';
  kind: 'recipe';
  meta: { ticker: string; name: string; creator: string; description: string };
  form: FormField[];
  nodes: RecipeNode[];
  consts?: Record<string, { type: string; value: unknown }>;
  output: Binding;
  listing: Listing;
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
  /** SRS-1: resolved type of every node output ("<node>.<port>" → type), with type variables bound */
  portTypes: Record<string, string>;
  /** SRS-1: nodes that may be skipped at run time (a condition, on_error: skip, or a skipped required input) */
  optional: string[];
  bill: 'declared' | 'executed';
}

export const SPEC_VERSION = '1.0';
export const TICKER_RE = /^[A-Z0-9]{3,6}$/;
/** node ids, form field ids and constant names: they appear inside references, so they cannot contain "." */
export const ID_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const TYPE_VAR_RE = /^[A-Z]$/;
const INT_RE = /^\d+$/;
/**
 * Hosts a creator's secret params may reach without a warning: public NEAR data (read-only, the request carries no
 * secret) and NEAR AI Cloud's attested private inference, whose TEE signature every model part verifies.
 */
export const CONFIDENTIAL_HOSTS = ['api.fastnear.com', 'rpc.mainnet.fastnear.com', '1click.chaindefuser.com', 'solver-relay-v2.chaindefuser.com', 'cloud-api.near.ai', 'nras.attestation.nvidia.com'];

/** The references a binding reads. */
export const refsOf = (b: Binding | undefined): string[] => (b === undefined ? [] : Array.isArray(b) ? b : [b]);

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

/** `type` and every type it extends, most specific first. */
export function ancestors(types: Record<string, TypeDef>, type: string): string[] {
  const out: string[] = [];
  let t: string | null = type;
  while (t && !out.includes(t)) { out.push(t); t = types[t]?.extends ?? null; }
  return out;
}

/** The most specific type every argument is assignable to (nominal single inheritance), or null if there is none. */
export function joinTypes(types: Record<string, TypeDef>, ts: string[]): string | null {
  if (!ts.length) return null;
  let acc: string | null = ts[0];
  for (const t of ts.slice(1)) {
    if (acc === null) return null;
    const up: string[] = ancestors(types, acc);
    acc = ancestors(types, t).find((x) => up.includes(x)) ?? null;
  }
  return acc;
}

/** Errors (at most 5) when `v` does not satisfy `s`. */
export function checkSchema(s: Schema, v: unknown, path = '$'): string[] {
  const errs: string[] = [];
  const go = (s: Schema, v: unknown, path: string) => {
    if (errs.length >= 5) return;
    const t = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
    if (s.type) {
      const ok = s.type === 'integer' ? typeof v === 'number' && Number.isInteger(v) : s.type === t;
      if (!ok) { errs.push(`${path} should be ${s.type}, got ${t}`); return; }
    }
    if (s.enum && !s.enum.includes(v as never)) errs.push(`${path} should be one of ${s.enum.join(', ')}`);
    if (s.pattern && typeof v === 'string' && !new RegExp(s.pattern).test(v)) errs.push(`${path} does not match ${s.pattern}`);
    if (typeof v === 'number') {
      if (s.minimum !== undefined && v < s.minimum) errs.push(`${path} should be ≥ ${s.minimum}`);
      if (s.maximum !== undefined && v > s.maximum) errs.push(`${path} should be ≤ ${s.maximum}`);
    }
    if (t === 'object' && v) {
      const o = v as Record<string, unknown>;
      for (const k of s.required ?? []) if (o[k] === undefined) errs.push(`${path}.${k} is required`);
      for (const [k, ps] of Object.entries(s.properties ?? {})) if (o[k] !== undefined) go(ps, o[k], `${path}.${k}`);
    }
    if (Array.isArray(v) && s.items) v.forEach((x, i) => go(s.items!, x, `${path}[${i}]`));
  };
  go(s, v, path);
  return errs;
}

/** Errors when `v` is not a value of `type`: it must satisfy the schema of the type and of every type it extends. */
export function checkValue(types: Record<string, TypeDef>, type: string, v: unknown): string[] {
  return ancestors(types, type).flatMap((t) => (types[t]?.schema ? checkSchema(types[t].schema!, v) : [])).slice(0, 5);
}

/** The schema that applies to a field: the most specific type that declares one. */
export const schemaOf = (types: Record<string, TypeDef>, type: string): Schema | undefined => ancestors(types, type).map((t) => types[t]?.schema).find(Boolean);

/** Evaluates a node condition (SRS-1 §3.2) against a resolved value. */
export function evalWhen(w: When, v: unknown): boolean {
  const empty = (x: unknown) => x === undefined || x === null || x === '' || (Array.isArray(x) && x.length === 0) || (typeof x === 'object' && x !== null && !Array.isArray(x) && Object.keys(x).length === 0);
  const matches = (o: unknown, m: Match) => typeof o === 'object' && o !== null && !Array.isArray(o) && Object.entries(m).every(([k, vals]) => vals.includes((o as Record<string, never>)[k] ?? null));
  let r: boolean;
  if (w.match) r = matches(v, w.match);
  else if (w.some) r = Array.isArray(v) && v.some((x) => matches(x, w.some!));
  else r = w.is === 'empty' ? empty(v) : !empty(v);
  return w.not ? !r : r;
}

/**
 * Value delivered (SRS-1 §7). A recipe whose result is swap receipts has a measurable value: what reached the
 * buyer's recipient, in payment-token units. Only such recipes can promise a value in a signed quote and back
 * that promise with their guarantee deposit; any other recipe quotes its price alone.
 */
export const VALUE_TYPE = 'swap.receipts';
export const measuresValue = (types: Record<string, TypeDef>, outputType?: string | null): boolean => !!outputType && isAssignable(types, outputType, VALUE_TYPE);

export function partIndex(catalog: Catalog): Map<string, PartManifest> {
  return new Map(catalog.parts.map((b) => [b.id, b]));
}

/** a condition's test without its negation, canonically (is defaults to "nonempty") */
const canonicalTest = (w: When) => JSON.stringify(w.match ? { match: sortKeys(w.match) } : w.some ? { some: sortKeys(w.some) } : { is: w.is ?? 'nonempty' });
const sortKeys = (m: Match) => Object.fromEntries(Object.keys(m).sort().map((k) => [k, [...m[k]].map(String).sort()]));

const isVar = (m: PartManifest, type: string) => !!m.type_params && Object.prototype.hasOwnProperty.call(m.type_params, type);

export function validateRecipe(recipe: Recipe, catalog: Catalog): ValidationResult {
  const d: Diagnostic[] = [];
  const parts = partIndex(catalog);
  const types = catalog.types;
  const err = (code: string, message: string, node?: string, port?: string) => d.push({ severity: 'error', code, message, node, port });
  const warn = (code: string, message: string, node?: string, port?: string) => d.push({ severity: 'warning', code, message, node, port });

  if (recipe.srs !== SPEC_VERSION || recipe.kind !== 'recipe') err('srs.version', `recipe must declare srs "${SPEC_VERSION}" and kind "recipe"`);
  if (!TICKER_RE.test(recipe.meta?.ticker ?? '')) err('meta.ticker', 'ticker must be 3-6 chars A-Z/0-9');
  if (!recipe.meta?.name) err('meta.name', 'recipe needs a name');

  const formIds = new Set<string>();
  for (const f of recipe.form ?? []) {
    if (formIds.has(f.id)) err('form.duplicate', `duplicate form field "${f.id}"`);
    formIds.add(f.id);
    if (!ID_RE.test(f.id ?? '')) err('form.id', `form field id "${f.id}" must match ${ID_RE.source}`);
    if (!types[f.type]) err('form.type', `form field "${f.id}" has unknown type "${f.type}"`);
    else if (types[f.type].proof) err('type.proof', `form field "${f.id}": a ${f.type} can only come from a part that proves it, not from the buyer`);
  }
  if ((recipe.form ?? []).length > 6) warn('form.long', 'SRS-1 recommends at most 6 form fields (one short form, no chat)');

  for (const [k, c] of Object.entries(recipe.consts ?? {})) {
    if (!ID_RE.test(k)) err('const.id', `constant name "${k}" must match ${ID_RE.source}`);
    if (!types[c.type]) { err('const.type', `constant "${k}" has unknown type "${c.type}"`); continue; }
    if (types[c.type].proof) err('type.proof', `constant "${k}": a ${c.type} can only come from a part that proves it`);
    const bad = checkValue(types, c.type, c.value);
    if (bad.length) err('const.value', `constant "${k}" is not a ${c.type}: ${bad.join('; ')}`);
  }

  // listing (SRS-1 §4): the contract enforces these too; catching them here keeps a creator from sealing a recipe that cannot be published
  const L = recipe.listing ?? ({} as Listing);
  if (!INT_RE.test(L.price_per_run ?? '') || BigInt(L.price_per_run) === 0n) err('listing.price', 'price_per_run must be a positive integer amount of the payment token');
  if (L.reserve_bps !== undefined && !(Number.isInteger(L.reserve_bps) && L.reserve_bps >= 0 && L.reserve_bps <= 10_000)) err('listing.reserve', 'reserve_bps must be an integer from 0 to 10000');
  if (L.bond !== undefined && !INT_RE.test(L.bond)) err('listing.bond', 'bond must be an integer amount of the payment token');
  if (L.pricing) {
    const { price_floor: f, price_ceiling: c, target_runs: t } = L.pricing;
    if (!INT_RE.test(f ?? '') || !INT_RE.test(c ?? '') || !(Number.isInteger(t) && t >= 1)) err('listing.pricing', 'pricing needs integer price_floor and price_ceiling and a target_runs of at least 1');
    else if (INT_RE.test(L.price_per_run ?? '') && !(BigInt(f) <= BigInt(L.price_per_run) && BigInt(L.price_per_run) <= BigInt(c))) err('listing.pricing', 'price_floor ≤ price_per_run ≤ price_ceiling');
  }
  if (L.settle_mode !== undefined && !['final', 'checkpoint'].includes(L.settle_mode)) err('listing.settle_mode', 'settle_mode is "final" or "checkpoint"');
  if (L.bill !== undefined && !['declared', 'executed'].includes(L.bill)) err('listing.bill', 'bill is "declared" or "executed"');
  const bill = L.bill ?? 'declared';

  const nodes = new Map<string, RecipeNode>();
  for (const n of recipe.nodes ?? []) {
    if (nodes.has(n.id)) err('node.duplicate', `duplicate node id "${n.id}"`, n.id);
    if (n.id === 'form' || n.id === 'const') err('node.reserved', `"${n.id}" is a reserved name`, n.id);
    else if (!ID_RE.test(n.id ?? '')) err('node.id', `node id "${n.id}" must match ${ID_RE.source}`, n.id);
    nodes.set(n.id, n);
  }
  if (nodes.size === 0) err('recipe.empty', 'a recipe needs at least one part');

  // ---- types of references, with type variables bound per node (SRS-1 §1.3)
  const binds = new Map<string, Record<string, string | null>>();
  const binding = new Set<string>();
  const refType = (ref: string): { type?: string; dep?: string; error?: string } => {
    const dot = ref.indexOf('.');
    if (typeof ref !== 'string' || dot < 1) return { error: `malformed reference "${ref}"` };
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
    const m = parts.get(n.part);
    if (!m) return { error: `node "${head}" uses unknown part` };
    const p = m.outputs[tail];
    if (!p) return { error: `part ${m.id} has no output "${tail}"` };
    if (!isVar(m, p.type)) return { type: p.type, dep: head };
    const t = bindOf(n)[p.type];
    return { type: t ?? m.type_params![p.type].extends ?? undefined, dep: head };
  };
  /** the types a binding may deliver (one per alternative that resolves) */
  const bindingTypes = (b: Binding) => refsOf(b).map((r) => refType(r).type).filter((t): t is string => !!t);
  function bindOf(n: RecipeNode): Record<string, string | null> {
    const memo = binds.get(n.id);
    if (memo) return memo;
    const m = parts.get(n.part)!;
    if (binding.has(n.id)) return {}; // cycle: reported as graph.cycle
    binding.add(n.id);
    const out: Record<string, string | null> = {};
    for (const T of Object.keys(m.type_params ?? {})) {
      const ts = Object.entries(m.inputs).filter(([, s]) => s.type === T).flatMap(([p]) => { const j = joinTypes(types, bindingTypes(n.inputs?.[p] ?? [])); return j ? [j] : []; });
      out[T] = joinTypes(types, ts);
    }
    binding.delete(n.id);
    binds.set(n.id, out);
    return out;
  }

  const deps = new Map<string, Set<string>>();
  const usedForm = new Set<string>();
  const portTypes: Record<string, string> = {};
  for (const n of nodes.values()) {
    deps.set(n.id, new Set());
    const m = parts.get(n.part);
    if (!m) { err('node.part', `unknown part "${n.part}"`, n.id); continue; }
    const tv = bindOf(n);
    for (const [T, t] of Object.entries(tv)) {
      const bound = m.type_params![T].extends;
      const wired = Object.entries(m.inputs).filter(([p, s]) => s.type === T && n.inputs?.[p] !== undefined);
      if (!wired.length) continue; // reported as port.unwired below
      if (!t) err('port.generic', `inputs typed ${T} (${wired.map(([p]) => p).join(', ')}) have no common type`, n.id, wired[0][0]);
      else if (bound && !isAssignable(types, t, bound)) err('port.type', `${T} is bound to ${t}, which is not a ${bound}`, n.id, wired[0][0]);
    }
    for (const [port, spec] of Object.entries(m.inputs)) {
      const b = n.inputs?.[port];
      const refs = refsOf(b);
      if (!refs.length) { err(Array.isArray(b) ? 'port.alternatives' : 'port.unwired', Array.isArray(b) ? `input "${port}" lists no alternatives` : `input "${port}" (${spec.type}) is not connected`, n.id, port); continue; }
      if (Array.isArray(b)) {
        if (new Set(b).size !== b.length) err('port.alternatives', `input "${port}" lists the same reference twice`, n.id, port);
      }
      for (const ref of refs) {
        const r = refType(ref);
        if (r.error) { err('port.ref', r.error, n.id, port); continue; }
        if (ref.startsWith('form.')) usedForm.add(ref.slice(5));
        if (r.dep) deps.get(n.id)!.add(r.dep);
        if (r.type && !isVar(m, spec.type) && !isAssignable(types, r.type, spec.type)) err('port.type', `"${port}" expects ${spec.type} but ${ref} is ${r.type}`, n.id, port);
      }
    }
    for (const port of Object.keys(n.inputs ?? {})) {
      if (!m.inputs[port]) warn('port.extra', `part ${m.id} has no input "${port}"`, n.id, port);
    }
    for (const [k, spec] of Object.entries(m.params)) {
      if (n.params?.[k] === undefined && spec.default === undefined && spec.secret) {
        warn('param.missing', `param "${k}" not set; part default behaviour applies`, n.id);
      }
    }
    for (const [p, s] of Object.entries(m.outputs)) { const t = isVar(m, s.type) ? tv[s.type] ?? m.type_params![s.type].extends : s.type; if (t) portTypes[`${n.id}.${p}`] = t; }

    // secret params and where they can go (SRS-1 §5.4)
    const secretsSet = Object.entries(m.params).filter(([k, s]) => s.secret && n.params?.[k] !== undefined).map(([k]) => k);
    const egress = m.capabilities.filter((c) => c.startsWith('net:')).map((c) => c.slice(4)).filter((h) => !CONFIDENTIAL_HOSTS.includes(h));
    if (secretsSet.length && egress.length) warn('param.secret-egress', `${m.id} can send data to ${egress.join(', ')}: the values of ${secretsSet.join(', ')} may leave the runner`, n.id);

    // conditions (SRS-1 §3.2)
    if (n.when !== undefined) {
      const w = n.when;
      const tests = [w.is !== undefined, w.match !== undefined, w.some !== undefined].filter(Boolean).length;
      if (tests > 1 || (w.is !== undefined && !['nonempty', 'empty'].includes(w.is))) err('when.shape', 'a condition has one test: is ("nonempty" | "empty"), match or some', n.id);
      const r = refType(w.ref ?? '');
      if (r.error) err('when.ref', `condition: ${r.error}`, n.id);
      else {
        if (r.dep) deps.get(n.id)!.add(r.dep);
        if ((w.ref ?? '').startsWith('form.')) usedForm.add(w.ref.slice(5));
        const m2 = w.match ?? w.some;
        if (m2) {
          if (!Object.keys(m2).length || Object.values(m2).some((vals) => !Array.isArray(vals) || !vals.length)) err('when.shape', 'match and some list at least one field, each with at least one value', n.id);
          const sc = r.type ? schemaOf(types, r.type) : undefined;
          const obj = w.some ? (sc?.type === 'array' ? sc.items : undefined) : sc;
          if (!sc) warn('when.unchecked', `${r.type} declares no schema, so the fields in this condition cannot be checked`, n.id);
          else if (w.some && sc.type !== 'array') err('when.shape', `"some" needs a list, but ${w.ref} is a ${r.type}`, n.id);
          else if (w.match && sc.type !== 'object') err('when.shape', `"match" needs an object, but ${w.ref} is a ${r.type}`, n.id);
          else if (obj?.properties) for (const [f, vals] of Object.entries(m2)) {
            const fs = obj.properties[f];
            if (!fs) err('when.field', `${r.type} has no field "${f}"`, n.id);
            else if (fs.enum && Array.isArray(vals)) for (const x of vals) if (!fs.enum.includes(x)) err('when.value', `"${f}" is never ${JSON.stringify(x)} (one of ${fs.enum.join(', ')})`, n.id);
          }
        }
      }
    }
    if (n.on_error !== undefined) {
      if (!['fail', 'skip'].includes(n.on_error)) err('node.on_error', 'on_error is "fail" or "skip"', n.id);
      else if (n.on_error === 'skip' && m.capabilities.includes('wallet:approve')) err('node.on_error', `${m.id} asks the buyer to sign: if it fails, funds may already have moved, so the run must stop (on_error: "skip" is not allowed)`, n.id);
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
  if (order.length !== nodes.size) err('graph.cycle', 'parts form a cycle; SRS-1 recipes must be acyclic');

  // which nodes may be skipped at run time (SRS-1 §3.5): static over-approximation in execution order
  // A fallback pair [a, b] is always present when b runs exactly when a's value is absent or empty and b cannot skip otherwise.
  const optional = new Set<string>();
  const nodeOf = (r: string) => r.split('.')[0];
  const fallbackFor = (bId: string, aId: string): boolean => {
    const bn = nodes.get(bId), w = bn?.when;
    return !!bn && !!w && !w.not && !w.match && !w.some && w.is === 'empty' && nodeOf(w.ref) === aId && bn.on_error !== 'skip'
      && Object.values(bn.inputs ?? {}).every((x) => refsOf(x).length > 0 && !mayBeAbsent(x));
  };
  // if / else: the same test on the same value, one negated; when neither can skip otherwise, exactly one runs
  const onlyCondition = (n: RecipeNode | undefined) => !!n && n.on_error !== 'skip' && Object.values(n.inputs ?? {}).every((x) => refsOf(x).length > 0 && !mayBeAbsent(x));
  const sameTest = (x: When, y: When) => canonicalTest(x) === canonicalTest(y) && !!x.not !== !!y.not;
  const complementary = (aId: string, bId: string): boolean => {
    const an = nodes.get(aId), bn = nodes.get(bId);
    return !!an?.when && !!bn?.when && an.when.ref === bn.when.ref && sameTest(an.when, bn.when) && onlyCondition(an) && onlyCondition(bn);
  };
  function mayBeAbsent(b: Binding): boolean {
    const refs = refsOf(b);
    if (!refs.every((r) => optional.has(nodeOf(r)))) return false;
    return !refs.some((ra) => refs.some((rb) => rb !== ra && (fallbackFor(nodeOf(rb), nodeOf(ra)) || complementary(nodeOf(ra), nodeOf(rb)))));
  }
  if (order.length === nodes.size) for (const id of order) {
    const n = nodes.get(id)!;
    if (n.when || n.on_error === 'skip' || Object.values(n.inputs ?? {}).some((b) => refsOf(b).length > 0 && mayBeAbsent(b))) optional.add(id);
  }

  let outputType: string | undefined;
  const outs = refsOf(recipe.output);
  if (!outs.length) err('recipe.output', 'output: the recipe needs a result');
  const outTypes: string[] = [];
  for (const o of outs) { const r = refType(o ?? ''); if (r.error) err('recipe.output', `output: ${r.error}`); else if (r.type) outTypes.push(r.type); }
  if (outs.length && outTypes.length === outs.length) {
    const j = joinTypes(types, outTypes);
    if (!j) err('recipe.output', 'output: the alternatives have no common type'); else outputType = j;
  }
  if (outs.length && mayBeAbsent(recipe.output)) warn('recipe.output-optional', 'on runs where the result is skipped there is no result: the run fails and the buyer is refunded. List a fallback as an alternative.');
  if (optional.size && bill === 'executed') warn('bill.reveals-branch', 'bill "executed" pays only the parts that ran, so each settlement shows on-chain which branch ran for that buyer');

  // dead-end nodes (outputs consumed by nothing and not the recipe output)
  const consumed = new Set<string>();
  for (const n of nodes.values()) {
    for (const b of Object.values(n.inputs ?? {})) for (const ref of refsOf(b)) consumed.add(ref.split('.')[0]);
    if (n.when?.ref) consumed.add(n.when.ref.split('.')[0]);
  }
  for (const o of outs) consumed.add((o ?? '').split('.')[0]);
  for (const n of nodes.values()) if (!consumed.has(n.id)) warn('node.deadend', `output of "${n.id}" is never used (you still pay its fee)`, n.id);

  const partsUsed = order.map((id) => nodes.get(id)!.part).filter((b) => parts.has(b));
  const capabilities = [...new Set(partsUsed.flatMap((b) => parts.get(b)!.capabilities))].sort();
  const partFees = partsUsed.reduce((s, b) => s + BigInt(parts.get(b)!.fee_per_call), 0n);
  const risk = maxRisk(partsUsed.map((b) => (parts.get(b)!.disclosure ? withdrawalRisk(parts.get(b)!.disclosure) : 'high')));
  for (const id of new Set(partsUsed)) if (parts.get(id)!.disclosure?.model.kind === 'closed') warn('part.closed-model', `${id} runs on a closed model: its provider can withdraw or reprice it at any time (high withdrawal risk)`);

  return { ok: !d.some((x) => x.severity === 'error'), diagnostics: d, order, partsUsed, capabilities, partFees, outputType, risk, portTypes, optional: order.filter((id) => optional.has(id)), bill };
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
  pricing: { price_floor: string; price_ceiling: string; target_runs: number } | null;
  reserve_bps: number;
  interface_hash: string;
  risk: Risk;
  disclosures: { part: string; model: Disclosure['model']; runtime: Disclosure['runtime']; risk: Risk }[];
  privacy: 'confidential' | 'public' | 'n/a';
}

/**
 * The trust labels a buyer sees, derived from part ids alone (never from what a creator says about the recipe).
 * The marketplace recomputes these from the on-chain `parts`, and the runner refuses to execute a sealed recipe
 * whose parts differ from the on-chain list, so a creator cannot make a closed-model recipe look low-risk.
 */
export function labelsFromParts(partIds: string[], catalog: Catalog): Pick<PublicListing, 'risk' | 'disclosures' | 'privacy'> & { capabilities: string[] } {
  const parts = partIndex(catalog);
  const ids = [...new Set(partIds)];
  const ms = ids.map((id) => { const m = parts.get(id); if (!m) throw new Error(`unknown part ${id}`); return m; });
  const capabilities = [...new Set(ms.flatMap((m) => m.capabilities ?? []))].sort();
  return {
    risk: maxRisk(ms.map((m) => withdrawalRisk(m.disclosure))),
    disclosures: ms.map((m) => ({ part: m.id, model: m.disclosure.model, runtime: m.disclosure.runtime, risk: withdrawalRisk(m.disclosure) })),
    privacy: capabilities.includes('wallet:approve') ? (ids.some((b) => b.startsWith('intents.confidential-swap')) ? 'confidential' : 'public') : 'n/a',
    capabilities,
  };
}

export function publicListing(recipe: Recipe, catalog: Catalog): PublicListing {
  const parts = partIndex(catalog);
  const v = validateRecipe(recipe, catalog);
  if (!v.ok) throw new Error('cannot list an invalid recipe: ' + v.diagnostics.filter((x) => x.severity === 'error').map((x) => x.message).join('; '));
  // SRS-1 §5.3: parts are published as a sorted multiset. Execution order is part of the sealed method.
  const sortedParts = [...v.partsUsed].sort();
  const iface = { form: recipe.form, parts: sortedParts, output_type: v.outputType };
  return {
    ticker: recipe.meta.ticker,
    name: recipe.meta.name,
    creator: recipe.meta.creator,
    description: recipe.meta.description,
    form: recipe.form,
    parts: sortedParts,
    capabilities: v.capabilities,
    output_type: v.outputType!,
    price_per_run: recipe.listing.price_per_run,
    pricing: recipe.listing.pricing ?? null,
    reserve_bps: recipe.listing.reserve_bps ?? 0,
    interface_hash: hashObject(iface),
    risk: v.risk,
    disclosures: [...new Set(v.partsUsed)].map((id) => { const m = parts.get(id)!; return { part: id, model: m.disclosure.model, runtime: m.disclosure.runtime, risk: withdrawalRisk(m.disclosure) }; }),
    privacy: v.capabilities.includes('wallet:approve') ? (v.partsUsed.some((b) => b.startsWith('intents.confidential-swap')) ? 'confidential' : 'public') : 'n/a',
  };
}

/**
 * Parts that can replace `nodeId`'s part without rewiring: the candidate has an existing wire for every input it
 * declares, still provides every output the recipe consumes from this node, and substituting it introduces no new
 * validation error (so every wired input is still accepted, contravariantly, and every consumer still accepts the
 * new output types, covariantly, with type variables bound as usual).
 */
export function compatibleSwaps(recipe: Recipe, nodeId: string, catalog: Catalog): PartManifest[] {
  const node = recipe.nodes.find((n) => n.id === nodeId);
  if (!node) return [];
  const parts = partIndex(catalog);
  const current = parts.get(node.part);
  if (!current) return [];
  const consumedPorts = new Set<string>();
  const reads = (b: Binding) => refsOf(b).filter((r) => r.startsWith(nodeId + '.')).map((r) => r.slice(nodeId.length + 1));
  for (const n of recipe.nodes) {
    for (const b of Object.values(n.inputs)) for (const p of reads(b)) consumedPorts.add(p);
    if (n.when) for (const p of reads(n.when.ref)) consumedPorts.add(p);
  }
  for (const p of reads(recipe.output)) consumedPorts.add(p);
  const key = (x: Diagnostic) => `${x.code}|${x.node ?? ''}|${x.port ?? ''}|${x.message}`;
  const before = new Set(validateRecipe(recipe, catalog).diagnostics.filter((x) => x.severity === 'error').map(key));
  return catalog.parts.filter((cand) => {
    if (cand.id === current.id) return false;
    if (Object.keys(cand.inputs).some((p) => node.inputs[p] === undefined)) return false;
    if ([...consumedPorts].some((p) => !cand.outputs[p])) return false;
    const after = validateRecipe(substitute(recipe, nodeId, cand), catalog).diagnostics.filter((x) => x.severity === 'error');
    return after.every((x) => before.has(key(x)));
  });
}

function substitute(recipe: Recipe, nodeId: string, cand: PartManifest): Recipe {
  return {
    ...recipe,
    nodes: recipe.nodes.map((n) => {
      if (n.id !== nodeId) return n;
      const params: Record<string, unknown> = {};
      for (const [k, spec] of Object.entries(cand.params)) params[k] = n.params?.[k] ?? spec.default;
      const inputs: Record<string, Binding> = {};
      for (const k of Object.keys(cand.inputs)) inputs[k] = n.inputs[k];
      return { ...n, part: cand.id, params, inputs };
    }),
  };
}

export function swapPart(recipe: Recipe, nodeId: string, newPartId: string, catalog: Catalog): Recipe {
  const cand = partIndex(catalog).get(newPartId);
  if (!cand) throw new Error('unknown part ' + newPartId);
  if (!compatibleSwaps(recipe, nodeId, catalog).some((b) => b.id === newPartId)) throw new Error(`${newPartId} is not a drop-in replacement for node ${nodeId}`);
  return substitute(recipe, nodeId, cand);
}
