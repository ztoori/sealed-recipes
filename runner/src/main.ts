/**
 * Sealed recipe runner — the only process that can decrypt recipes and buyer inputs.
 * Deploy this directory as a container in a TEE (see runner/Dockerfile, runner/docker-compose.yml).
 *
 * Privacy rules enforced in this file:
 *  - plaintext recipes / inputs exist only inside `runJob` and are never logged or stored
 *  - events streamed to clients contain block progress, never params or wiring
 *  - the only durable output is a signed report (run_id, ok, output_hash, blocks_used)
 */
import express from 'express';
import nacl from 'tweetnacl';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { open, sealedHash, base64, type SealedEnvelope } from '../../core/src/seal.js';
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
const CHAIN = env.CHAIN_URL ?? 'http://127.0.0.1:8080/api/chain';
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

async function chainView<T>(path: string): Promise<T> {
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
  try {
    const [run, recipeOnChain] = await Promise.all([
      chainView<{ status: string; inputs_hash: string; recipe_id: string; buyer: string }>(`runs/${job.runId}`),
      chainView<{ sealed_hash: string; runner_id: string; blocks: string[] }>(`recipes/${job.recipeId}`),
    ]);
    if (run.status !== 'Pending') throw new Error(`run is ${run.status}, not Pending (was it paid?)`);
    if (recipeOnChain.runner_id !== RUNNER_ID) throw new Error('recipe is assigned to a different runner');
    const rh = sealedHash(sealedRecipe), ih = sealedHash(sealedInputs);
    emit(job, 'verified', { checks: [
      { label: 'Run is paid and pending on-chain', ok: true },
      { label: 'sha256(sealed recipe) == on-chain sealed_hash', ok: rh === recipeOnChain.sealed_hash, value: rh },
      { label: 'sha256(sealed inputs) == on-chain inputs_hash', ok: ih === run.inputs_hash, value: ih },
    ] });
    if (rh !== recipeOnChain.sealed_hash) throw new Error('sealed recipe does not match the on-chain commitment');
    if (ih !== run.inputs_hash) throw new Error('sealed inputs do not match the on-chain commitment');

    let recipe: Recipe | undefined = open<Recipe>(sealedRecipe, keys.box.secretKey);
    let inputs: Record<string, unknown> | undefined = open<Record<string, unknown>>(sealedInputs, keys.box.secretKey);
    emit(job, 'decrypted', { nodes: recipe.nodes.length, note: 'recipe + inputs decrypted inside the runner; plaintext never leaves this process' });

    const res = await execute(job.runId, recipe, inputs, {
      catalog, rewrites,
      emit: (t, d) => emit(job, t, d),
      secrets: { nearAiKey: env.NEAR_AI_API_KEY, oneClickJwt: env.ONECLICK_JWT },
      requestApproval: (node, req) => new Promise<ApprovalResult>((resolveApproval) => {
        job.approval = { resolve: resolveApproval, req };
        emit(job, 'approval_required', { node, ...req });
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
    // The output goes back only to the buyer's session (encrypted to them in production, see docs/THREAT_MODEL.md)
    emit(job, 'completed', { ok: res.ok, error: res.error, output, output_hash: res.outputHash, output_commitment: hashObject({ run_id: job.runId, output }), settlement });
  } catch (e) {
    emit(job, 'failed', { error: (e as Error).message });
  } finally {
    job.done = true;
  }
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use((_, res, next) => { res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-headers', 'content-type'); next(); });

app.get('/health', (_, res) => { res.json({ ok: true, runner_id: RUNNER_ID, tee: keys.tee }); });
app.get('/attestation', async (req, res) => {
  const nonce = String(req.query.nonce ?? '');
  if (!/^[0-9a-f]{16,128}$/.test(nonce)) { res.status(400).json({ error: 'nonce must be 16-128 hex chars' }); return; }
  res.json(await attestation(nonce));
});
app.post('/runs', (req, res) => {
  const { run_id, recipe_id, sealed_recipe, sealed_inputs } = req.body ?? {};
  if (!run_id || !recipe_id || !sealed_recipe || !sealed_inputs) { res.status(400).json({ error: 'run_id, recipe_id, sealed_recipe, sealed_inputs required' }); return; }
  if (jobs.has(run_id)) { res.status(409).json({ error: 'run already started' }); return; }
  const job: Job = { runId: run_id, recipeId: recipe_id, events: [], listeners: new Set(), done: false };
  jobs.set(run_id, job);
  emit(job, 'accepted', { runner_id: RUNNER_ID, tee: keys.tee });
  void runJob(job, sealed_recipe, sealed_inputs);
  res.status(202).json({ ok: true });
});
app.get('/runs/:id/events', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) { res.status(404).end(); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (e: Ev) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  job.events.forEach(send);
  job.listeners.add(send);
  req.on('close', () => job.listeners.delete(send));
});
app.post('/runs/:id/approval', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job?.approval) { res.status(409).json({ error: 'no approval pending' }); return; }
  const r = job.approval; job.approval = undefined;
  const result: ApprovalResult = { approved: !!req.body?.approved, txHashes: req.body?.txHashes ?? [] };
  emit(job, 'approval_result', { approved: result.approved, txHashes: result.txHashes });
  r.resolve(result);
  res.json({ ok: true });
});

const HOST = env.RUNNER_HOST ?? '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`[runner] ${RUNNER_ID} (${keys.tee}) on http://${HOST}:${PORT}`);
  console.log(`[runner] signing ${keys.signingPk}  enc ${keys.encPkHex.slice(0, 16)}…  codehash ${codehash.slice(0, 16)}…`);
});
