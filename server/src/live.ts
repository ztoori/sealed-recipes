/**
 * Live marketplace on NEAR testnet (SRS_MODE=testnet):  node --import tsx server/src/live.ts
 *
 * The contract is the deployed one: state is read over RPC and every write is a real transaction.
 *  - Creators publish with their own key (publish_recipe); this server stores the sealed recipe only after checking
 *    the on-chain sealed_hash and creator, and never sees plaintext.
 *  - Buyers ask for quotes (sealed to the runner, as in the demo), then pay with their own key:
 *    ft_transfer_call(tUSDC → contract, price, msg). This server watches for the run to be Pending on-chain, then
 *    starts the runner and relays its event stream (public progress + payloads sealed to the buyer).
 *  - The runner's signed report_run / checkpoint_run are sent by the relayer (server/src/near.ts), one at a time.
 *  - No mocks, no fixtures, no demo wallet, no dev endpoints. Runner calls are authenticated with RUNNER_TOKEN.
 *
 * Env: PORT (8081)  CONTRACT_ID  RUNNER_ID  RUNNER_URL  RUNNER_TOKEN (required)  NEAR_RPC_URL  NEAR_RELAYER_KEY_FILE
 *      NEAR_RELAYER_ACCOUNT  SRS_STORE_DIR (persistent)  NEAR_NETWORK (testnet)
 *      NEAR_FAUCET_KEY_FILE  NEAR_FAUCET_ACCOUNT (optional: enables POST /api/faucet for guest accounts)
 *      SRS_RETIRED_LISTINGS (comma-separated tickers superseded on this runner, e.g. SAFE2; listings of other runners are
 *      retired without being named)  SRS_RUNNER_TEE (label; default: from the runner's attestation)
 *      FAUCET_NEAR (0.2)  FAUCET_TUSDC (5)  FAUCET_PER_IP_DAY (3)  FAUCET_PER_DAY (30)
 */
import express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { tokenMatches } from './token.js';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sealedHash, type SealedEnvelope } from '../../core/src/seal.js';
import { labelsFromParts, type PublicListing } from '../../core/src/srs.js';
import { loadCatalog } from '../../core/src/codehash.js';
import { FileBlobStore } from './store.js';
import { TeeRunnerBackend } from './backends.js';
import { NearChain } from './near.js';
import { mountDemoProxy } from './demo-proxy.js';
import { collateralCache } from './tee-collateral.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const env = process.env;
const need = (k: string) => { const v = env[k]; if (!v) { console.error(`[live] ${k} is required`); process.exit(2); } return v; };
const PORT = Number(env.PORT ?? 8081);
const NETWORK = env.NEAR_NETWORK ?? 'testnet';
const CONTRACT_ID = need('CONTRACT_ID');
const RUNNER_ID = need('RUNNER_ID');
/**
 * The runner's base URL, checked at startup so a placeholder or a typo fails here and not on every request: http(s),
 * no <placeholder>, no query or fragment; a trailing slash is dropped. Plain http only to a loopback address (the
 * token would otherwise cross the network in the clear).
 */
function runnerUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { console.error(`[live] RUNNER_URL is not a URL: ${raw}`); process.exit(2); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (/[<>]/.test(raw) || u.search || u.hash || u.username || u.password || !(u.protocol === 'https:' || (u.protocol === 'http:' && loopback))) {
    console.error(`[live] RUNNER_URL must be the runner's https base URL (http only on loopback), with no placeholder, query or credentials: ${raw}`);
    process.exit(2);
  }
  return u.href.replace(/\/+$/, '');
}
const RUNNER = runnerUrl(need('RUNNER_URL'));
const RUNNER_TOKEN = need('RUNNER_TOKEN');
const RPC = env.NEAR_RPC_URL ?? 'https://rpc.testnet.fastnear.com';
const PAY_TIMEOUT_MS = 5 * 60_000;
/**
 * Listings this marketplace no longer offers (still on-chain: the contract has no delisting). A listing assigned to
 * another runner than RUNNER_ID is retired without being named (it is sealed to that runner's key, so this runner
 * could not run it anyway); SRS_RETIRED_LISTINGS names the ones superseded on this same runner (e.g. SAFE2 by SAFE3).
 */
const RETIRED = new Set((env.SRS_RETIRED_LISTINGS ?? '').split(',').map((t) => t.trim().toUpperCase()).filter(Boolean));
const retired = (ticker: string, onchain?: { runner_id: string } | null) => RETIRED.has(String(ticker).toUpperCase()) || (!!onchain && onchain.runner_id !== RUNNER_ID);
const RETIRED_MSG = 'this recipe was replaced by a newer listing';
const explorer = (tx: string) => `https://testnet.nearblocks.io/txns/${tx}`;

