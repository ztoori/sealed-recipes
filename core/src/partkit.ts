/**
 * Builder kit for the no-code composer and the part builder:
 *  - blankRecipe / addPartAutoWired / sourcesFor / addBuyerField: compose a recipe by adding parts; inputs are wired
 *    automatically to the best type-compatible source (asking the buyer when nothing earlier provides a value),
 *    and every wire can be changed afterwards;
 *  - validatePartManifest: SRS-1 §2 conformance of a part manifest (the same rules the catalog's parts pass);
 *  - lintPartSource: static checks on a part's TypeScript source against its manifest. These catch common mistakes;
 *    they are not a sandbox. A part only runs after it is reviewed and shipped in an audited runner release.
 */
import { isAssignable, partIndex, type Catalog, type Diagnostic, type FormField, type PartManifest, type Recipe } from './srs.js';

// ---------------------------------------------------------------- composing

/** A blank recipe: no parts and an empty buyer form. The form grows as parts ask for values nothing else provides. */
export function blankRecipe(creator: string): Recipe {
  return { srs: '1.0', kind: 'recipe', meta: { ticker: '', name: '', creator, description: '' }, form: [], nodes: [], output: '',
    listing: { price_per_run: '500000', reserve_bps: 1000, bond: '10000000', pricing: { price_floor: '300000', price_ceiling: '1500000', target_runs: 2 } } };
}

export interface Source { ref: string; type: string; label: string; kind: 'node' | 'form' | 'const' }

/** Every value available to `nodeId`'s inputs: buyer form fields, constants, and outputs of nodes that do not depend on it. */
export function sourcesFor(recipe: Recipe, nodeId: string | null, catalog: Catalog): Source[] {
  const parts = partIndex(catalog);
  const downstream = new Set<string>();
  if (nodeId) {
    const stack = [nodeId];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const n of recipe.nodes) if (!downstream.has(n.id) && Object.values(n.inputs).some((r) => r.startsWith(cur + '.'))) { downstream.add(n.id); stack.push(n.id); }
    }
  }
  const out: Source[] = [];
  // most recently added nodes first: the natural "previous step"
  for (const n of [...recipe.nodes].reverse()) {
    if (n.id === nodeId || downstream.has(n.id)) continue;
    const m = parts.get(n.part); if (!m) continue;
    for (const [p, s] of Object.entries(m.outputs)) out.push({ ref: `${n.id}.${p}`, type: s.type, label: `${m.name} → ${p}`, kind: 'node' });
  }
  for (const f of recipe.form) out.push({ ref: `form.${f.id}`, type: f.type, label: `Buyer: ${f.label}`, kind: 'form' });
  for (const [k, c] of Object.entries(recipe.consts ?? {})) out.push({ ref: `const.${k}`, type: c.type, label: `Fixed: ${k}`, kind: 'const' });
  return out;
}

/** The source auto-wiring picks for a port: exact type before subtype; the previous step before the buyer form. */
export function bestSource(recipe: Recipe, nodeId: string, type: string, catalog: Catalog): Source | undefined {
  const cands = sourcesFor(recipe, nodeId, catalog).filter((s) => isAssignable(catalog.types, s.type, type));
  return cands.find((s) => s.type === type) ?? cands[0];
}

/**
 * Types a buyer can type into a form (SRS-1 §4). Anything else (holdings, plans, receipts) has to come from a part.
 * Each has a default field id and label, so a value asked from the buyer reads well without editing.
 */
export const BUYER_TYPES: Record<string, { id: string; label: string; placeholder?: string }> = {
  'near.account': { id: 'wallet', label: 'Wallet', placeholder: 'bob.testnet' },
  'address.near': { id: 'recipient', label: 'Send to' },
  'asset.id': { id: 'target', label: 'Asset' },
  usd: { id: 'amount_usd', label: 'Amount (USD)' },
  percent: { id: 'percent', label: 'Percentage' },
};

/**
 * Adds a buyer form field of `type`, or returns the existing one of that type when `reuse` is set.
 * Ids are unique and lower_snake_case; a NEAR recipient defaults to a fresh address generated in the buyer's browser.
 */
