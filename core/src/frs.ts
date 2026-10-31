/**
 * FRS-1 (Fungible Recipe Standard) — the no-code / low-code composition standard.
 * A block declares typed ports; a recipe wires blocks into a DAG. This module
 * validates recipes, type-checks wiring, computes cost/capabilities, derives the
 * public listing (what a marketplace may see) and finds drop-in block swaps.
 */
import { hashObject } from './canonical.js';

export type PortSpec = { type: string; description?: string };
export type ParamSpec = { type: string; default?: unknown; secret?: boolean; description?: string };

export interface BlockManifest {
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
}

export interface TypeDef { description: string; extends: string | null }

export interface Catalog { frs: '1.0'; kind: 'block-catalog'; types: Record<string, TypeDef>; blocks: BlockManifest[] }

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
  block: string;
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
  listing: { price_per_run: string; royalty_bps: number; total_shares: string };
}

export type Severity = 'error' | 'warning';
export interface Diagnostic { severity: Severity; code: string; message: string; node?: string; port?: string }

export interface ValidationResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  order: string[]; // topological execution order
  blocksUsed: string[]; // block ids, one per node, in execution order
  capabilities: string[];
  blockFees: bigint;
  outputType?: string;
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

export function blockIndex(catalog: Catalog): Map<string, BlockManifest> {
  return new Map(catalog.blocks.map((b) => [b.id, b]));
}

function resolveRefType(
  ref: string,
  recipe: Recipe,
  nodes: Map<string, RecipeNode>,
  blocks: Map<string, BlockManifest>,
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
  const b = blocks.get(n.block);
  if (!b) return { error: `node "${head}" uses unknown block` };
  const p = b.outputs[tail];
  return p ? { type: p.type, dep: head } : { error: `block ${b.id} has no output "${tail}"` };
}

export function validateRecipe(recipe: Recipe, catalog: Catalog): ValidationResult {
  const d: Diagnostic[] = [];
  const blocks = blockIndex(catalog);
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
  if (nodes.size === 0) err('recipe.empty', 'a recipe needs at least one block');

  const deps = new Map<string, Set<string>>();
  const usedForm = new Set<string>();
  for (const n of nodes.values()) {
    deps.set(n.id, new Set());
    const b = blocks.get(n.block);
    if (!b) { err('node.block', `unknown block "${n.block}"`, n.id); continue; }
    for (const [port, spec] of Object.entries(b.inputs)) {
      const ref = n.inputs?.[port];
      if (!ref) { err('port.unwired', `input "${port}" (${spec.type}) is not connected`, n.id, port); continue; }
      const r = resolveRefType(ref, recipe, nodes, blocks);
      if (r.error) { err('port.ref', r.error, n.id, port); continue; }
      if (ref.startsWith('form.')) usedForm.add(ref.slice(5));
      if (r.dep) deps.get(n.id)!.add(r.dep);
      if (r.type && !isAssignable(types, r.type, spec.type)) {
        err('port.type', `"${port}" expects ${spec.type} but ${ref} is ${r.type}`, n.id, port);
      }
    }
    for (const port of Object.keys(n.inputs ?? {})) {
      if (!b.inputs[port]) warn('port.extra', `block ${b.id} has no input "${port}"`, n.id, port);
    }
    for (const [k, spec] of Object.entries(b.params)) {
      if (n.params?.[k] === undefined && spec.default === undefined && spec.secret) {
        warn('param.missing', `param "${k}" not set; block default behaviour applies`, n.id);
      }
    }
  }
  for (const f of formIds) if (!usedForm.has(f)) warn('form.unused', `form field "${f}" is not used by any block`);

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
  if (order.length !== nodes.size) err('graph.cycle', 'blocks form a cycle; FRS-1 recipes must be acyclic');

  let outputType: string | undefined;
  const o = resolveRefType(recipe.output ?? '', recipe, nodes, blocks);
  if (o.error) err('recipe.output', `output: ${o.error}`); else outputType = o.type;

  // dead-end nodes (outputs consumed by nothing and not the recipe output)
  const consumed = new Set<string>();
  for (const n of nodes.values()) for (const ref of Object.values(n.inputs ?? {})) consumed.add(ref.split('.')[0]);
  consumed.add((recipe.output ?? '').split('.')[0]);
  for (const n of nodes.values()) if (!consumed.has(n.id)) warn('node.deadend', `output of "${n.id}" is never used (you still pay its fee)`, n.id);

  const blocksUsed = order.map((id) => nodes.get(id)!.block).filter((b) => blocks.has(b));
  const capabilities = [...new Set(blocksUsed.flatMap((b) => blocks.get(b)!.capabilities))].sort();
  const blockFees = blocksUsed.reduce((s, b) => s + BigInt(blocks.get(b)!.fee_per_call), 0n);

  return { ok: !d.some((x) => x.severity === 'error'), diagnostics: d, order, blocksUsed, capabilities, blockFees, outputType };
}