const chain = new NearChain(RPC, CONTRACT_ID, env.NEAR_RELAYER_KEY_FILE, env.NEAR_RELAYER_ACCOUNT);
const faucet = env.NEAR_FAUCET_KEY_FILE && existsSync(env.NEAR_FAUCET_KEY_FILE) ? new NearChain(RPC, CONTRACT_ID, env.NEAR_FAUCET_KEY_FILE, env.NEAR_FAUCET_ACCOUNT) : undefined;
const yoctoOf = (near: string) => { const [i, f = ''] = near.split('.'); return BigInt(i || '0') * 10n ** 24n + BigInt((f + '0'.repeat(24)).slice(0, 24)); };
const FAUCET_NEAR = yoctoOf(env.FAUCET_NEAR ?? '0.2');                // a 150 Tgas payment needs ~0.151 NEAR available up front (most is refunded)
const FAUCET_TUSDC = BigInt(Math.round(Number(env.FAUCET_TUSDC ?? '5') * 1e6)); // tUSDC has 6 decimals
const FAUCET_PER_IP_DAY = Number(env.FAUCET_PER_IP_DAY ?? 3);
const FAUCET_PER_DAY = Number(env.FAUCET_PER_DAY ?? 30);
const backend = new TeeRunnerBackend(RUNNER, RUNNER_ID, RUNNER_TOKEN);
const catalog = loadCatalog(ROOT);
const store = new FileBlobStore(need('SRS_STORE_DIR'));

// ---- types of the contract views we use ----
interface Recipe { id: string; name: string; creator: string; sealed_hash: string; runner_id: string; parts: string[]; price_per_run: string; price_floor: string; price_ceiling: string; reserve_bps: number; bond_available: string; runs: string; failed: string; aborted: string; revenue: string; settle_mode?: string }
interface Run { status: string; recipe_id: string; buyer: string; inputs_hash: string; sealed_hash?: string; job_hash?: string }
interface Config { payment_token: string; owner: string; protocol_account: string; protocol_fee_bps: number }

// ---- durable marketplace state (ciphertext and public listings only) ----
interface VaultIndex { recipes: Record<string, { versions: string[]; creator_copies: Record<string, string> }> }
const vault = store.readMeta<VaultIndex>('vault', { recipes: {} });
const listings = store.readMeta<Record<string, PublicListing & { published_at: string; publish_tx?: string }>>('listings', {});
const saveVault = () => store.writeMeta('vault', vault);
const saveListings = () => store.writeMeta('listings', listings);

type Ev = { seq: number; at: number; source: 'market' | 'chain' | 'runner'; type: string; data: Record<string, unknown> };
interface CheckpointRecord { run_id: string; local_seq: number; state_hash: string; envelope: SealedEnvelope; signature: string }
interface RunCtx { run_id: string; token: string; recipe_id: string; buyer: string; sealed_inputs: SealedEnvelope; msg: string; price: string; checkpoint?: CheckpointRecord; started: boolean; done: boolean; events: Ev[]; created: number }
const runs = new Map<string, RunCtx>();
const listeners = new Map<string, Set<(e: Ev) => void>>();
const saveRun = (r: RunCtx) => store.writeMeta(`run-${r.run_id}`, { ...r, events: r.events.slice(-200) });
// runs survive a restart of this server: reload the saved tickets (sealed inputs, token, last checkpoint)
{
  const metaDir = join(need('SRS_STORE_DIR'), 'meta');
  if (existsSync(metaDir)) for (const f of readdirSync(metaDir)) {
    const m = /^run-(r-[0-9a-f]+)\.json$/.exec(f);
    if (m) { const r = store.readMeta<RunCtx | null>(`run-${m[1]}`, null); if (r) runs.set(r.run_id, r); }
  }
}
const pushEv = (r: RunCtx, source: Ev['source'], type: string, data: Record<string, unknown>) => {
  const e: Ev = { seq: r.events.length, at: Date.now(), source, type, data };
  r.events.push(e); for (const l of listeners.get(r.run_id) ?? []) l(e);
};

const sealedFor = async (r: RunCtx) => {
  const run = await chain.view<Run | null>('get_run', { run_id: r.run_id });
  const recipe = await chain.view<Recipe | null>('get_recipe', { recipe_id: r.recipe_id });
  const h = run?.sealed_hash ?? recipe?.sealed_hash ?? '';
  const env = vault.recipes[r.recipe_id]?.versions.includes(h) ? store.get(h) : undefined;
  if (!env) throw new Error(`no sealed version ${h.slice(0, 12)}… of ${r.recipe_id} here`);
  return env;
};

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
/**
 * Relay the runner's event stream for a run until it completes. A dropped connection is reconnected to the same
 * runner job; the runner replays that job's events on every connection, so each `seq` is relayed once. Only when the
 * runner no longer has the run (404: it restarted) or stays unreachable is the run reported lost and resumed from its
 * last checkpoint; a resumed run is a new runner job whose events start again at seq 0.
 */
