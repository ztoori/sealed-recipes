/**
 * Sealed recipe runner — the only process that can decrypt recipes and buyer inputs.
 * Deploy this directory as a container in a TEE (see runner/Dockerfile, runner/docker-compose.yml).
 *
 * Privacy rules enforced in this file:
 *  - plaintext recipes / inputs exist only inside `runJob` and are never logged or stored
 *  - anything derived from the buyer's data (part logs, approval requests, the output)
 *    is sealed to the buyer's one-time reply key before it leaves this process; the
 *    marketplace relays ciphertext plus coarse progress (part started / finished)
 *  - the only durable output is a signed report (run_id, outcome ok|fail|abort, output_hash, delivered, parts_used);
 *    once a run is verified as paid, pending and ours, every exit path signs a report, so the buyer is never
 *    left waiting for the reclaim timeout
 *  - job endpoints require RUNNER_TOKEN (shared with the marketplace only)
 */
import express from 'express';
import nacl from 'tweetnacl';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { open, seal, sealedHash, base64, type SealedEnvelope } from '../../core/src/seal.js';
import { runReportMessage, quoteMessage, checkpointMessage, type Outcome } from '../../core/src/ledger.js';
import { jobHash, type JobPayload } from '../../core/src/quotes.js';
import { measure, fetchPrices, creditedDelivered } from './metrics.js';
import { hashObject, sha256Hex } from '../../core/src/canonical.js';
import { reportData, type RunnerAttestation } from '../../core/src/attestation.js';
import { computeCodehash, loadCatalog } from '../../core/src/codehash.js';
import { validateRecipe, measuresValue, type Recipe } from '../../core/src/srs.js';
import { execute, parseRewrites, setAdmission, type ResumePoint } from './executor.js';
import { admitParts } from './admission.js';
import { loadKeys } from './keys.js';
import type { ApprovalRequest, ApprovalResult } from './types.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const env = process.env;
const PORT = Number(env.RUNNER_PORT ?? 8787);
const RUNNER_ID = env.RUNNER_ID ?? 'tee-runner-1.testnet';
const CHAIN = env.CHAIN_URL ?? 'http://127.0.0.1:8080/api/chain'; // relayer: views (unless NEAR_RPC_URL) + report submission
const NEAR_RPC = env.NEAR_RPC_URL; // when set, views are read from the contract directly over NEAR JSON-RPC
const TOKEN = env.RUNNER_TOKEN ?? '';
const CONTRACT_ID = env.CONTRACT_ID ?? 'sealed-recipes.testnet';
const rewrites = parseRewrites(env.SRS_REWRITE);
const ONECLICK = rewrites.get('1click.chaindefuser.com') ?? 'https://1click.chaindefuser.com';
const QUOTE_TTL_NS = 10n * 60n * 1_000_000_000n;
/** a quoted run is re-priced right before execution; below this share of the quoted promise the runner aborts
 *  (refund, bond untouched) instead of executing into a shortfall the buyer engineered by emptying the wallet */
const RECHECK_MIN_BPS = 9800n;
/** durable runs: where checkpoints are stored (the marketplace keeps ciphertext; only this runner can open it) */
const MARKET = env.MARKET_URL ?? CHAIN.replace(/\/api\/chain\/?$/, '');
/** in "final" settle mode, a heartbeat checkpoint goes on-chain at least this often so long runs never time out */
const HEARTBEAT_MS = Number(env.SRS_HEARTBEAT_MS ?? 5 * 60_000);

