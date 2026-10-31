/**
 * Sealed recipe runner — the only process that can decrypt recipes and buyer inputs.
 * Deploy this directory as a container in a TEE (see runner/Dockerfile, runner/docker-compose.yml).
 *
 * Privacy rules enforced in this file:
 *  - plaintext recipes / inputs exist only inside `runJob` and are never logged or stored
 *  - anything derived from the buyer's data (block logs, approval requests, the output)
 *    is sealed to the buyer's one-time reply key before it leaves this process; the
 *    marketplace relays ciphertext plus coarse progress (block started / finished)
 *  - the only durable output is a signed report (run_id, ok, output_hash, blocks_used)
 *  - job endpoints require RUNNER_TOKEN (shared with the marketplace only)
 */
import express from 'express';
import nacl from 'tweetnacl';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { open, seal, sealedHash, base64, type SealedEnvelope } from '../../core/src/seal.js';
import { runReportMessage } from '../../core/src/ledger.js';
import { hashObject, sha256Hex } from '../../core/src/canonical.js';
import { reportData, type RunnerAttestation } from '../../core/src/attestation.js';
import { computeCodehash } from '../../core/src/codehash.js';
import type { Catalog, Recipe } from '../../core/src/frs.js';
import { execute, parseRewrites } from './executor.js';
import { loadKeys } from './keys.js';
import type { ApprovalRequest, ApprovalResult } from './types.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const env = process.env;
const PORT = Number(env.RUNNER_PORT ?? 8787);
const RUNNER_ID = env.RUNNER_ID ?? 'tee-runner-1.testnet';
const CHAIN = env.CHAIN_URL ?? 'http://127.0.0.1:8080/api/chain'; // relayer: views (unless NEAR_RPC_URL) + report submission
const NEAR_RPC = env.NEAR_RPC_URL; // when set, views are read from the contract directly over NEAR JSON-RPC
const TOKEN = env.RUNNER_TOKEN ?? '';
const CONTRACT_ID = env.CONTRACT_ID ?? 'fungible-recipes.testnet';
const rewrites = parseRewrites(env.FRS_REWRITE);
const catalog = JSON.parse(readFileSync(resolve(ROOT, 'standard/blocks.json'), 'utf8')) as Catalog;
const composeHash = sha256Hex(readFileSync(resolve(ROOT, 'runner/docker-compose.yml'), 'utf8').replace(/\r\n/g, '\n'));
const { codehash } = computeCodehash(ROOT);
const keys = await loadKeys(env.TEE_MODE ?? 'local-dev', resolve(ROOT, '.data/runner-dev-keys.json'), composeHash);

type Ev = { seq: number; at: number; type: string; data: Record<string, unknown> };
interface Job { runId: string; recipeId: string; events: Ev[]; listeners: Set<(e: Ev) => void>; approval?: { resolve: (r: ApprovalResult) => void; req: ApprovalRequest }; done: boolean }
const jobs = new Map<string, Job>();

function emit(job: Job, type: string, data: Record<string, unknown>) {
  const e = { seq: job.events.length, at: Date.now(), type, data };
  job.events.push(e);
  for (const l of job.listeners) l(e);
}

/** Contract views. With NEAR_RPC_URL the runner reads the contract itself (call_function), so it does
 *  not have to trust the relayer for the commitments it checks. */
