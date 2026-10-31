import { hashObject } from '../../core/src/canonical.js';
import { validateRecipe, type Catalog, type Recipe, type FormField } from '../../core/src/frs.js';
import type { ApprovalRequest, ApprovalResult, BlockHandler, Emit, Endpoints } from './types.js';
import { walletScanner } from './blocks/wallet-scanner.js';
import { spamShield } from './blocks/spam-shield.js';
import { allowlistShield } from './blocks/allowlist-shield.js';
import { dustFilter } from './blocks/dust-filter.js';
import { freshCheck } from './blocks/fresh-check.js';
import { intentsSwap } from './blocks/intents-swap.js';
import { summaryReport } from './blocks/summary-report.js';

export const HANDLERS: Record<string, BlockHandler> = {
  'near.wallet-scanner@1.0.0': walletScanner,
  'ai.spam-shield@1.1.0': spamShield,
  'rules.spam-shield@1.0.0': allowlistShield,
  'filter.dust@1.0.0': dustFilter,
  'addr.fresh-check@1.0.0': freshCheck,
  'intents.confidential-swap@1.0.0': intentsSwap,
  'intents.public-swap@1.0.0': intentsSwap,
  'report.summary@1.0.0': summaryReport,
};

export const REAL_ENDPOINTS: Endpoints = {
  fastnear: 'https://api.fastnear.com',
  rpc: 'https://rpc.mainnet.fastnear.com',
  oneclick: 'https://1click.chaindefuser.com',
  nearai: 'https://cloud-api.near.ai',
  nras: 'https://nras.attestation.nvidia.com',
};

/** host → base URL used in local mode (e.g. "api.fastnear.com=http://localhost:8080/mock/fastnear"). */
export function parseRewrites(spec = ''): Map<string, string> {
  return new Map(spec.split(',').filter(Boolean).map((kv) => { const [h, ...rest] = kv.split('='); return [h.trim(), rest.join('=').trim()]; }));
}

/** fetch limited to the block's declared `net:<host>` capabilities. */
export function guardedFetch(blockId: string, capabilities: string[], rewrites: Map<string, string>) {
  const allowed = new Set(capabilities.filter((c) => c.startsWith('net:')).map((c) => c.slice(4)));
  return async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    if (!allowed.has(u.host)) throw new Error(`capability violation: ${blockId} may not reach ${u.host} (declared: ${[...allowed].join(', ') || 'none'})`);
    const base = rewrites.get(u.host);
    const target = base ? base.replace(/\/$/, '') + u.pathname + u.search : url;
    return fetch(target, { ...init, signal: AbortSignal.timeout(20_000) });
  };
}

export function validateInputs(form: FormField[], inputs: Record<string, unknown>): string[] {
  const errs: string[] = [];
  for (const f of form) {
    const v = inputs[f.id] ?? f.default;
    if (v === undefined || v === '') { if (f.required) errs.push(`${f.label} is required`); continue; }
    if (f.type === 'usd' && !(Number(v) >= 0)) errs.push(`${f.label} must be a positive number`);
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
}

export interface ExecResult { ok: boolean; output: unknown; blocksUsed: string[]; outputHash: string; error?: string }

export async function execute(runId: string, recipe: Recipe, inputs: Record<string, unknown>, deps: ExecDeps): Promise<ExecResult> {
  const v = validateRecipe(recipe, deps.catalog);
  if (!v.ok) throw new Error('sealed recipe failed FRS-1 validation: ' + v.diagnostics.map((d) => d.message).join('; '));
  const inErr = validateInputs(recipe.form, inputs);
  if (inErr.length) throw new Error(inErr.join('; '));
  const values = new Map<string, unknown>(); // "<node>.<port>" | "form.x" | "const.x"
  for (const f of recipe.form) values.set(`form.${f.id}`, inputs[f.id] ?? f.default);
  for (const [k, c] of Object.entries(recipe.consts ?? {})) values.set(`const.${k}`, c.value);
  const manifests = new Map(deps.catalog.blocks.map((b) => [b.id, b]));
  const used: string[] = [];

  try {
    for (const nodeId of v.order) {
      const node = recipe.nodes.find((n) => n.id === nodeId)!;
      const m = manifests.get(node.block)!;
      const handler = HANDLERS[node.block];
      if (!handler) throw new Error(`runner has no implementation for ${node.block}`);
      const blockInputs = Object.fromEntries(Object.entries(node.inputs).map(([p, ref]) => [p, values.get(ref)]));
      const params = { ...Object.fromEntries(Object.entries(m.params).map(([k, s]) => [k, s.default])), ...node.params };
      const t0 = Date.now();
      deps.emit('block_start', { node: nodeId, block: m.id, name: m.name, author: m.author, fee: m.fee_per_call });
      const out = await handler(blockInputs, {
        nodeId, manifest: m, params,
        http: guardedFetch(m.id, m.capabilities, deps.rewrites),
        log: (msg, data) => deps.emit('block_log', { node: nodeId, msg, data }),
        requestApproval: (req) => deps.requestApproval(nodeId, req),
        endpoints: REAL_ENDPOINTS,
        secrets: deps.secrets,
      });
      for (const [port, val] of Object.entries(out)) values.set(`${nodeId}.${port}`, val);
      used.push(m.id);
      deps.emit('block_done', { node: nodeId, block: m.id, ms: Date.now() - t0, ports: Object.keys(out) });
    }
    const output = values.get(recipe.output);
    return { ok: true, output, blocksUsed: used, outputHash: hashObject({ run_id: runId, output }) };
  } catch (e) {
    const error = (e as Error).message;
    deps.emit('block_error', { error });
    return { ok: false, output: null, blocksUsed: [], outputHash: hashObject({ run_id: runId, error }), error };
  }
}