/** A signed, sealed checkpoint record as stored by the marketplace. */
interface CheckpointRecord { run_id: string; local_seq: number; state_hash: string; envelope: SealedEnvelope; signature: string }
interface DurableState { v: 1; run_id: string; recipe_id: string; local_seq: number; fresh: string; point: ResumePoint }
const stateMessage = (runId: string, recipeId: string, seq: number, stateHash: string) => ['srs-state-v1', CONTRACT_ID, runId, recipeId, String(seq), stateHash].join('|');
interface ResumeInput { checkpoint: CheckpointRecord | null; approvals: Record<string, ApprovalResult> }
const catalog = loadCatalog(ROOT);
const composeHash = sha256Hex(readFileSync(resolve(ROOT, 'runner/docker-compose.yml'), 'utf8').replace(/\r\n/g, '\n'));
const { codehash } = computeCodehash(ROOT);
// admission (SRS-1 §11): only parts whose release record verifies can run; open-tier parts run in the sandbox
const admission = await admitParts(ROOT, catalog);
setAdmission(admission);
console.log(`[runner] release ${admission.release}: ${admission.admitted.size} parts admitted (${admission.sandboxed.size} sandboxed)${admission.refused.size ? `, ${admission.refused.size} refused: ` + [...admission.refused].map(([id, why]) => `${id} (${why})`).join('; ') : ''}`);
const keys = await loadKeys(env.TEE_MODE ?? 'local-dev', resolve(ROOT, '.data/runner-dev-keys.json'), composeHash);

type Ev = { seq: number; at: number; type: string; data: Record<string, unknown> };
interface Job { runId: string; recipeId: string; events: Ev[]; listeners: Set<(e: Ev) => void>; approval?: { resolve: (r: ApprovalResult) => void; req: ApprovalRequest; node: string }; done: boolean }
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
    const r = (await fetch(NEAR_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'srs', method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: CONTRACT_ID, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }) }).then((x) => x.json())) as { result?: { result: number[] }; error?: unknown };
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
    v: 'srs-attest-v1', tee: keys.tee, runner_id: RUNNER_ID, ...base, compose_hash: keys.composeHash,
    report_data: rd, quote: await keys.quote(rd), issued_at: new Date().toISOString(),
    self_sig: base64.enc(nacl.sign.detached(utf8ToBytes(rd), keys.sign.secretKey)),
  };
}