async function chainView<T>(path: string): Promise<T> {
  if (NEAR_RPC) {
    const [kind, id] = path.split('/');
    const method = kind === 'runs' ? 'get_run' : 'get_recipe';
    const args = kind === 'runs' ? { run_id: id } : { recipe_id: id };
    const r = (await fetch(NEAR_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'frs', method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: CONTRACT_ID, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }) }).then((x) => x.json())) as { result?: { result: number[] }; error?: unknown };
    if (!r.result) throw new Error(`rpc ${method}: ${JSON.stringify(r.error)}`);
    const v = JSON.parse(Buffer.from(r.result.result).toString('utf8')) as T | null;
    if (v == null) throw new Error(`${method}(${id}) returned null`);
    return v;
  }
  const r = await fetch(`${CHAIN}/${path}`);
  if (!r.ok) throw new Error(`chain view ${path}: ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

async function attestation(nonce: string): Promise<RunnerAttestation> {
  const base = { codehash, enc_pk_hex: keys.encPkHex, nonce, signing_pk: keys.signingPk };
  const rd = reportData(base);
  return {
    v: 'frs-attest-v1', tee: keys.tee, runner_id: RUNNER_ID, ...base, compose_hash: keys.composeHash,
    report_data: rd, quote: await keys.quote(rd), issued_at: new Date().toISOString(),
    self_sig: base64.enc(nacl.sign.detached(utf8ToBytes(rd), keys.sign.secretKey)),
  };
}

async function runJob(job: Job, sealedRecipe: SealedEnvelope, sealedInputs: SealedEnvelope) {
  let replyTo = '';
  // buyer-derived data leaves the runner only sealed to the buyer's one-time reply key
  const priv = (type: string, data: Record<string, unknown>) => { if (replyTo) emit(job, 'sealed', { node: data.node ?? null, envelope: seal({ type, data }, replyTo, 'output') }); };
  try {
    // the run (what was paid for) is the source of truth; the recipe is taken from it, not from the request
    const run = await chainView<{ status: string; inputs_hash: string; recipe_id: string; buyer: string; sealed_hash?: string }>(`runs/${job.runId}`);
    if (run.recipe_id !== job.recipeId) throw new Error(`run ${job.runId} paid for ${run.recipe_id}, not ${job.recipeId}`);
    const recipeOnChain = await chainView<{ sealed_hash: string; runner_id: string; blocks: string[] }>(`recipes/${run.recipe_id}`);
    if (run.status !== 'Pending') throw new Error(`run is ${run.status}, not Pending (was it paid?)`);
    if (recipeOnChain.runner_id !== RUNNER_ID) throw new Error('recipe is assigned to a different runner');
    const committed = run.sealed_hash ?? recipeOnChain.sealed_hash; // snapshot taken when the run was paid
    const rh = sealedHash(sealedRecipe), ih = sealedHash(sealedInputs);
    emit(job, 'verified', { checks: [
      { label: `Run is paid and pending on-chain, for ${run.recipe_id}`, ok: true },
      { label: 'sha256(sealed recipe) == sealed_hash committed in the paid run', ok: rh === committed, value: rh },
      { label: 'sha256(sealed inputs) == on-chain inputs_hash', ok: ih === run.inputs_hash, value: ih },
    ] });
    if (rh !== committed) throw new Error('sealed recipe does not match the on-chain commitment');
    if (ih !== run.inputs_hash) throw new Error('sealed inputs do not match the on-chain commitment');

    let recipe: Recipe | undefined = open<Recipe>(sealedRecipe, keys.box.secretKey);
    const opened = open<{ inputs: Record<string, unknown>; reply_to: string }>(sealedInputs, keys.box.secretKey);
    if (!/^[0-9a-f]{64}$/.test(opened?.reply_to ?? '')) throw new Error('sealed inputs must include a reply_to key');
    let inputs: Record<string, unknown> | undefined = opened.inputs;
    replyTo = opened.reply_to;
    emit(job, 'decrypted', { nodes: recipe.nodes.length, note: 'recipe + inputs decrypted inside the runner; plaintext never leaves this process' });

    const PUBLIC = new Set(['block_start', 'block_done']);
    const res = await execute(job.runId, recipe, inputs, {
      catalog, rewrites,
      emit: (t, d) => (PUBLIC.has(t) ? emit(job, t, d) : priv(t, d)),
      secrets: { nearAiKey: env.NEAR_AI_API_KEY, oneClickJwt: env.ONECLICK_JWT },
      requestApproval: (node, req) => new Promise<ApprovalResult>((resolveApproval) => {
        job.approval = { resolve: resolveApproval, req };
        emit(job, 'approval_pending', { node, transactions: req.transactions.length });
        priv('approval_required', { node, ...req });
        setTimeout(() => { if (job.approval?.req === req) { job.approval = undefined; resolveApproval({ approved: false, txHashes: [] }); } }, 5 * 60_000);
      }),
    });
    const output = res.output;
    recipe = undefined; inputs = undefined; // drop plaintext

    const msg = runReportMessage(CONTRACT_ID, job.runId, job.recipeId, res.ok, res.outputHash, res.blocksUsed);
    const signature = base64.enc(nacl.sign.detached(utf8ToBytes(msg), keys.sign.secretKey));
    emit(job, 'signed', { message: msg, signature, signing_pk: keys.signingPk });
    const rep = await fetch(`${CHAIN}/report_run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ run_id: job.runId, success: res.ok, blocks_used: res.blocksUsed, output_hash: res.outputHash, signature }) });
    const settlement = await rep.json();
    if (!rep.ok) throw new Error('report_run rejected: ' + JSON.stringify(settlement));
    priv('result', { ok: res.ok, error: res.error, output });
    emit(job, 'completed', { ok: res.ok, output_hash: res.outputHash, output_commitment: hashObject({ run_id: job.runId, output }), settlement });
  } catch (e) {
    emit(job, 'failed', { error: (e as Error).message });
  } finally {
    job.done = true;
  }
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use((_, res, next) => { res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-headers', 'content-type'); next(); });
/** job endpoints are for the marketplace only (attestation and health stay public) */
const auth: express.RequestHandler = (req, res, next) => { if (TOKEN && req.get('x-runner-token') !== TOKEN) { res.status(401).json({ error: 'runner token required' }); return; } next(); };

app.get('/health', (_, res) => { res.json({ ok: true, runner_id: RUNNER_ID, tee: keys.tee }); });
app.get('/attestation', async (req, res) => {
  const nonce = String(req.query.nonce ?? '');
  if (!/^[0-9a-f]{16,128}$/.test(nonce)) { res.status(400).json({ error: 'nonce must be 16-128 hex chars' }); return; }
  res.json(await attestation(nonce));
});
app.post('/runs', auth, (req, res) => {
  const { run_id, recipe_id, sealed_recipe, sealed_inputs } = req.body ?? {};
  if (!run_id || !recipe_id || !sealed_recipe || !sealed_inputs) { res.status(400).json({ error: 'run_id, recipe_id, sealed_recipe, sealed_inputs required' }); return; }
  if (jobs.has(run_id)) { res.status(409).json({ error: 'run already started' }); return; }
  const job: Job = { runId: run_id, recipeId: recipe_id, events: [], listeners: new Set(), done: false };
  jobs.set(run_id, job);
  emit(job, 'accepted', { runner_id: RUNNER_ID, tee: keys.tee });
  void runJob(job, sealed_recipe, sealed_inputs);
  res.status(202).json({ ok: true });
});
app.get('/runs/:id/events', auth, (req, res) => {
  const job = jobs.get(String(req.params.id));
  if (!job) { res.status(404).end(); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (e: Ev) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  job.events.forEach(send);
  job.listeners.add(send);
  req.on('close', () => job.listeners.delete(send));
});
app.post('/runs/:id/approval', auth, (req, res) => {
  const job = jobs.get(String(req.params.id));
  if (!job?.approval) { res.status(409).json({ error: 'no approval pending' }); return; }
  const r = job.approval; job.approval = undefined;
  const result: ApprovalResult = { approved: !!req.body?.approved, txHashes: req.body?.txHashes ?? [] };
  emit(job, 'approval_result', { approved: result.approved, transfers: result.txHashes.length });
  r.resolve(result);
  res.json({ ok: true });
});

const HOST = env.RUNNER_HOST ?? '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`[runner] ${RUNNER_ID} (${keys.tee}) on http://${HOST}:${PORT}`);
  console.log(`[runner] signing ${keys.signingPk}  enc ${keys.encPkHex.slice(0, 16)}…  codehash ${codehash.slice(0, 16)}…`);
});