async function followRunner(r: RunCtx) {
  let next = 0;   // next runner seq to relay for the current runner job
  let drops = 0;  // reconnects in a row without a new event
  for (;;) {
    let gone = false;
    try {
      const sse = await backend.events(r.run_id);
      if (sse.status === 404) { gone = true; await sse.body?.cancel(); }
      else {
        if (!sse.ok) throw new Error(`events ${sse.status}`);
        const reader = sse.body!.getReader(); const dec = new TextDecoder(); let buf = '';
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          for (let i; (i = buf.indexOf('\n\n')) >= 0;) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            if (!chunk.startsWith('data: ')) continue;
            const e = JSON.parse(chunk.slice(6)) as { seq?: number; type: string; data: Record<string, unknown> };
            const seq = typeof e.seq === 'number' ? e.seq : next;
            if (seq < next) continue; // already relayed before the reconnect
            next = seq + 1; drops = 0;
            pushEv(r, 'runner', e.type, e.data);
            if (e.type === 'completed' || e.type === 'failed') { r.done = true; saveRun(r); await reader.cancel(); return; }
          }
        }
      }
    } catch { /* stream broke or the runner is unreachable */ }
    if (r.done) return;
    const st = await chain.view<Run | null>('get_run', { run_id: r.run_id }).catch(() => undefined);
    if (st !== undefined && st?.status !== 'Pending') return; // settled, refunded or reclaimed (unknown: keep going)
    // a dropped connection: the runner job is likely still there, reconnect without alarming the buyer
    if (!gone && drops < 3) { drops++; await sleep(1000 * drops); continue; }
    pushEv(r, 'market', 'runner_lost', { checkpoint: r.checkpoint?.local_seq ?? null });
    for (let attempt = 0; ; attempt++) {
      await sleep(Math.min(10_000, 1000 + attempt * 1000));
      const s = await chain.view<Run | null>('get_run', { run_id: r.run_id }).catch(() => undefined);
      if (s !== undefined && s?.status !== 'Pending') return;
      try {
        const res = await backend.resume(r.run_id, { recipe_id: r.recipe_id, sealed_recipe: await sealedFor(r), sealed_inputs: r.sealed_inputs, checkpoint: r.checkpoint ?? null, approvals: {} });
        if (res.ok) { next = 0; drops = 0; pushEv(r, 'market', 'resume_requested', { attempt: attempt + 1 }); break; }
        if (res.status === 409) { drops = 0; break; } // still executing there: reconnect to that job
      } catch { /* runner still down */ }
    }
  }
}

/** wait until the contract has the run as Pending (the buyer's ft_transfer_call landed), then start the runner */
async function watchPayment(r: RunCtx, txHash?: string) {
  try { await watchPaymentInner(r, txHash); }
  catch (e) {
    // never an unhandled rejection (it would stop this server); a paid run stays resumable (POST /api/runs/:id/resume)
    console.error(`[live] run ${r.run_id}: ${(e as Error).message}`);
    pushEv(r, 'market', 'failed', { error: `could not start the run: ${(e as Error).message}; it can be resumed while it is Pending on-chain` });
  }
}
async function watchPaymentInner(r: RunCtx, txHash?: string) {
  const t = Date.now();
  if (txHash) {
    try {
      const tx = await chain.txEvents(txHash, r.buyer);
      pushEv(r, 'chain', tx.ok ? 'payment_tx' : 'payment_failed', { tx: txHash, url: explorer(txHash), events: tx.events, error: tx.error });
    } catch (e) { pushEv(r, 'chain', 'payment_tx_unknown', { tx: txHash, error: (e as Error).message }); }
  }
  while (Date.now() - t < PAY_TIMEOUT_MS) {
    const run = await chain.view<Run | null>('get_run', { run_id: r.run_id }).catch(() => null);
    if (run?.status === 'Pending') {
      pushEv(r, 'chain', 'run_requested', { status: run.status, buyer: run.buyer });
      r.started = true; saveRun(r);
      const res = await backend.start({ run_id: r.run_id, recipe_id: r.recipe_id, sealed_recipe: await sealedFor(r), sealed_inputs: r.sealed_inputs });
      // unreachable: the run is paid and Pending, so keep it alive; followRunner resumes it once the runner answers
      if (!res.ok && !res.unreachable) { pushEv(r, 'runner', 'failed', { error: res.error ?? 'runner refused the run' }); return; }
      void followRunner(r);
      return;
    }
    if (run && run.status !== 'Pending') { pushEv(r, 'chain', 'run_not_pending', { status: run.status }); return; }
    await sleep(2000);
  }
  pushEv(r, 'market', 'payment_timeout', { waited_s: PAY_TIMEOUT_MS / 1000 });
}

// ---- HTTP ----
const app = express();
app.disable('x-powered-by'); // no framework banner in responses
app.set('trust proxy', 'loopback');
mountDemoProxy(app); // /demo: the guided demo, before the body parser
app.use(express.json({ limit: '2mb' }));
class BadRequest extends Error {}
const guard = (fn: (req: express.Request, res: express.Response) => unknown) => async (req: express.Request, res: express.Response) => {
  // 500, not 502: Cloudflare replaces an origin's 502 with its own error page, hiding the message from the visitor
  try { await fn(req, res); } catch (e) { if (!(e instanceof BadRequest)) console.error(`[live] ${req.method} ${req.path}: ${(e as Error).message}`); res.status(e instanceof BadRequest ? 400 : 500).json({ error: (e as Error).message }); }
};
const runnerOnly: express.RequestHandler = (req, res, next) => { if (!tokenMatches(req.get('x-runner-token'), RUNNER_TOKEN)) { res.status(401).json({ error: 'runner token required' }); return; } next(); };