export function addBuyerField(recipe: Recipe, type: string, opts: { id?: string; label?: string; reuse?: boolean } = {}): { recipe: Recipe; fieldId: string } {
  if (opts.reuse) { const f = recipe.form.find((x) => x.type === type); if (f) return { recipe, fieldId: f.id }; }
  const d = BUYER_TYPES[type] ?? { id: 'value', label: 'Value' };
  const base = (opts.id ?? d.id).toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^[^a-z_]+/, '') || 'value';
  let id = base, i = 2; while (recipe.form.some((f) => f.id === id)) id = `${base}_${i++}`;
  const field: FormField = { id, label: opts.label ?? d.label, type, ...(d.placeholder ? { placeholder: d.placeholder } : {}),
    ...(type === 'near.account' ? { required: true } : {}),
    ...(type === 'address.near' ? { required: true, generator: 'fresh-implicit' as const, label: opts.label ?? 'Fresh address (generated in your browser)' } : {}) };
  return { recipe: { ...recipe, form: [...recipe.form, field] }, fieldId: id };
}

const nodeIdFor = (m: PartManifest, taken: Set<string>) => {
  const base = m.id.split('@')[0].split('.').pop()!.replace(/[^a-z]/g, '').slice(0, 14) || 'step';
  let id = base, i = 2; while (taken.has(id) || id === 'form' || id === 'const') id = base + i++;
  return id;
};

/**
 * Adds a part and wires each of its inputs to the best compatible source. With `askBuyer`, an input nothing earlier
 * provides becomes a buyer form field (when a buyer can type that type). The newest part at the end of the chain
 * becomes the recipe's result: it takes over when the current result feeds it, or when there is none yet.
 * Returns the new recipe, the node id, the inputs still unwired and the buyer fields added.
 */
export function addPartAutoWired(recipe: Recipe, partId: string, catalog: Catalog, opts: { ui?: { x: number; y: number }; askBuyer?: boolean } = {}): { recipe: Recipe; nodeId: string; unwired: string[]; asked: string[] } {
  const { ui } = opts;
  const m = partIndex(catalog).get(partId); if (!m) throw new Error('unknown part ' + partId);
  const id = nodeIdFor(m, new Set(recipe.nodes.map((n) => n.id)));
  const params = Object.fromEntries(Object.entries(m.params).map(([k, s]) => [k, s.default ?? (s.type === 'number' ? 0 : s.type === 'string[]' ? [] : '')]));
  let draft: Recipe = { ...recipe, nodes: [...recipe.nodes, { id, part: partId, inputs: {}, params, ui: ui ?? { x: recipe.nodes.length * 270, y: 120 } }] };
  const inputs: Record<string, string> = {};
  const unwired: string[] = [];
  const asked: string[] = [];
  for (const [port, spec] of Object.entries(m.inputs)) {
    const s = bestSource(draft, id, spec.type, catalog);
    if (s) inputs[port] = s.ref;
    else if (opts.askBuyer && BUYER_TYPES[spec.type]) {
      const a = addBuyerField(draft, spec.type, spec.type === 'near.account' || spec.type === 'address.near' ? {} : { id: port, label: humanize(port) });
      draft = a.recipe; inputs[port] = `form.${a.fieldId}`; asked.push(a.fieldId);
    } else unwired.push(port);
  }
  const nodes = draft.nodes.map((n) => (n.id === id ? { ...n, inputs } : n));
  const outPort = Object.keys(m.outputs)[0];
  const resultNode = draft.output.split('.')[0];
  const takesOver = !draft.output || Object.values(inputs).some((r) => r.split('.')[0] === resultNode);
  return { recipe: { ...draft, nodes, output: takesOver && outPort ? `${id}.${outPort}` : draft.output }, nodeId: id, unwired, asked };
}

const humanize = (port: string) => { const t = port.replace(/_usd$/, ' (USD)').replace(/_/g, ' '); return t.charAt(0).toUpperCase() + t.slice(1); };