/** What the marketplace and chain are allowed to see. Wiring and params stay sealed. */
export interface PublicListing {
  ticker: string;
  name: string;
  creator: string;
  description: string;
  form: FormField[];
  blocks: string[];
  capabilities: string[];
  output_type: string;
  price_per_run: string;
  royalty_bps: number;
  total_shares: string;
  interface_hash: string;
}

export function publicListing(recipe: Recipe, catalog: Catalog): PublicListing {
  const v = validateRecipe(recipe, catalog);
  if (!v.ok) throw new Error('cannot list an invalid recipe: ' + v.diagnostics.filter((x) => x.severity === 'error').map((x) => x.message).join('; '));
  const iface = { form: recipe.form, blocks: v.blocksUsed, output_type: v.outputType };
  return {
    ticker: recipe.meta.ticker,
    name: recipe.meta.name,
    creator: recipe.meta.creator,
    description: recipe.meta.description,
    form: recipe.form,
    blocks: v.blocksUsed,
    capabilities: v.capabilities,
    output_type: v.outputType!,
    price_per_run: recipe.listing.price_per_run,
    royalty_bps: recipe.listing.royalty_bps,
    total_shares: recipe.listing.total_shares,
    interface_hash: hashObject(iface),
  };
}

/**
 * Blocks that can replace `nodeId`'s block without rewiring: every currently-wired
 * input must still be accepted (contravariant) and every output that downstream
 * nodes consume must still exist with an assignable type (covariant).
 */
export function compatibleSwaps(recipe: Recipe, nodeId: string, catalog: Catalog): BlockManifest[] {
  const node = recipe.nodes.find((n) => n.id === nodeId);
  if (!node) return [];
  const blocks = blockIndex(catalog);
  const current = blocks.get(node.block);
  if (!current) return [];
  const nodes = new Map(recipe.nodes.map((n) => [n.id, n]));
  const consumedPorts = new Set<string>();
  for (const n of recipe.nodes) for (const ref of Object.values(n.inputs)) if (ref.startsWith(nodeId + '.')) consumedPorts.add(ref.slice(nodeId.length + 1));
  if (recipe.output.startsWith(nodeId + '.')) consumedPorts.add(recipe.output.slice(nodeId.length + 1));

  return catalog.blocks.filter((cand) => {
    if (cand.id === current.id) return false;
    for (const [port, spec] of Object.entries(cand.inputs)) {
      const ref = node.inputs[port];
      if (!ref) return false;
      const r = resolveRefType(ref, recipe, nodes, blocks);
      if (!r.type || !isAssignable(catalog.types, r.type, spec.type)) return false;
    }
    for (const port of consumedPorts) {
      const out = cand.outputs[port];
      const curOut = current.outputs[port];
      if (!out || !curOut) return false;
      // every downstream consumer must still accept the new type
      for (const n of recipe.nodes) {
        const b = blocks.get(n.block);
        for (const [p, ref] of Object.entries(n.inputs)) {
          if (ref === `${nodeId}.${port}` && b && !isAssignable(catalog.types, out.type, b.inputs[p]?.type ?? out.type)) return false;
        }
      }
    }
    return true;
  });
}

export function swapBlock(recipe: Recipe, nodeId: string, newBlockId: string, catalog: Catalog): Recipe {
  const cand = blockIndex(catalog).get(newBlockId);
  if (!cand) throw new Error('unknown block ' + newBlockId);
  if (!compatibleSwaps(recipe, nodeId, catalog).some((b) => b.id === newBlockId)) throw new Error(`${newBlockId} is not a drop-in replacement for node ${nodeId}`);
  return {
    ...recipe,
    nodes: recipe.nodes.map((n) => {
      if (n.id !== nodeId) return n;
      const params: Record<string, unknown> = {};
      for (const [k, spec] of Object.entries(cand.params)) params[k] = n.params[k] ?? spec.default;
      const inputs: Record<string, string> = {};
      for (const k of Object.keys(cand.inputs)) inputs[k] = n.inputs[k];
      return { ...n, block: newBlockId, params, inputs };
    }),
  };
}