/** what the runner is, from its own attestation when SRS_RUNNER_TEE does not say (cached; unknown while unreachable) */
let teeLabel: { at: number; label: string } | undefined;
async function runnerTee(): Promise<string> {
  if (env.SRS_RUNNER_TEE) return env.SRS_RUNNER_TEE;
  if (teeLabel && Date.now() - teeLabel.at < 10 * 60_000) return teeLabel.label;
  const a = await backend.attestation(randomBytes(16).toString('hex')).catch(() => null) as { tee?: string } | null;
  if (!a?.tee) return 'runner unreachable (TEE unknown)';
  const label = a.tee === 'dstack-tdx' ? 'Intel TDX (dstack)' : a.tee === 'local-dev' ? 'local-dev runner (no hardware quote)' : a.tee;
  teeLabel = { at: Date.now(), label };
  return label;
}
app.get('/api/mode', guard(async (_, res) => {
  const cfg = await chain.view<Config>('get_config');
  res.json({ mode: NETWORK, contract_id: CONTRACT_ID, payment_token: cfg.payment_token, runner_id: RUNNER_ID, runner_url: '/runner', relayer: chain.relayerId, rpc_url: RPC, faucet: !!faucet,
    services: { contract: `${CONTRACT_ID} on ${NETWORK}`, data: 'FastNEAR / NEAR RPC (mainnet, read-only)', ai: 'NEAR AI Cloud', tee: await runnerTee() }, retired: [...RETIRED] });
}));
app.get('/api/chain/config', guard(async (_, res) => { res.json({ ...(await chain.view<Config>('get_config')), contract_id: CONTRACT_ID, network: NETWORK }); }));
app.get('/api/chain/recipes/:id', guard(async (req, res) => { const r = await chain.view<Recipe | null>('get_recipe', { recipe_id: String(req.params.id) }); r ? res.json(r) : res.status(404).json({ error: 'no recipe' }); }));
app.get('/api/chain/runs/:id', guard(async (req, res) => { const r = await chain.view<Run | null>('get_run', { run_id: String(req.params.id) }); r ? res.json(r) : res.status(404).json({ error: 'no run' }); }));
app.get('/api/chain/runners/:id', guard(async (req, res) => { const r = await chain.view<unknown>('get_runner', { runner_id: String(req.params.id) }); r ? res.json(r) : res.status(404).json({ error: 'no runner' }); }));

// runner → relayer: signed reports (the contract verifies the runner's signature)
app.post('/api/chain/report_run', runnerOnly, guard(async (req, res) => {
  const tx = await chain.relay('report_run', req.body, 150);
  const r = runs.get(String(req.body.run_id));
  if (r) pushEv(r, 'chain', tx.ok ? 'settled' : 'report_rejected', { tx: tx.tx_hash, url: explorer(tx.tx_hash), events: tx.events, error: tx.error });
  if (!tx.ok) { res.status(400).json({ error: tx.error, tx: tx.tx_hash }); return; }
  res.json({ tx: tx.tx_hash, url: explorer(tx.tx_hash), payouts: tx.value, events: tx.events });
}));
app.post('/api/chain/checkpoint_run', runnerOnly, guard(async (req, res) => {
  const tx = await chain.relay('checkpoint_run', req.body, 150);
  if (!tx.ok) { res.status(400).json({ error: tx.error, tx: tx.tx_hash }); return; }
  res.json({ tx: tx.tx_hash, url: explorer(tx.tx_hash), payouts: tx.value });
}));
app.post('/api/internal/checkpoints', runnerOnly, guard(async (req, res) => {
  const c = req.body as CheckpointRecord;
  const r = runs.get(c.run_id); if (!r) throw new BadRequest('unknown run');
  if (c.envelope?.purpose !== 'state' || sealedHash(c.envelope) !== c.state_hash) throw new BadRequest('bad checkpoint');
  if (!r.checkpoint || c.local_seq > r.checkpoint.local_seq) { store.put(c.envelope); r.checkpoint = c; saveRun(r); }
  res.json({ ok: true, stored: r.checkpoint.local_seq });
}));