/** Parts that could come next: every input can be fed from what the recipe already has. Ranked by usefulness. */
export function suggestNext(recipe: Recipe, catalog: Catalog): PartManifest[] {
  const have = sourcesFor(recipe, null, catalog);
  const used = new Set(recipe.nodes.map((n) => n.part));
  const feeds = (m: PartManifest) => Object.values(m.inputs).every((s) => have.some((h) => isAssignable(catalog.types, h.type, s.type)));
  const consumesNew = (m: PartManifest) => Object.values(m.inputs).some((s) => have.some((h) => h.kind === 'node' && isAssignable(catalog.types, h.type, s.type)));
  // every input can be fed: from what the recipe already has, or by asking the buyer
  const askable = (m: PartManifest) => Object.values(m.inputs).every((s) => have.some((h) => isAssignable(catalog.types, h.type, s.type)) || !!BUYER_TYPES[s.type]);
  return catalog.parts
    .filter((m) => !used.has(m.id) && askable(m) && (recipe.nodes.length ? consumesNew(m) : m.category === 'source'))
    .map((m) => ({ m, score: (feeds(m) ? 2 : 0) + (m.category === 'action' || m.category === 'sink' ? 1 : 0) }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.m);
}

// ---------------------------------------------------------------- part manifests (SRS-1 §2)

const CATEGORIES = ['source', 'guard', 'transform', 'action', 'sink'];
const PARAM_TYPES = ['string', 'number', 'string[]', 'boolean'];
const LAYERS = ['open', 'sealed', 'closed'];

export function validatePartManifest(m: PartManifest, catalog: Catalog, opts: { isNew?: boolean } = {}): Diagnostic[] {
  const d: Diagnostic[] = [];
  const err = (code: string, message: string, port?: string) => d.push({ severity: 'error', code, message, port });
  const warn = (code: string, message: string, port?: string) => d.push({ severity: 'warning', code, message, port });
  if (!/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+@\d+\.\d+\.\d+$/.test(m.id ?? '')) err('id', 'id must be <namespace>.<name>@<major>.<minor>.<patch>, e.g. "acme.price-guard@1.0.0"');
  else if (m.id.length > 64) err('id', 'id is registered on-chain and must be at most 64 characters');
  if (opts.isNew && catalog.parts.some((p) => p.id === m.id)) err('id.taken', `${m.id} is already registered: bump the version or choose another name`);
  if (!m.name?.trim()) err('name', 'name is required'); else if (m.name.length > 40) warn('name', 'names over 40 characters are cut off in the palette');
  if (!CATEGORIES.includes(m.category)) err('category', `category must be one of ${CATEGORIES.join(', ')}`);
  if (!/^[a-z0-9._-]{2,64}$/.test(m.author ?? '')) err('author', 'author must be the NEAR account that is paid the fee');
  if ((m.summary ?? '').trim().length < 20) err('summary', 'summary must say in one sentence what the part does (at least 20 characters)');
  const portRe = /^[a-z_][a-z0-9_]*$/;
  for (const [kind, ports] of [['input', m.inputs], ['output', m.outputs]] as const) {
    for (const [p, s] of Object.entries(ports ?? {})) {
      if (!portRe.test(p)) err('port.name', `${kind} "${p}": port names are lower_snake_case`, p);
      if (!catalog.types[s.type]) err('port.type', `${kind} "${p}" has unknown type "${s.type}": use a type from the spec or propose a new one`, p);
    }
  }
  if (!Object.keys(m.outputs ?? {}).length) err('outputs', 'a part must produce at least one output');
  if (m.category !== 'source' && !Object.keys(m.inputs ?? {}).length) warn('inputs', 'only sources usually have no inputs');
  for (const [k, s] of Object.entries(m.params ?? {})) {
    if (!portRe.test(k)) err('param.name', `param "${k}": names are lower_snake_case`);
    if (!PARAM_TYPES.includes(s.type)) err('param.type', `param "${k}" type must be one of ${PARAM_TYPES.join(', ')}`);
  }
  const caps = m.capabilities ?? [];
  for (const c of caps) {
    if (c === 'wallet:approve') continue;
    if (!/^net:[a-z0-9.-]+\.[a-z]{2,}$/.test(c)) err('capability', `capability "${c}" must be net:<host> or wallet:approve`);
  }
  if (caps.includes('wallet:approve') && m.category !== 'action') err('capability.wallet', 'only action parts may ask the buyer to sign (wallet:approve)');
  if (m.category === 'action' && !caps.includes('wallet:approve')) warn('capability.wallet', 'action parts that move funds need wallet:approve');
  if (!/^\d+$/.test(m.fee_per_call ?? '')) err('fee', 'fee_per_call is an integer amount of the payment token (USDC has 6 decimals: 10000 = $0.01)');
  else if (BigInt(m.fee_per_call) > 5_000_000n) warn('fee', 'fees above $5 per call price most recipes out of the market');
  const ds = m.disclosure;
  if (!ds) err('disclosure', 'SRS-1 §2.1: every part must disclose its model, layers and runtime');
  else {
    if (!['none', 'open-weights', 'closed'].includes(ds.model?.kind)) err('disclosure.model', 'model.kind must be none, open-weights or closed');
    if (ds.model?.kind !== 'none' && !ds.model?.name) err('disclosure.model', 'a part that uses a model must name it');
    for (const l of ['instructions', 'harness', 'verification'] as const) if (!LAYERS.includes(ds[l])) err('disclosure.layer', `${l} must be open, sealed or closed`);
    if (!['bundled', 'remote'].includes(ds.runtime)) err('disclosure.runtime', 'runtime must be bundled or remote');
    if (ds.model?.kind === 'closed') warn('disclosure.closed', 'closed models carry high withdrawal risk: recipes using this part will be labelled high risk');
    if (ds.model?.kind !== 'none' && !caps.some((c) => c.startsWith('net:'))) err('capability.model', 'a part that calls a model must declare the model host as a net: capability');
  }
  const l = m.limits;
  if (!l) err('limits', 'SRS-1 §2.2: every part must declare per-run limits');
  else {
    if (!(l.max_ms > 0 && l.max_ms <= 600_000)) err('limits.ms', 'max_ms must be between 1 and 600000');
    if (!(l.max_http_calls >= 0)) err('limits.http', 'max_http_calls must be 0 or more');
    if (l.max_http_calls > 0 && !caps.some((c) => c.startsWith('net:'))) err('limits.http', 'HTTP calls need at least one net: capability');
    if (!(l.max_output_bytes > 0 && l.max_output_bytes <= 1_000_000)) err('limits.out', 'max_output_bytes must be between 1 and 1000000');
    if (ds?.model?.kind !== 'none' && !(l.max_model_calls > 0)) err('limits.model', 'a part that calls a model needs max_model_calls ≥ 1');
  }
  return d;
}

// ---------------------------------------------------------------- part source (static checks)

/** Static checks of a part's source against its manifest. Not a sandbox: review and the runner's enforcement are. */
export function lintPartSource(src: string, m: PartManifest): Diagnostic[] {
  const d: Diagnostic[] = [];
  const err = (code: string, message: string) => d.push({ severity: 'error', code, message });
  const warn = (code: string, message: string) => d.push({ severity: 'warning', code, message });
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  if (!/export const \w+\s*:\s*PartHandler\s*=/.test(code)) err('export', 'export the handler as `export const <name>: PartHandler = async (inputs, ctx) => { ... }`');
  if (/(^|[^.\w])fetch\s*\(/.test(code)) err('fetch', 'use ctx.http(url): it only reaches the hosts declared as net: capabilities');
  for (const [re, what] of [[/process\.env/, 'process.env'], [/\brequire\s*\(/, 'require()'], [/child_process|node:fs|from 'fs'|from "fs"/, 'the file system or processes'], [/\beval\s*\(|new Function\s*\(/, 'eval / new Function'], [/\bsetInterval\s*\(/, 'setInterval']] as const) {
    if (re.test(code)) err('forbidden', `parts may not use ${what}`);
  }
  for (const p of Object.keys(m.inputs ?? {})) if (!new RegExp(`inputs\\.${p}\\b|inputs\\[['"]${p}['"]\\]`).test(code)) warn('input.unused', `input "${p}" is never read`);
  for (const p of Object.keys(m.outputs ?? {})) if (!new RegExp(`return[^;]*\\b${p}\\b`).test(code)) err('output.missing', `no return statement produces output "${p}"`);
  for (const k of Object.keys(m.params ?? {})) if (!new RegExp(`params\\.${k}\\b|params\\[['"]${k}['"]\\]`).test(code)) warn('param.unused', `param "${k}" is never read`);
  const caps = m.capabilities ?? [];
  const usesHttp = /ctx\.http\s*\(|\b(rpc|query|view|viewAccount|accessKeys|verifiedChat)\s*[<(]/.test(code);
  if (usesHttp && !caps.some((c) => c.startsWith('net:'))) err('capability.net', 'the code makes HTTP calls but the manifest declares no net: capability');
  if (!usesHttp && caps.some((c) => c.startsWith('net:'))) warn('capability.net', 'net: capabilities are declared but never used: declare only what the part needs');
  const approves = /ctx\.requestApproval\s*\(/.test(code);
  if (approves && !caps.includes('wallet:approve')) err('capability.wallet', 'ctx.requestApproval needs the wallet:approve capability');
  if (caps.includes('wallet:approve')) {
    if (!approves) warn('capability.wallet', 'wallet:approve is declared but the part never asks for approval');
    if (!/ctx\.mode\s*===?\s*['"]quote['"]/.test(code)) err('quote', 'a part that asks for signatures must handle ctx.mode === "quote" (dry run: read-only, no approvals)');
    if (!/ctx\.saveState\s*\(/.test(code)) err('durable', 'SRS-1 §8: save state with ctx.saveState before an irreversible step, so a restarted runner never asks twice');
    if (!/ctx\.resumeState/.test(code)) err('durable', 'SRS-1 §8: resume from ctx.resumeState after a restart');
  }
  if (m.disclosure && m.disclosure.model.kind !== 'none' && !/verifiedChat\s*\(/.test(code)) warn('model.verify', 'model calls should go through verifiedChat(), which checks the TEE signature before using a verdict');
  if (!/ctx\.log\s*\(/.test(code)) warn('log', 'log what the part did with ctx.log: buyers see it, sealed to their key');
  return d;
}

/** A starting point for a new part's source, generated from its manifest. */
export function partTemplate(m: PartManifest): string {
  const name = (m.id.split('@')[0].split('.').pop() ?? 'part').replace(/-([a-z])/g, (_, c) => c.toUpperCase()).replace(/[^a-zA-Z0-9]/g, '') || 'part';
  const ins = Object.entries(m.inputs).map(([p, s]) => `  const ${p} = inputs.${p}; // ${s.type}`).join('\n');
  const params = Object.entries(m.params).map(([k, s]) => `  const ${k} = ctx.params.${k}${s.default !== undefined ? ` ?? ${JSON.stringify(s.default)}` : ''}; // ${s.type}${s.secret ? ', sealed: only the runner sees it' : ''}`).join('\n');
  const outs = Object.entries(m.outputs).map(([p, s]) => `    ${p}: undefined as unknown, // ${s.type}`).join('\n');
  const net = m.capabilities.filter((c) => c.startsWith('net:')).map((c) => c.slice(4));
  const approve = m.capabilities.includes('wallet:approve');
  return `import type { PartHandler } from '../types.js';

/**
 * ${m.name}: ${m.summary || 'what this part does, in one sentence.'}
 * SRS-1: read only declared inputs and params, reach only ${net.length ? net.join(', ') : 'no hosts'} (via ctx.http), return every declared output.
 */
export const ${name}: PartHandler = async (inputs, ctx) => {
${ins || '  // no inputs'}
${params}
${net.length ? `  const r = await ctx.http('https://${net[0]}/...');\n` : ''}${approve ? `
  if (ctx.mode === 'quote') {
    // dry run for quotes: read-only, no approvals. Return what would happen.
    return {
${outs}
    };
  }
  // durable: save before the irreversible step, resume after a restart (SRS-1 §8)
  const resumed = ctx.resumeState as { phase: string } | undefined;
  if (!resumed) await ctx.saveState({ phase: 'approval' });
  const approval = (resumed ? ctx.priorApproval : undefined) ?? await ctx.requestApproval({ title: '...', signer: String(inputs.account ?? ''), transactions: [], summary: [] });
  if (!approval.approved) throw new Error('buyer rejected');
  await ctx.saveState({ phase: 'submitted' });
` : ''}
  ctx.log('what happened, in one line');
  return {
${outs}
  };
};
`;
}