async function runJob(job: Job, sealedRecipe: SealedEnvelope, sealedInputs: SealedEnvelope, resumeIn?: ResumeInput) {
  let replyTo = '';
  let reportable = false; // true once the run is verified as paid, pending and assigned to this runner
  let reported = false;
  // buyer-derived data leaves the runner only sealed to the buyer's one-time reply key
  // sealed events carry nothing in the clear: not even the node id, which is part of the sealed method (SRS-1 §5.3)
  const priv = (type: string, data: Record<string, unknown>) => { if (replyTo) emit(job, 'sealed', { node: null, envelope: seal({ type, data }, replyTo, 'output') }); };
  const report = async (outcome: Outcome, outputHash: string, delivered: bigint, partsUsed: string[]) => {
    const msg = runReportMessage(CONTRACT_ID, job.runId, job.recipeId, outcome, outputHash, delivered.toString(), partsUsed);
    const signature = base64.enc(nacl.sign.detached(utf8ToBytes(msg), keys.sign.secretKey));
    emit(job, 'signed', { message: msg, signature, signing_pk: keys.signingPk });
    const rep = await fetch(`${CHAIN}/report_run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ run_id: job.runId, outcome, parts_used: partsUsed, output_hash: outputHash, delivered: delivered.toString(), signature }) });
    const settlement = await rep.json();
    if (!rep.ok) throw new Error('report_run rejected: ' + JSON.stringify(settlement));
    reported = true;
    return settlement;
  };
  const ZERO = '0'.repeat(64);
  try {
    // the run (what was paid for) is the source of truth; the recipe is taken from it, not from the request
    const run = await chainView<{ status: string; inputs_hash: string; recipe_id: string; buyer: string; sealed_hash?: string; job_hash?: string; promised?: string; checkpoint_seq?: number }>(`runs/${job.runId}`);
    if (run.recipe_id !== job.recipeId) throw new Error(`run ${job.runId} paid for ${run.recipe_id}, not ${job.recipeId}`);
    const recipeOnChain = await chainView<{ sealed_hash: string; runner_id: string; parts: string[]; settle_mode?: string }>(`recipes/${run.recipe_id}`);
    if (run.status !== 'Pending') throw new Error(`run is ${run.status}, not Pending (was it paid?)`);
    if (recipeOnChain.runner_id !== RUNNER_ID) throw new Error('recipe is assigned to a different runner');
    reportable = true;
    const committed = run.sealed_hash ?? recipeOnChain.sealed_hash; // snapshot taken when the run was paid
    const rh = sealedHash(sealedRecipe), ih = sealedHash(sealedInputs);
    const checks = [
      { label: `Run is paid and pending on-chain, for ${run.recipe_id}`, ok: true },
      { label: 'sha256(sealed recipe) == sealed_hash committed in the paid run', ok: rh === committed, value: rh },
      { label: 'sha256(sealed inputs) == on-chain inputs_hash', ok: ih === run.inputs_hash, value: ih },
    ];
    if (rh !== committed) { emit(job, 'verified', { checks }); throw new Error('sealed recipe does not match the on-chain commitment'); }
    if (ih !== run.inputs_hash) { emit(job, 'verified', { checks }); throw new Error('sealed inputs do not match the on-chain commitment'); }

    let recipe: Recipe | undefined = open<Recipe>(sealedRecipe, keys.box.secretKey);
    // the public labels (risk, privacy, disclosures) are computed from the on-chain parts; refuse a sealed recipe
    // that uses anything else, so the labels a buyer chose on are the parts that actually run
    const v = validateRecipe(recipe, catalog);
    const sameParts = [...new Set(v.partsUsed)].sort().join(',') === [...new Set(recipeOnChain.parts)].sort().join(',');
    checks.push({ label: 'decrypted recipe uses exactly the parts listed on-chain', ok: v.ok && sameParts });
    emit(job, 'verified', { checks });
    if (!v.ok || !sameParts) throw new Error('sealed recipe parts differ from the on-chain parts list');
    const opened = open<JobPayload>(sealedInputs, keys.box.secretKey);
    if (!/^[0-9a-f]{64}$/.test(opened?.reply_to ?? '')) throw new Error('sealed inputs must include a reply_to key');
    // a quoted run must execute exactly the job that was quoted (and that the bond backs)
    if (run.job_hash && jobHash(opened.inputs, String(opened.salt ?? '')) !== run.job_hash) throw new Error('inputs do not match the quoted job');
    let inputs: Record<string, unknown> | undefined = opened.inputs;
    replyTo = opened.reply_to;
    emit(job, 'decrypted', { nodes: recipe.nodes.length, note: 'recipe + inputs decrypted inside the runner; plaintext never leaves this process' });
    const valued = measuresValue(catalog.types, v.outputType); // swap receipts: value delivered is measured (SRS-1 §7)
    const secrets = { nearAiKey: env.NEAR_AI_API_KEY, oneClickJwt: env.ONECLICK_JWT };

    // ---- durable runs: open the last checkpoint (if resuming) and set up checkpointing ----
    let localSeq = 0, onchainSeq = Number(run.checkpoint_seq ?? 0), lastOnchain = Date.now();
    let resumePoint: ResumePoint | undefined;
    let freshSaved: bigint | undefined;
    const cp = resumeIn?.checkpoint;
    if (cp) {
      const okSig = nacl.sign.detached.verify(utf8ToBytes(stateMessage(job.runId, job.recipeId, cp.local_seq, cp.state_hash)), base64.dec(cp.signature), keys.sign.publicKey);
      if (!okSig || sealedHash(cp.envelope) !== cp.state_hash) throw new Error('checkpoint was not signed by this runner or was altered');
      const st = open<DurableState>(cp.envelope, keys.box.secretKey);
      if (st.run_id !== job.runId || st.local_seq !== cp.local_seq) throw new Error('checkpoint belongs to another run');
      resumePoint = st.point; localSeq = st.local_seq; freshSaved = BigInt(st.fresh);
      emit(job, 'resuming', { local_seq: localSeq, completed_parts: st.point.index, mid_part: st.point.node !== undefined ? `s${st.point.index + 1}` : null, onchain_seq: onchainSeq });
    }
    const settleMode = recipeOnChain.settle_mode ?? 'final';
    const checkpoint = async (point: ResumePoint, partsDone: string[]) => {
      localSeq += 1;
      const state: DurableState = { v: 1, run_id: job.runId, recipe_id: job.recipeId, local_seq: localSeq, fresh: String(fresh), point };
      const envelope = seal(state, keys.encPkHex, 'state'); // only this runner (in its TEE) can open it
      const state_hash = sealedHash(envelope);
      const signature = base64.enc(nacl.sign.detached(utf8ToBytes(stateMessage(job.runId, job.recipeId, localSeq, state_hash)), keys.sign.secretKey));
      // durable write first: the run does not move past this point until the marketplace has stored the checkpoint
      const st = await fetch(`${MARKET}/api/internal/checkpoints`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-runner-token': TOKEN }, body: JSON.stringify({ run_id: job.runId, local_seq: localSeq, state_hash, envelope, signature } satisfies CheckpointRecord) });
      if (!st.ok) throw new Error('checkpoint store failed: ' + (await st.text()));
      emit(job, 'checkpoint', { local_seq: localSeq, state_hash, completed_parts: point.index, mid_part: point.node !== undefined ? `s${point.index + 1}` : null });
      const bill = settleMode === 'checkpoint' ? partsDone : [];
      if (bill.length || Date.now() - lastOnchain >= HEARTBEAT_MS) {
        const seq = onchainSeq + 1;
        const sig = base64.enc(nacl.sign.detached(utf8ToBytes(checkpointMessage(CONTRACT_ID, job.runId, job.recipeId, seq, state_hash, bill)), keys.sign.secretKey));
        const r = await fetch(`${CHAIN}/checkpoint_run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ run_id: job.runId, seq, state_hash, parts_done: bill, signature: sig }) });
        const out = await r.json();
        if (!r.ok) throw new Error('checkpoint_run rejected: ' + JSON.stringify(out));
        onchainSeq = seq; lastOnchain = Date.now();
        emit(job, 'checkpoint_onchain', { seq, billed_parts: bill, ...out });
      }
    };

    // bonded runs: re-price the job right before executing. If the wallet no longer holds what was quoted
    // (e.g. the buyer moved funds out after paying), abort with a refund instead of paying out the bond.
    const quotedPromise = BigInt(run.promised ?? '0');
    let fresh = freshSaved ?? 0n; // the promise re-measured right before executing (bonded runs only)
    if (!resumePoint && run.job_hash && quotedPromise > 0n && valued) {
      const dry = await execute(`recheck-${job.runId}`, recipe, inputs, { catalog, rewrites, mode: 'quote', emit: () => {}, secrets, requestApproval: async () => ({ approved: false, txHashes: [] }) });
      fresh = dry.ok ? measure(valued, dry.output, await fetchPrices(ONECLICK)).promised : 0n;
      const okToRun = fresh * 10_000n >= quotedPromise * RECHECK_MIN_BPS;
      emit(job, 'rechecked', { ok: okToRun, threshold_bps: Number(RECHECK_MIN_BPS) });
      priv('recheck', { fresh_promised: fresh.toString(), quoted_promised: quotedPromise.toString() });
      if (!okToRun) {
        recipe = undefined; inputs = undefined;
        const settlement = await report('abort', ZERO, 0n, []);
        emit(job, 'completed', { ok: false, outcome: 'abort', reason: 'wallet changed since the quote: refunded, bond untouched', settlement });
        return;
      }
    }

    // SRS-1 §5.3: in the clear the marketplace sees only coarse progress (step i of n, also for skipped steps).
    // Part names, node ids, order and skips go to the buyer, sealed. Approvals are keyed by step, not by node id.
    const stepOf = (node: string) => `s${v.order.indexOf(node) + 1}`;
    const priorApprovals = Object.fromEntries(Object.entries(resumeIn?.approvals ?? {}).map(([k, a]) => [/^s\d+$/.test(k) ? v.order[Number(k.slice(1)) - 1] ?? k : k, a]));
    let stepsDone = resumePoint?.index ?? 0;
    const res = await execute(job.runId, recipe, inputs, {
      catalog, rewrites, secrets, checkpoint, resume: resumePoint, priorApprovals,
      emit: (t, d) => {
        priv(t, d);
        if (t === 'part_done' || t === 'part_skipped') emit(job, 'progress', { step: ++stepsDone, of: v.order.length });
      },
      requestApproval: (node, req) => new Promise<ApprovalResult>((resolveApproval) => {
        const step = stepOf(node);
        job.approval = { resolve: resolveApproval, req, node: step };
        emit(job, 'approval_pending', { node: step, transactions: req.transactions.length });
        priv('approval_required', { node, ...req });
        setTimeout(() => { if (job.approval?.req === req) { job.approval = undefined; resolveApproval({ approved: false, txHashes: [] }); } }, 5 * 60_000);
      }),
    });
    const output = res.output;
    recipe = undefined; inputs = undefined; // drop plaintext

    const m = res.ok ? measure(valued, output, await fetchPrices(ONECLICK).catch(() => new Map())) : undefined;
    // bonded runs report delivered value credited with anything the buyer withheld after the re-check
    const delivered = m ? (fresh > 0n ? creditedDelivered(m.delivered, fresh, m.executed) : m.delivered) : 0n;
    if (m && delivered !== m.delivered) priv('withheld', { measured: m.delivered.toString(), credited: delivered.toString() });
    const settlement = await report(res.ok ? 'ok' : 'fail', res.outputHash, delivered, res.ok ? res.partsUsed : []);
    // the buyer gets the salt, so only the buyer can check output_hash against the output (SRS-1 §6)
    priv('result', { ok: res.ok, error: res.error, output, salt: res.salt, skipped: res.skipped });
    emit(job, 'completed', { ok: res.ok, outcome: res.ok ? 'ok' : 'fail', output_hash: res.outputHash, settlement });
  } catch (e) {
    emit(job, 'failed', { error: (e as Error).message });
    // a verified run that cannot complete is refunded now (signed fail), not after the reclaim timeout
    if (reportable && !reported) {
      try { const settlement = await report('fail', ZERO, 0n, []); emit(job, 'refunded', { settlement }); }
      catch (e2) { emit(job, 'failed', { error: 'could not report failure: ' + (e2 as Error).message + ' (buyer can reclaim_run after the timeout)' }); }
    }
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
/**
 * Durable runs: continue a paid run after this runner restarted. The marketplace sends the same sealed recipe and
 * inputs, the last checkpoint it stored (signed by this runner, sealed to this runner) and the approvals it relayed.
 */
app.post('/runs/:id/resume', auth, (req, res) => {
  const run_id = String(req.params.id);
  const { recipe_id, sealed_recipe, sealed_inputs, checkpoint, approvals } = req.body ?? {};
  if (!recipe_id || !sealed_recipe || !sealed_inputs) { res.status(400).json({ error: 'recipe_id, sealed_recipe, sealed_inputs required' }); return; }
  const live = jobs.get(run_id);
  if (live && !live.done) { res.status(409).json({ error: 'run is still executing here' }); return; }
  const job: Job = { runId: run_id, recipeId: recipe_id, events: [], listeners: new Set(), done: false };
  jobs.set(run_id, job);
  emit(job, 'accepted', { runner_id: RUNNER_ID, tee: keys.tee, resumed: true });
  void runJob(job, sealed_recipe, sealed_inputs, { checkpoint: checkpoint ?? null, approvals: approvals ?? {} });
  res.status(202).json({ ok: true });
});
/**
 * Quotes: dry-run one recipe on the buyer's sealed request and sign a quote. Read-only: swaps are priced with dry
 * 1Click quotes and nothing is signed for the buyer. Everything describing the buyer's wallet is sealed to them.
 */
app.post('/quotes', auth, async (req, res) => {
  const { recipe_id, sealed_recipe, sealed_job, job_hash, buyer } = req.body ?? {};
  const fail = (error: string) => res.json({ recipe_id, ok: false, error });
  try {
    if (typeof buyer !== 'string' || !buyer) return fail('buyer required: quotes are bound to the account that will pay');
    const onChain = await chainView<{ sealed_hash: string; runner_id: string; parts: string[]; bond_available?: string; price_per_run: string }>(`recipes/${recipe_id}`);
    if (onChain.runner_id !== RUNNER_ID) return fail('recipe is assigned to a different runner');
    if (sealedHash(sealed_recipe) !== onChain.sealed_hash) return fail('sealed recipe does not match the on-chain commitment');
    let recipe: Recipe | undefined = open<Recipe>(sealed_recipe, keys.box.secretKey);
    const v = validateRecipe(recipe, catalog);
    if (!v.ok || [...new Set(v.partsUsed)].sort().join(',') !== [...new Set(onChain.parts)].sort().join(',')) return fail('sealed recipe parts differ from the on-chain parts list');
    const p = open<JobPayload>(sealed_job, keys.box.secretKey);
    if (!/^[0-9a-f]{64}$/.test(p?.reply_to ?? '')) return fail('sealed job must include a reply_to key');
    if (jobHash(p.inputs, p.salt) !== job_hash) return fail('job_hash does not match the sealed job');
    const dry = await execute(`quote-${recipe_id}`, recipe, p.inputs, { catalog, rewrites, mode: 'quote', emit: () => {}, secrets: { nearAiKey: env.NEAR_AI_API_KEY, oneClickJwt: env.ONECLICK_JWT }, requestApproval: async () => ({ approved: false, txHashes: [] }) });
    recipe = undefined;
    if (!dry.ok) return fail(dry.error ?? 'dry run failed');
    const m = measure(measuresValue(catalog.types, v.outputType), dry.output, await fetchPrices(ONECLICK));
    // the bond backs the promise up to what is free right now; the contract re-checks bond >= cover at payment
    const free = BigInt(onChain.bond_available ?? '0');
    // v6: the quote locks the recipe's current list price (market-driven, inside the creator's band); the contract
    // accepts any signed price within the band, so a creator's pricing strategy can live here
    const fields = {
      sealed_hash: onChain.sealed_hash, job_hash, price: BigInt(onChain.price_per_run).toString(), expected: m.expected.toString(), promised: m.promised.toString(),
      cover: (m.promised < free ? m.promised : free).toString(), expires_ns: (BigInt(Date.now()) * 1_000_000n + QUOTE_TTL_NS).toString(),
    };
    const inputs_hash = sealedHash(sealed_job); // the buyer pays with this same envelope as sealed_inputs
    const signature = base64.enc(nacl.sign.detached(utf8ToBytes(quoteMessage(CONTRACT_ID, recipe_id, inputs_hash, buyer, fields)), keys.sign.secretKey));
    // values describe the buyer's wallet, so the whole quote is sealed to the buyer; the marketplace relays ciphertext
    res.json({ recipe_id, ok: true, sealed_quote: seal({ ...fields, signature, recipe_id, buyer, inputs_hash, details: { output: dry.output } }, p.reply_to, 'output') });
  } catch (e) { fail((e as Error).message); }
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
  const result: ApprovalResult = { approved: !!req.body?.approved, txHashes: req.body?.txHashes ?? [], ...(req.body?.signed ? { signed: req.body.signed } : {}) };
  emit(job, 'approval_result', { approved: result.approved, transfers: result.txHashes.length });
  r.resolve(result);
  res.json({ ok: true });
});

/** local demo only: simulate a hard crash (process killed mid-run) to show runs resuming from checkpoints */
if (env.SRS_ALLOW_CRASH === '1') app.post('/__crash', auth, (_, res) => { res.json({ ok: true }); setTimeout(() => process.exit(137), 20); });

const HOST = env.RUNNER_HOST ?? '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`[runner] ${RUNNER_ID} (${keys.tee}) on http://${HOST}:${PORT}`);
  console.log(`[runner] signing ${keys.signingPk}  enc ${keys.encPkHex.slice(0, 16)}…  codehash ${codehash.slice(0, 16)}…`);
});