// attestation: straight from the runner (signed by its key, bound to the caller's nonce) + the registered keys
app.get('/runner/attestation', guard(async (req, res) => {
  const nonce = String(req.query.nonce ?? '');
  if (!/^[0-9a-f]{16,128}$/i.test(nonce)) throw new BadRequest('nonce must be 16-128 hex characters');
  const r = await fetch(`${RUNNER}/attestation?nonce=${nonce}`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  res.status(r.status).type('application/json').send(await r.text());
}));
/** Intel's collateral for the runner's TDX quote, so browsers can run the DCAP check themselves (server/src/tee-collateral.ts) */
const teeCollateral = collateralCache(async () => (await backend.attestation(randomBytes(32).toString('hex')) as { quote?: string | null }).quote);
app.get('/api/tee/collateral', guard(async (_, res) => { res.set('cache-control', 'public, max-age=600'); res.json(await teeCollateral()); }));
app.get('/api/runner/attestation', guard(async (req, res) => {
  res.json({ attestation: await backend.attestation(String(req.query.nonce ?? '')), onchain: await chain.view('get_runner', { runner_id: RUNNER_ID }) });
}));

/** after the creator's publish_recipe landed: store the sealed recipe if it is exactly what the chain committed to */
app.post('/api/publish', guard(async (req, res) => {
  const { listing, sealed, creator_copy, tx } = req.body as { listing: PublicListing; sealed: SealedEnvelope; creator_copy?: SealedEnvelope; tx?: string };
  if (sealed?.v !== 'srs-seal-v1' || sealed.purpose !== 'recipe') throw new BadRequest('expected a sealed recipe envelope');
  if ((listing as unknown as Record<string, unknown>).nodes) throw new BadRequest('refusing plaintext recipe: only the public listing may be sent');
  // the creator's transaction just executed: read the latest executed state, not only finalized blocks
  const onchain = await chain.view<Recipe | null>('get_recipe', { recipe_id: listing.ticker }, CONTRACT_ID, 'optimistic');
  if (!onchain) throw new BadRequest(`${listing.ticker} is not published on ${CONTRACT_ID}; send publish_recipe first`);
  const h = sealedHash(sealed);
  if (onchain.sealed_hash !== h) throw new BadRequest('sealed recipe does not match the on-chain sealed_hash');
  if (onchain.creator !== listing.creator) throw new BadRequest('listing creator does not match the on-chain creator');
  if (onchain.runner_id !== RUNNER_ID) throw new BadRequest('recipe is assigned to a different runner');
  const runner = await chain.view<{ enc_pk_hex: string }>('get_runner', { runner_id: RUNNER_ID });
  if (sealed.to !== runner.enc_pk_hex) throw new BadRequest('envelope is not sealed to the registered runner key');
  const labels = labelsFromParts(onchain.parts, catalog);
  const e = (vault.recipes[listing.ticker] ??= { versions: [], creator_copies: {} });
  store.put(sealed);
  if (!e.versions.includes(h)) e.versions.push(h);
  if (creator_copy?.purpose === 'creator-copy') e.creator_copies[h] = store.put(creator_copy);
  saveVault();
  listings[listing.ticker] = { ...listing, parts: onchain.parts, risk: labels.risk, disclosures: labels.disclosures, privacy: labels.privacy, capabilities: labels.capabilities, published_at: new Date().toISOString(), publish_tx: tx };
  saveListings();
  res.json({ ok: true, sealed_hash: h });
}));

/** what one run pays each party (the contract's own split), in the shape the web app's record uses (USDC units → numbers) */
interface SplitView { price: string; protocol: string; runner: string; parts: string[]; remainder: string; reserve: string; creator: string }
const U = 1e6;
function recordOf(r: Recipe, q: SplitView | null) {
  const x = r as Recipe & { promised_total?: string; delivered_total?: string; compensated_total?: string; bond_locked?: string };
  return {
    pricePerRun: Number(r.price_per_run) / U, runs: Number(r.runs), failed: Number(r.failed), aborted: Number(r.aborted), revenue: Number(r.revenue) / U,
    keptPromise: Number(x.promised_total ?? 0) > 0 ? Number(x.delivered_total) / Number(x.promised_total) : null,
    deposit: { available: Number(r.bond_available) / U, locked: Number(x.bond_locked ?? 0) / U, paidToBuyers: Number(x.compensated_total ?? 0) / U },
    perRun: q && { price: Number(q.price) / U, protocol: Number(q.protocol) / U, runner: Number(q.runner) / U, parts: q.parts.map((a, i) => ({ part: r.parts[i], amount: Number(a) / U })), creator: Number(q.creator) / U, reserve: Number(q.reserve) / U, reserveBps: r.reserve_bps },
  };
}
app.get('/api/listings', guard(async (_, res) => {
  const out = await Promise.all(Object.values(listings).filter((l) => !RETIRED.has(l.ticker)).map(async (l) => {
    const onchain = await chain.view<Recipe | null>('get_recipe', { recipe_id: l.ticker }).catch(() => null);
    if (retired(l.ticker, onchain)) return null;
    const split = onchain ? await chain.view<SplitView>('quote_settlement', { recipe_id: l.ticker }).catch(() => null) : null;
    return { ...l, onchain, record: onchain ? recordOf(onchain, split) : null };
  }));
  res.json(out.filter((l) => l !== null));
}));

// ---- read-only feeds for the docs pages (Spec, Trust & privacy) and the landing page ----
/** the part catalog, limited to the parts registered on this contract, with their on-chain author and fee */
let partsCache: { at: number; parts: { id: string; author: string; manifest_hash: string; fee_per_call: string; active: boolean }[] } | null = null;
async function registeredParts() {
  if (partsCache && Date.now() - partsCache.at < 5 * 60_000) return partsCache.parts;
  const parts: { id: string; author: string; manifest_hash: string; fee_per_call: string; active: boolean }[] = [];
  for (let from = 0; ; from += 100) { const page = await chain.view<typeof parts>('list_parts', { from_index: from, limit: 100 }); parts.push(...page); if (page.length < 100) break; }
  partsCache = { at: Date.now(), parts };
  return parts;
}
app.get('/api/catalog', guard(async (_, res) => {
  const reg = new Map((await registeredParts()).map((p) => [p.id, p]));
  const parts = catalog.parts.filter((p) => reg.has(p.id)).map((p) => ({ ...p, author: reg.get(p.id)!.author, fee_per_call: reg.get(p.id)!.fee_per_call }));
  res.json({ ...catalog, parts, onchain: Object.fromEntries([...reg].map(([k, b]) => [k, { author: b.author, manifest_hash: b.manifest_hash, fee_per_call: b.fee_per_call, active: b.active }])) });
}));
/** the sealed recipe this marketplace holds for a listing: ciphertext only (what the Trust page shows next to the on-chain hash) */
app.get('/api/vault/:ticker', guard(async (req, res) => {
  const r = await chain.view<Recipe | null>('get_recipe', { recipe_id: String(req.params.ticker) });
  const env = r && vault.recipes[r.id]?.versions.includes(r.sealed_hash) ? store.get(r.sealed_hash) : null;
  env ? res.json({ envelope: env, sealed_hash: r!.sealed_hash }) : res.status(404).json({ error: 'not found' });
}));
// the demo's contract-event and 1Click logs have no live counterpart here: events are on the explorer, and live runs do not use 1Click
app.get('/api/chain/events', (_, res) => { res.json({ height: 0, events: [] }); });
app.get('/api/intents/log', (_, res) => { res.json([]); });

const QUOTES_PER_MINUTE = 12;
const quoteLog = new Map<string, number[]>();
app.post('/api/quotes', guard(async (req, res) => {
  // per visitor: behind the tunnel every request comes from 127.0.0.1, so use the address Cloudflare reports
  const ip = req.get('cf-connecting-ip') ?? req.ip ?? 'local', now = Date.now();
  const recent = (quoteLog.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= QUOTES_PER_MINUTE) throw new BadRequest('too many quote requests in the last minute');
  quoteLog.set(ip, [...recent, now]);
  const { recipe_id, sealed_job, job_hash, buyer } = req.body as { recipe_id: string; sealed_job: SealedEnvelope; job_hash: string; buyer: string };
  if (retired(recipe_id)) throw new BadRequest(RETIRED_MSG);
  if (typeof buyer !== 'string' || !/^[a-z0-9._-]{2,64}$/.test(buyer)) throw new BadRequest('buyer account required');
  if (!/^[0-9a-f]{64}$/.test(job_hash ?? '') || sealed_job?.purpose !== 'inputs') throw new BadRequest('expected sealed inputs and their job_hash');
  const l = listings[String(recipe_id)];
  const r = l && await chain.view<Recipe | null>('get_recipe', { recipe_id: l.ticker });
  if (!l || !r) throw new BadRequest('unknown recipe');
  if (retired(l.ticker, r)) throw new BadRequest(RETIRED_MSG);
  if (!vault.recipes[l.ticker]?.versions.includes(r.sealed_hash)) throw new BadRequest('this marketplace does not hold the current sealed version');
  const q = await backend.quote({ recipe_id: l.ticker, sealed_recipe: store.get(r.sealed_hash), sealed_job, job_hash, buyer });
  res.json({ quote: { recipe_id: l.ticker, ok: !!q.ok, error: q.error, sealed_quote: q.sealed_quote, sealed_error: (q as { sealed_error?: unknown }).sealed_error,
    listing: { ticker: l.ticker, name: l.name, creator: l.creator, price_per_run: r.price_per_run, price_floor: r.price_floor, price_ceiling: r.price_ceiling, privacy: l.privacy, risk: l.risk, disclosures: l.disclosures, parts: l.parts, output_type: l.output_type },
    track: { runs: r.runs, failed: r.failed, aborted: r.aborted, bond_available: r.bond_available } } });
}));

/** a run ticket: the msg the buyer attaches to ft_transfer_call(tUSDC → contract, price) */
app.post('/api/runs/prepare', guard(async (req, res) => {
  const { recipe_id, buyer, sealed_inputs, signed_quote: sq, max_price } = req.body as { recipe_id: string; buyer: string; sealed_inputs: SealedEnvelope; signed_quote?: { sealed_hash: string; job_hash: string; price: string; expected: string; promised: string; cover: string; expires_ns: string; signature: string }; max_price?: string };
  if (typeof buyer !== 'string' || !/^[a-z0-9._-]{2,64}$/.test(buyer)) throw new BadRequest('buyer account required');
  if (typeof recipe_id !== 'string' || retired(recipe_id)) throw new BadRequest(typeof recipe_id === 'string' ? RETIRED_MSG : 'recipe_id required');
  const r = await chain.view<Recipe | null>('get_recipe', { recipe_id }); if (!r) throw new BadRequest('unknown recipe');
  // a run is only ever prepared for a listing this marketplace offers and its runner can run
  if (retired(recipe_id, r)) throw new BadRequest(RETIRED_MSG);
  const runner = await chain.view<{ enc_pk_hex: string }>('get_runner', { runner_id: RUNNER_ID });
  if (sealed_inputs?.purpose !== 'inputs' || sealed_inputs.to !== runner.enc_pk_hex) throw new BadRequest('inputs must be sealed to the recipe runner');
  const price = sq ? sq.price : r.price_per_run;
  if (max_price !== undefined && BigInt(price) > BigInt(max_price)) throw new BadRequest('price is above your max price');
  const run_id = 'r-' + randomBytes(6).toString('hex');
  const msg = JSON.stringify({ action: 'run', recipe_id, run_id, inputs_hash: sealedHash(sealed_inputs), on_behalf_of: buyer, ...(max_price !== undefined ? { max_price: String(max_price) } : {}), ...(sq ? { quote: sq } : {}) });
  const ctx: RunCtx = { run_id, token: randomBytes(24).toString('hex'), recipe_id, buyer, sealed_inputs, msg, price, started: false, done: false, events: [], created: Date.now() };
  runs.set(run_id, ctx); saveRun(ctx);
  const cfg = await chain.view<Config>('get_config');
  res.json({ run_id, run_token: ctx.token, pay: { contract: cfg.payment_token, method: 'ft_transfer_call', args: { receiver_id: CONTRACT_ID, amount: price, msg }, deposit_yocto: '1', gas_tgas: 150 } });
}));
const runFor = (req: express.Request) => {
  const r = runs.get(String(req.params.id));
  if (!r || String(req.query.token ?? req.get('x-run-token') ?? '') !== r.token) throw new BadRequest('unknown run or missing run token');
  return r;
};
/** the buyer says it paid (optionally with the tx hash): watch the chain and start the run */
app.post('/api/runs/:id/paid', guard(async (req, res) => {
  const r = runFor(req);
  if (r.started) { res.json({ ok: true, already: true }); return; }
  const tx = typeof req.body?.tx_hash === 'string' && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(req.body.tx_hash) ? req.body.tx_hash : undefined;
  void watchPayment(r, tx);
  res.json({ ok: true, watching: true });
}));
/**
 * Resume a paid run that stopped before its report reached the chain (the run is still Pending): the runner re-opens
 * the sealed recipe and inputs, continues from the last checkpoint and reports. Idempotent while the run is executing.
 */
app.post('/api/runs/:id/resume', guard(async (req, res) => {
  const r = runFor(req);
  const run = await chain.view<Run | null>('get_run', { run_id: r.run_id });
  if (run?.status !== 'Pending') throw new BadRequest(`the run is ${run?.status ?? 'unknown'} on-chain, not Pending`);
  const out = await backend.resume(r.run_id, { recipe_id: r.recipe_id, sealed_recipe: await sealedFor(r), sealed_inputs: r.sealed_inputs, checkpoint: r.checkpoint ?? null, approvals: {} });
  if (!out.ok && out.status !== 409) throw new BadRequest(`runner refused to resume (${out.status})`);
  r.started = true; r.done = false; saveRun(r);
  pushEv(r, 'market', 'resume_requested', { checkpoint: r.checkpoint?.local_seq ?? null, manual: true });
  void followRunner(r);
  res.json({ ok: true, resumed: out.ok, already_running: out.status === 409 });
}));
app.get('/api/runs/:id/events', (req, res) => {
  let r: RunCtx; try { r = runFor(req); } catch { res.status(404).end(); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (e: Ev) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  r.events.forEach(send);
  const set = listeners.get(r.run_id) ?? new Set(); set.add(send); listeners.set(r.run_id, set);
  req.on('close', () => set.delete(send));
});

/** the result view asks for token decimals (for swap receipts); the read-only testnet recipes have none */
app.get('/api/tokens', (_, res) => { res.json([]); });

// ---- guest accounts: a key made in the browser, funded once by the testnet faucet ----
/** a guest is a NEAR implicit account (64 hex chars, the public key itself): it exists once it receives NEAR */
const isImplicit = (a: unknown): a is string => typeof a === 'string' && /^[0-9a-f]{64}$/.test(a);
const isAccount = (a: unknown): a is string => typeof a === 'string' && a.length >= 2 && a.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(a);
/** who was funded (account → day) and how often per IP and per day; only counts and hashes of IPs are kept */
interface FaucetLog { funded: Record<string, string>; minted?: Record<string, string>; ip: Record<string, number>; day: string; total: number }
const faucetLog = store.readMeta<FaucetLog>('faucet', { funded: {}, ip: {}, day: '', total: 0 });
faucetLog.minted ??= {};
/** the tUSDC half of funding a guest; retried, and finished on a later request if it still failed */
/** what registering a new tUSDC holder costs (NEP-145 storage_balance_bounds.min, about 0.00125 NEAR), read from the
 *  token: mint keeps whatever is attached, so the faucet attaches exactly this */
let storageMin: Promise<bigint> | undefined;
const tusdcStorage = (token: string) => (storageMin ??= chain.view<{ min: string }>('storage_balance_bounds', {}, token).then((b) => BigInt(b.min), (e) => { storageMin = undefined; throw e; }));
async function mintFor(account_id: string, token: string) {
  let last = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((ok) => setTimeout(ok, 1500 * attempt));
    try {
      const m = await faucet!.relay('mint', { account_id, amount: FAUCET_TUSDC.toString() }, 30, await tusdcStorage(token), token);
      if (m.ok) { faucetLog.minted![account_id] = new Date().toISOString().slice(0, 10); store.writeMeta('faucet', faucetLog); return m; }
      last = m.error ?? 'mint failed';
    } catch (e) { last = (e as Error).message; }
    console.error(`[live] faucet mint for a guest, attempt ${attempt + 1}: ${last}`);
  }
  throw new Error(`created the account but could not mint tUSDC: ${last}`);
}
const ipKey = (ip: string) => createHash('sha256').update('srs-faucet:' + ip).digest('hex').slice(0, 16);
let faucetBusy = Promise.resolve();

app.get('/api/account/:id/balance', guard(async (req, res) => {
  const id = String(req.params.id);
  if (!isAccount(id) || !id.endsWith('.testnet') && !isImplicit(id)) throw new BadRequest('a testnet account id is required');
  const cfg = await chain.view<Config>('get_config');
  const near = await chain.nearBalance(id);
  const tusdc = near === null ? '0' : await chain.view<string>('ft_balance_of', { account_id: id }, cfg.payment_token, 'optimistic');
  res.json({ account_id: id, exists: near !== null, near_yocto: (near ?? 0n).toString(), tusdc: String(tusdc), token: cfg.payment_token, faucet: !!faucet });
}));

/** fund a new guest account once: a little NEAR for gas (this creates the account) and some tUSDC to pay for runs */
app.post('/api/faucet', guard(async (req, res) => {
  if (!faucet) { res.status(503).json({ error: 'the faucet is not configured on this server' }); return; }
  const account_id = req.body?.account_id;
  if (!isImplicit(account_id)) throw new BadRequest('the faucet funds guest accounts only (64 hex characters)');
  // one request at a time, so the checks below and the counters cannot race
  const job = faucetBusy.then(async () => {
    const today = new Date().toISOString().slice(0, 10);
    if (faucetLog.day !== today) { faucetLog.day = today; faucetLog.ip = {}; faucetLog.total = 0; }
    if (faucetLog.funded[account_id]) {
      // funded earlier but its tUSDC never arrived: finish that part (no more NEAR)
      if (!faucetLog.minted![account_id]) {
        const cfg = await chain.view<Config>('get_config');
        const done = await chain.view<string>('ft_balance_of', { account_id }, cfg.payment_token, 'optimistic').catch(() => '0');
        if (BigInt(done) === 0n) { const m = await mintFor(account_id, cfg.payment_token); return { status: 200, body: { ok: true, account_id, tusdc: FAUCET_TUSDC.toString(), txs: [explorer(m.tx_hash)] } }; }
      }
      return { status: 409, body: { error: 'this guest account was already funded', funded_on: faucetLog.funded[account_id] } };
    }
    // this server listens on 127.0.0.1 only, so every request comes through the Cloudflare tunnel, which sets the visitor's address
    const ip = ipKey(req.get('cf-connecting-ip') ?? req.ip ?? 'unknown');
    if ((faucetLog.ip[ip] ?? 0) >= FAUCET_PER_IP_DAY) return { status: 429, body: { error: `at most ${FAUCET_PER_IP_DAY} guest accounts per day from one address; try again tomorrow` } };
    if (faucetLog.total >= FAUCET_PER_DAY) return { status: 429, body: { error: 'the faucet has given out its daily allowance; try again tomorrow' } };
    if ((await chain.nearBalance(account_id)) !== null) return { status: 409, body: { error: 'this account already exists; the faucet funds new guest accounts only' } };
    const cfg = await chain.view<Config>('get_config');
    const sent = await faucet.transferNear(account_id, FAUCET_NEAR);
    if (!sent.ok) throw new Error(`could not create the guest account: ${sent.error}`);
    faucetLog.funded[account_id] = today; faucetLog.ip[ip] = (faucetLog.ip[ip] ?? 0) + 1; faucetLog.total++;
    store.writeMeta('faucet', faucetLog);
    const minted = await mintFor(account_id, cfg.payment_token);
    return { status: 200, body: { ok: true, account_id, near_yocto: FAUCET_NEAR.toString(), tusdc: FAUCET_TUSDC.toString(), txs: [explorer(sent.tx_hash), explorer(minted.tx_hash)] } };
  });
  faucetBusy = job.then(() => undefined, () => undefined);
  const out = await job;
  res.status(out.status).json(out.body);
}));

// ---- the live web page (npm run build → web/dist/live.html); everything else under / is the built assets ----
const WEB = join(ROOT, 'web/dist');
if (existsSync(join(WEB, 'live.html'))) {
  app.get(['/', '/index.html'], (_, res) => { res.set('cache-control', 'no-cache'); res.sendFile(join(WEB, 'live.html')); });
  app.use('/assets', express.static(join(WEB, 'assets'), { immutable: true, maxAge: '30d', index: false }));
} else console.warn('[live] web/dist/live.html is missing: run npm run build to serve the page');

app.get('/healthz', (_, res) => res.json({ ok: true, mode: NETWORK, runs: runs.size, listings: Object.keys(listings).length }));

app.listen(PORT, '127.0.0.1', () => console.log(`[live] marketplace for ${CONTRACT_ID} on ${NETWORK}: http://127.0.0.1:${PORT} (runner ${RUNNER}, relayer ${chain.relayerId ?? 'none'}, faucet ${faucet?.relayerId ?? 'off'})`));
