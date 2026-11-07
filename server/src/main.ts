/**
 * Marketplace server (local mode).
 *  - /api/chain/*  : view/relay surface of the sealed-recipes contract (backed by LocalLedger)
 *  - /api/*        : marketplace (listings, sealed vault, runs, track records, wallet)
 *  - /mock/*       : offline stand-ins for FastNEAR, NEAR RPC, 1Click, NEAR AI Cloud
 *  - /             : the web app (web/dist)
 *
 * This process never sees a plaintext recipe or buyer input: publishing receives a
 * client-sealed envelope + public listing, runs receive client-sealed inputs.
 */
import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { LocalLedger, toJson, LedgerError, type SignedQuote } from '../../core/src/ledger.js';
import { hashObject, sha256Hex } from '../../core/src/canonical.js';
import { sealedHash, type SealedEnvelope } from '../../core/src/seal.js';
import { FileBlobStore, type VaultIndex } from './store.js';
import { TeeRunnerBackend } from './backends.js';
import { signNep413, type Nep413Payload, type SignedNep413 } from '../../core/src/nep413.js';
import { demoWalletKey } from '../../core/src/creator.js';
import { validateRecipe, labelsFromParts, type Catalog, type PublicListing } from '../../core/src/srs.js';
import { computeCodehash, loadCatalog } from '../../core/src/codehash.js';
import { runPaymentQuoteRequest, USDC_NEAR, type Token, type QuoteResponse } from '../../core/src/oneclick.js';
import { World } from './world.js';
import { mockRouter } from './mocks.js';
import { AgentMarketClient, agentMarketMock } from './agent-market.js';
import { Bounties, type Check } from './bounties.js';
import { seal, openQuote, jobHash } from '../../core/src/index.js';
import nacl from 'tweetnacl';
import { bytesToHex } from '@noble/hashes/utils.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const env = process.env;
const PORT = Number(env.PORT ?? 8080);
const RUNNER = env.RUNNER_URL ?? 'http://127.0.0.1:8787';
const CONTRACT_ID = env.CONTRACT_ID ?? 'sealed-recipes.testnet';
const RUNNER_ID = env.RUNNER_ID ?? 'tee-runner-1.testnet';
const PAYMENT_TOKEN = USDC_NEAR.replace(/^nep141:/, '');
const SOLVER = 'solver-relay.intents.testnet';
const RUNNER_TOKEN = env.RUNNER_TOKEN ?? '';
const RUNNER_PUBLIC_URL = env.RUNNER_PUBLIC_URL ?? RUNNER; // browsers fetch attestation from the runner directly
/** the execution backend (server/src/backends.ts); the marketplace never calls the runner any other way */
const backend = new TeeRunnerBackend(RUNNER, RUNNER_ID, RUNNER_TOKEN);

const catalog = loadCatalog(ROOT);
const tokens = JSON.parse(readFileSync(resolve(ROOT, 'fixtures/oneclick-tokens.json'), 'utf8')).tokens as Token[];
const world = new World(resolve(ROOT, 'fixtures/wallets.json'), resolve(ROOT, 'fixtures/oneclick-tokens.json'));
world.loadAirdrops(resolve(ROOT, 'fixtures/airdrops.json'));
/** notice period before a new recipe version takes effect (24 h is the suggested mainnet value; short for the demo) */
const UPDATE_DELAY_S = Number(env.SRS_UPDATE_DELAY_S ?? 30);
/** v6 pricing period: 1 h suggested on mainnet; 2 min in the demo so prices visibly follow demand */
const PRICE_PERIOD_S = Number(env.SRS_PRICE_PERIOD_S ?? 120);
const ledger = new LocalLedger({ contractId: CONTRACT_ID, owner: 'srs-dao.testnet', paymentToken: PAYMENT_TOKEN, protocolAccount: 'srs-treasury.testnet', protocolFeeBps: 200, updateDelayNs: BigInt(UPDATE_DELAY_S) * 1_000_000_000n, pricePeriodNs: BigInt(PRICE_PERIOD_S) * 1_000_000_000n });

// ---------- runs: per-run event log merged from payment (server) + execution (runner) ----------
type Ev = { seq: number; at: number; source: 'market' | 'intents' | 'runner' | 'chain'; type: string; data: Record<string, unknown> };
/** `token` is a capability returned only to the buyer who requested the quote: it gates the event stream and approvals. */
interface RunCtx { run_id: string; token: string; recipe_id: string; buyer: string; sealed_inputs: SealedEnvelope; inputs_hash: string; quote: QuoteResponse; events: Ev[]; listeners: Set<(e: Ev) => void>; started: boolean; approvalPending: boolean;
  /** durable runs: the latest checkpoint the runner stored (ciphertext sealed to the runner + its signature) */
  checkpoint?: CheckpointRecord;
  /** approvals relayed to the runner, by node: replayed on resume so the buyer is never asked to sign twice */
  approvals: Record<string, { approved: boolean; txHashes: string[]; signed?: SignedNep413 }>;
  approvalNode?: string; done: boolean }
interface CheckpointRecord { run_id: string; local_seq: number; state_hash: string; envelope: SealedEnvelope; signature: string }
const runs = new Map<string, RunCtx>();
const pushEv = (r: RunCtx, source: Ev['source'], type: string, data: Record<string, unknown>) => {
  const e: Ev = { seq: r.events.length, at: Date.now(), source, type, data };
  r.events.push(e); for (const l of r.listeners) l(e);
};

// ---------- mocks: a 1Click delivery to the contract == ft_transfer_call with customRecipientMsg ----------
const mocks = mockRouter(world, tokens, {
  onDelivered: (req, amountOut, depositAddress) => {
    const destContract = req.destinationAsset.replace(/^nep141:/, '');
    if (req.recipient === CONTRACT_ID && req.customRecipientMsg) {
      const msg = JSON.parse(req.customRecipientMsg) as { run_id?: string };
      const r = msg.run_id ? runs.get(msg.run_id) : undefined;
      try {
        ledger.call(PAYMENT_TOKEN, (l) => l.ft_on_transfer({ sender_id: SOLVER, amount: amountOut, msg: req.customRecipientMsg! }));
        const last = ledger.events.at(-1);
        if (r && !ledger.runs.has(r.run_id)) {
          // Intents delivery with on_behalf_of: the contract credited the buyer instead of opening the run
          pushEv(r, 'chain', 'payment_rejected', { error: String((last?.data[0] as { reason?: string })?.reason ?? 'rejected'), refunded_to: r.buyer, tx: last?.tx_hash });
          return;
        }
        if (r) pushEv(r, 'chain', 'run_requested', { tx: last?.tx_hash, height: ledger.height, amount: amountOut, solver: SOLVER, depositAddress });
        if (r) void startRunner(r);
      } catch (e) { if (r) pushEv(r, 'chain', 'payment_rejected', { error: (e as Error).message }); }
      return;
    }
    world.credit(req.recipient, destContract, BigInt(amountOut));
  },
});

async function startRunner(r: RunCtx) {
  if (r.started) return; r.started = true;
  const sealed = sealedFor(r);
  const res = await backend.start({ run_id: r.run_id, recipe_id: r.recipe_id, sealed_recipe: sealed, sealed_inputs: r.sealed_inputs });
  if (!res.ok) { pushEv(r, 'runner', 'failed', { error: res.error ?? 'runner refused the run' }); return; }
  void followRunner(r);
}

/** the exact version the run paid for (the vault keeps every version a pending run may need) */
function sealedFor(r: RunCtx): SealedEnvelope {
  const sh = ledger.runs.get(r.run_id)?.sealed_hash ?? ledger.recipes.get(r.recipe_id)!.sealed_hash;
  const env = vault.get(r.recipe_id)?.get(sh);
  if (!env) throw new Error(`vault has no version ${sh.slice(0, 12)}… of ${r.recipe_id}`);
  return env;
}

/**
 * Proxies the runner's event stream into the run log. If the stream breaks before the run finished (runner
 * crashed or restarted), the marketplace keeps asking the runner to resume from the last stored checkpoint.
 */
async function followRunner(r: RunCtx) {
  for (;;) {
    try {
      const sse = await backend.events(r.run_id);
      if (!sse.ok) throw new Error(`events ${sse.status}`);
      const reader = sse.body!.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!chunk.startsWith('data: ')) continue;
          const e = JSON.parse(chunk.slice(6)) as { seq: number; type: string; data: Record<string, unknown> };
          if (e.type === 'approval_pending') { r.approvalPending = true; r.approvalNode = String(e.data.node ?? ''); }
          pushEv(r, 'runner', e.type, e.data);
          if (e.type === 'completed' || e.type === 'failed') { r.done = true; await reader.cancel(); return; }
        }
      }
    } catch { /* stream broke: fall through to resume */ }
    if (r.done || ledger.runs.get(r.run_id)?.status !== 'Pending') return;
    pushEv(r, 'market', 'runner_lost', { checkpoint: r.checkpoint?.local_seq ?? null });
    r.approvalPending = false;
    // ask the (restarted) runner to continue from the last checkpoint; retry until it is back
    for (let attempt = 0; ; attempt++) {
      await new Promise((ok) => setTimeout(ok, Math.min(5000, 500 + attempt * 500)));
      if (ledger.runs.get(r.run_id)?.status !== 'Pending') return;
      try {
        const res = await backend.resume(r.run_id, { recipe_id: r.recipe_id, sealed_recipe: sealedFor(r), sealed_inputs: r.sealed_inputs, checkpoint: r.checkpoint ?? null, approvals: r.approvals });
        if (res.ok || res.status === 409) { pushEv(r, 'market', 'resume_requested', { checkpoint: r.checkpoint?.local_seq ?? null, attempt: attempt + 1 }); break; }
      } catch { /* runner still down */ }
    }
  }
}

// ---------- marketplace state ----------
/** ticker → sealed_hash → sealed recipe (ciphertext only). Every version is kept: a run paid for version N must
 *  still execute version N after version N+1 takes effect. Production: a durable store keyed the same way. */
// Durable content-addressed store (server/src/store.ts). The local contract mirror is in memory, so the demo
// uses a fresh directory per boot; point SRS_STORE_DIR at a persistent path (or swap in IPFS/S3) in production.
const store = new FileBlobStore(env.SRS_STORE_DIR ?? resolve(ROOT, '.data/store', `local-${Date.now()}`));
const vaultIndex = store.readMeta<VaultIndex>('vault', { recipes: {} });
const saveIndex = () => store.writeMeta('vault', vaultIndex);
const vaultPut = (ticker: string, sealed: SealedEnvelope, creatorCopy?: SealedEnvelope) => {
  const e = (vaultIndex.recipes[ticker] ??= { versions: [], creator_copies: {} });
  const h = store.put(sealed);
  if (!e.versions.includes(h)) e.versions.push(h);
  if (creatorCopy) {
    if (creatorCopy.purpose !== 'creator-copy') throw new LedgerError('creator copy must be sealed with purpose "creator-copy"');
    e.creator_copies[h] = store.put(creatorCopy);
  }
  saveIndex();
  return h;
};
const vault = { get: (ticker: string) => ({ get: (h: string) => (vaultIndex.recipes[ticker]?.versions.includes(h) ? store.get(h) : undefined) }) };
const currentSealed = (ticker: string) => vault.get(ticker).get(ledger.recipes.get(ticker)?.sealed_hash ?? '');
const listings = new Map<string, PublicListing & { published_at: string; settle_mode?: string }>();
const USDC = 1e6;
const settlementsOf = (t: string) => ledger.events.filter((e) => e.event === 'srs_settlement' && (e.data[0] as { recipe_id: string }).recipe_id === t);
/** A recipe's public track record, read from the contract mirror. No prices of anything but the run itself:
 *  nothing here is an investment, so there is nothing to quote but the service. */
const eventsOf = (name: string, t: string) => ledger.events.filter((e) => e.event === name && (e.data[0] as { recipe_id: string }).recipe_id === t);
/** price and demand per pricing period, oldest first: what drove each move of the list price */
const priceHistory = (t: string, n = 24) => {
  const r = ledger.get_recipe(t)!;
  const P = ledger.pricePeriodNs;
  const paid = eventsOf('run_requested', t).map((e) => BigInt(e.timestamp_ns));
  const moves = eventsOf('price_updated', t).map((e) => ({ at: BigInt(e.timestamp_ns), price: BigInt((e.data[0] as { price: string }).price), previous: BigInt((e.data[0] as { previous: string }).previous) }));
  const pub = ledger.events.find((e) => e.event === 'recipe_published' && (e.data[0] as { id: string }).id === t); // the full Recipe: keyed by `id`
  const published = BigInt(pub?.timestamp_ns ?? r.period_start_ns);
  const out: { start_ns: string; runs: number; price: number }[] = [];
  for (let k = n - 1; k >= 0; k--) {
    const start = r.period_start_ns - BigInt(k) * P;
    if (start + P <= published) continue;
    const end = start + P;
    const runsIn = paid.filter((x) => x >= start && x < end).length;
    // the list price in force during this period: ended periods are applied at the next boundary (the keeper does it
    // within a second, a payment does it at once), so the last move applied before this period ended sets its price
    const before = moves.filter((m) => m.at < end).at(-1);
    const price = k === 0 ? r.price_per_run : before ? before.price : moves[0] ? moves[0].previous : r.price_per_run;
    out.push({ start_ns: start.toString(), runs: runsIn, price: Number(price) / USDC });
  }
  return out;
};
const record = (t: string) => {
  const r = ledger.get_recipe(t)!;
  const q = ledger.quote_settlement(t, r.parts);
  const settled = settlementsOf(t);
  const reserved = settled.reduce((a, e) => a + Number((e.data[0] as { reserve: string }).reserve), 0) / USDC;
  return {
    ticker: t, name: r.name, creator: r.creator, pricePerRun: Number(r.price_per_run) / USDC,
    pricing: { floor: Number(r.price_floor) / USDC, ceiling: Number(r.price_ceiling) / USDC, targetRuns: r.target_runs, periodRuns: Number(r.period_runs),
      periodS: Number(ledger.pricePeriodNs / 1_000_000_000n), periodEndsMs: Number((r.period_start_ns + ledger.pricePeriodNs) / 1_000_000n),
      fixed: r.price_floor === r.price_ceiling },
    history: priceHistory(t),
    runs: Number(r.runs), failed: Number(r.failed), aborted: Number(r.aborted), revenue: Number(r.revenue) / USDC,
    keptPromise: r.promised_total > 0n ? Number((r.delivered_total * 10000n) / r.promised_total) / 10000 : null,
    deposit: { available: Number(r.bond_available) / USDC, locked: Number(r.bond_locked) / USDC, paidToBuyers: Number(r.compensated_total) / USDC, fromRuns: reserved },
    perRun: { price: Number(q.price) / USDC, protocol: Number(q.protocol) / USDC, runner: Number(q.runner) / USDC, parts: q.parts.map((x, i) => ({ part: r.parts[i], amount: Number(x) / USDC })), creator: Number(q.creator) / USDC, reserve: Number(q.reserve) / USDC, reserveBps: r.reserve_bps },
  };
};

const app = express();
app.use('/mock', mocks.router);
app.use(express.json({ limit: '2mb' }));
const j = (res: express.Response, v: unknown) => res.json(toJson(v));
const guard = (fn: (req: express.Request, res: express.Response) => unknown) => async (req: express.Request, res: express.Response) => {
  try { await fn(req, res); } catch (e) { res.status(e instanceof LedgerError ? 400 : 500).json({ error: (e as Error).message }); }
};

// ---- chain surface (contract views + relayer) ----
app.get('/api/chain/config', (_, res) => j(res, { contract_id: CONTRACT_ID, owner: ledger.owner, payment_token: ledger.paymentToken, protocol_account: ledger.protocolAccount, protocol_fee_bps: ledger.protocolFeeBps, height: ledger.height, network: 'local-mirror' }));
app.get('/api/chain/recipes/:id', (req, res) => { const r = ledger.get_recipe(String(req.params.id)); r ? j(res, r) : res.status(404).json({ error: 'no recipe' }); });
app.get('/api/chain/runs/:id', (req, res) => { const r = ledger.runs.get(String(req.params.id)); r ? j(res, r) : res.status(404).json({ error: 'no run' }); });
app.get('/api/chain/runners/:id', (req, res) => { const r = ledger.runners.get(String(req.params.id)); r ? j(res, r) : res.status(404).json({ error: 'no runner' }); });
app.get('/api/chain/parts', (_, res) => j(res, [...ledger.parts.values()]));
app.get('/api/chain/events', (req, res) => { const since = req.query.last ? Math.max(0, ledger.events.length - Number(req.query.last)) : Number(req.query.since ?? 0); j(res, { height: ledger.height, events: ledger.events.slice(since).map((e, i) => ({ idx: since + i, ...e })) }); });
app.post('/api/chain/report_run', guard((req, res) => {
  const payouts = ledger.call('relayer.srs.testnet', (l) => l.report_run(req.body));
  const run = ledger.runs.get(req.body.run_id);
  const r = runs.get(req.body.run_id);
  const ev = ledger.events.at(-1)!;
  if (r) pushEv(r, 'chain', ev.event, { tx: ev.tx_hash, height: ev.block_height, ...ev.data[0] });
  j(res, { status: run?.status, payouts, tx: ev.tx_hash, height: ev.block_height });
}));
app.post('/api/chain/checkpoint_run', guard((req, res) => {
  const payouts = ledger.call('relayer.srs.testnet', (l) => l.checkpoint_run(req.body));
  const ev = ledger.events.at(-1)!;
  const r = runs.get(req.body.run_id);
  if (r) pushEv(r, 'chain', ev.event, { tx: ev.tx_hash, height: ev.block_height, ...ev.data[0] });
  j(res, { payouts, tx: ev.tx_hash, height: ev.block_height });
}));
/** Durable runs: the runner stores each checkpoint here before moving on (ciphertext only the runner can open,
 *  plus its signature). Runner-authenticated; the latest checkpoint is replayed on resume. */
app.post('/api/internal/checkpoints', guard((req, res) => {
  if (RUNNER_TOKEN && req.get('x-runner-token') !== RUNNER_TOKEN) { res.status(401).json({ error: 'runner token required' }); return; }
  const c = req.body as CheckpointRecord;
  const r = runs.get(c.run_id); if (!r) throw new LedgerError('unknown run');
  if (c.envelope?.purpose !== 'state' || sealedHash(c.envelope) !== c.state_hash) throw new LedgerError('bad checkpoint');
  if (!r.checkpoint || c.local_seq > r.checkpoint.local_seq) {
    store.put(c.envelope); // durable before the runner is told it may continue
    store.writeMeta(`checkpoint-${c.run_id}`, { ...c, envelope: undefined });
    r.checkpoint = c;
  }
  j(res, { ok: true, stored: r.checkpoint.local_seq });
}));
/** Versions with notice: the creator announces a new sealed version; it takes effect after the notice period. */
app.post('/api/recipes/:ticker/update', guard((req, res) => {
  const t = String(req.params.ticker);
  const { signer, sealed, creator_copy } = req.body as { signer: string; sealed: SealedEnvelope; creator_copy?: SealedEnvelope };
  if (sealed?.v !== 'srs-seal-v1' || sealed.purpose !== 'recipe') throw new LedgerError('expected a sealed recipe envelope');
  if (sealed.to !== ledger.runners.get(RUNNER_ID)!.enc_pk_hex) throw new LedgerError('envelope is not sealed to the registered runner key');
  ledger.call(signer, (l) => l.update_sealed({ id: t, sealed_hash: sealedHash(sealed) }));
  vaultPut(t, sealed, creator_copy); // stored now, served once it takes effect; older versions are kept
  const ev = ledger.events.at(-1)!;
  j(res, { ...(ev.data[0] as object), tx: ev.tx_hash });
}));
app.post('/api/recipes/:ticker/cancel-update', guard((req, res) => {
  ledger.call(String(req.body.signer), (l) => l.cancel_update({ id: String(req.params.ticker) }));
  j(res, { ok: true });
}));

/** local demo only: crash the runner process (it is restarted by the launcher) */
if (env.SRS_ALLOW_CRASH === '1') app.post('/api/dev/crash-runner', guard(async (_, res) => { await backend.crash(); j(res, { ok: true }); }));

/** local demo only: make the solver back out of fills for an asset, to show an atomic bundle reverting */
if (env.SRS_ALLOW_CRASH === '1') app.post('/api/dev/solver-fail', guard((req, res) => { const a = String(req.body.asset ?? ''); req.body.on === false ? mocks.verifier.failing.delete(a) : mocks.verifier.failing.add(a); j(res, { failing: [...mocks.verifier.failing] }); }));
if (env.SRS_ALLOW_CRASH === '1') app.post('/api/dev/verifier-withdraw', guard((req, res) => j(res, { withdrawn: mocks.verifier.withdrawAll(String(req.body.account)) })));
app.get('/api/intents/verifier/:account', (req, res) => j(res, { account: req.params.account, balances: Object.fromEntries(mocks.verifier.balances.get(String(req.params.account)) ?? []), log: mocks.verifier.log.slice(-20) }));

/** demo wallet: sign "as" an account. Local mode only — testnet mode uses a real NEAR wallet. */
const ALLOWED = new Set(['register_part', 'withdraw', 'withdraw_bond', 'set_pricing']);
app.post('/api/chain/tx', guard((req, res) => {
  const { signer, method, args } = req.body as { signer: string; method: string; args: Record<string, string> };
  if (!ALLOWED.has(method) && method !== 'bond') throw new LedgerError('method not allowed from demo wallet');
  let out: unknown;
  if (method === 'bond') {
    // top up a recipe's guarantee deposit: ft_transfer_call with {"action":"bond"} (anyone may add; only the creator withdraws)
    out = ledger.call(PAYMENT_TOKEN, (l) => l.ft_on_transfer({ sender_id: signer, amount: args.amount, msg: JSON.stringify({ action: 'bond', recipe_id: args.recipe_id }) }));
  } else {
    out = ledger.call(signer, (l) => (l as unknown as Record<string, (a: unknown) => unknown>)[method](args));
  }
  const ev = ledger.events.at(-1);
  j(res, { ok: true, result: out, tx: ev?.tx_hash, height: ledger.height });
}));

// ---- marketplace ----
app.get('/api/mode', (_, res) => j(res, {
  mode: 'local', contract_id: CONTRACT_ID, runner_id: RUNNER_ID, runner_url: RUNNER_PUBLIC_URL,
  services: { fastnear: 'mock', rpc: 'mock', oneclick: 'fixture (frozen token sample)', nearai: 'mock (real secp256k1 signatures, no hardware quote)', tee: 'local-dev runner (no hardware quote)' },
  ai_signing_address: mocks.aiSigningAddress,
}));
app.get('/api/catalog', (_, res) => j(res, { ...catalog, onchain: Object.fromEntries([...ledger.parts].map(([k, b]) => [k, { author: b.author, manifest_hash: b.manifest_hash, fee_per_call: b.fee_per_call, active: b.active }])) }));
app.get('/api/listings', (_, res) => j(res, [...listings.values()].map((l) => ({ ...l, record: record(l.ticker), onchain: ledger.get_recipe(l.ticker) }))));
app.get('/api/vault/:ticker', (req, res) => { const v = currentSealed(String(req.params.ticker)); v ? res.json({ envelope: v, sealed_hash: sealedHash(v) }) : res.status(404).json({ error: 'not found' }); });
app.get('/api/vault/:ticker/versions', (req, res) => { const t = String(req.params.ticker); const r = ledger.recipes.get(t); if (!r) { res.status(404).json({ error: 'not found' }); return; }
  const e = vaultIndex.recipes[t];
  j(res, { current: r.sealed_hash, version: r.version, pending: r.pending_sealed_hash || null, effective_ns: r.update_effective_ns, stored: e?.versions ?? [], creator_copies: Object.keys(e?.creator_copies ?? {}) }); });
/** the creator's own copy of a version (sealed to a key derived from the creator's wallet signature) */
app.get('/api/vault/:ticker/creator-copy', (req, res) => {
  const t = String(req.params.ticker); const r = ledger.recipes.get(t);
  const h = String(req.query.version ?? r?.sealed_hash ?? '');
  const c = vaultIndex.recipes[t]?.creator_copies[h];
  const env = c ? store.get(c) : undefined;
  env ? j(res, { sealed_hash: h, creator: r?.creator, envelope: env }) : res.status(404).json({ error: 'no creator copy for that version' });
});
app.get('/api/runner/attestation', guard(async (req, res) => {
  const a = await backend.attestation(String(req.query.nonce ?? ''));
  j(res, { attestation: a, onchain: ledger.runners.get(RUNNER_ID) });
}));

app.post('/api/publish', guard((req, res) => {
  const { listing, sealed, bond, settle_mode, creator_copy } = req.body as { listing: PublicListing; sealed: SealedEnvelope; bond?: string; settle_mode?: string; creator_copy?: SealedEnvelope };
  if (sealed?.v !== 'srs-seal-v1' || sealed.purpose !== 'recipe') throw new LedgerError('expected a sealed recipe envelope');
  const runner = ledger.runners.get(RUNNER_ID)!;
  if (sealed.to !== runner.enc_pk_hex) throw new LedgerError('envelope is not sealed to the registered runner key');
  if ((listing as unknown as Record<string, unknown>).nodes) throw new LedgerError('refusing plaintext recipe: only the public listing may be sent');
  try { labelsFromParts(listing.parts, catalog); } catch (e) { throw new LedgerError((e as Error).message); }
  const sh = sealedHash(sealed);
  ledger.call(listing.creator, (l) => l.publish_recipe({ id: listing.ticker, name: listing.name, sealed_hash: sh, runner_id: RUNNER_ID, parts: listing.parts, price_per_run: listing.price_per_run, reserve_bps: listing.reserve_bps ?? 0, pricing: listing.pricing ?? null, settle_mode: settle_mode ?? 'final' }));
  const tx = ledger.events.at(-1)!;
  // the creator backs the recipe's quotes with a guarantee deposit (ft_transfer_call with {"action":"bond"})
  if (bond && BigInt(bond) > 0n) ledger.call(PAYMENT_TOKEN, (l) => l.ft_on_transfer({ sender_id: listing.creator, amount: bond, msg: JSON.stringify({ action: 'bond', recipe_id: listing.ticker }) }));
  vaultPut(listing.ticker, sealed, creator_copy);
  // trust labels are recomputed from the on-chain parts (the runner refuses sealed recipes whose parts differ),
  // so what a creator writes in the listing cannot make a closed-model recipe look low-risk or confidential
  const labels = labelsFromParts(listing.parts, catalog);
  listings.set(listing.ticker, { ...listing, risk: labels.risk, disclosures: labels.disclosures, privacy: labels.privacy, capabilities: labels.capabilities, settle_mode: settle_mode ?? 'final', published_at: new Date().toISOString() });
  j(res, { ok: true, sealed_hash: sh, tx: tx.tx_hash, height: tx.block_height });
}));

app.get('/api/recipe/:ticker', guard((req, res) => {
  const t = String(req.params.ticker);
  if (!ledger.recipes.has(t)) { res.status(404).json({ error: 'unknown recipe' }); return; }
  const settlements = settlementsOf(t).slice(-20).reverse().map((e) => ({ ...(e.data[0] as Record<string, unknown>), tx: e.tx_hash, height: e.block_height }));
  const deposits = ledger.events.filter((e) => (e.event === 'bond_posted' || e.event === 'bond_withdrawn') && (e.data[0] as { recipe_id: string }).recipe_id === t).slice(-10).reverse().map((e) => ({ event: e.event, ...(e.data[0] as Record<string, unknown>), tx: e.tx_hash }));
  j(res, { record: record(t), settlements, deposits, onchain: ledger.get_recipe(t), listing: listings.get(t) });
}));
app.get('/api/recipes/summary', (_, res) => j(res, [...ledger.recipes.keys()].map((t) => record(t))));
/** Local world only: the account owner moves tokens out of their own wallet (stands in for a signed ft_transfer).
 *  Used by `npm run attack:drain` to show that emptying a wallet after a quote gets an abort, not the bond. */
app.post('/api/world/transfer', guard((req, res) => {
  const { from, token, to, amount } = req.body as { from: string; token: string; to: string; amount: string };
  if (!/^[a-z0-9._-]{2,64}$/.test(from ?? '') || !/^[a-z0-9._-]{2,64}$/.test(to ?? '')) throw new LedgerError('from and to must be NEAR accounts');
  world.debit(from, token, BigInt(amount)); world.credit(to, token, BigInt(amount));
  j(res, { ok: true });
}));
app.get('/api/account/:account', (req, res) => {
  const a = String(req.params.account);
  j(res, {
    account: a, balance: ledger.balance_of(a),
    /** recipes this account created: what they earned and the guarantee deposit backing them */
    created: [...ledger.recipes.values()].filter((r) => r.creator === a).map((r) => ({ ticker: r.id, name: r.name, runs: r.runs, earned: settlementsOf(r.id).reduce((s, e) => s + BigInt(((e.data[0] as { payouts: { account_id: string; role: string; amount: string }[] }).payouts.find((p) => p.role === 'creator')?.amount) ?? 0), 0n), deposit_available: r.bond_available, deposit_locked: r.bond_locked })),
    wallet: world.tokensOf(a).map((t) => ({ ...t, ...world.meta.get(t.contract_id) })),
  });
});
app.get('/api/intents/log', (_, res) => j(res, mocks.oneclick.log.slice(-60)));

// ---- recipe intents: post a job, recipes compete with signed quotes ----
const MAX_QUOTES_PER_JOB = 5; // dry runs cost compute: cap the fan-out…
const JOBS_PER_MINUTE = 12; //   …and rate-limit job posts per client
const jobLog = new Map<string, number[]>();
const openDemand: { job_type: string; at: string }[] = [];
app.get('/api/jobs', (_, res) => j(res, (catalog.jobs ?? []).map((jt) => ({ ...jt, recipes: [...listings.values()].filter((l) => l.implements === jt.id).map((l) => l.ticker) }))));
app.get('/api/demand', (_, res) => j(res, openDemand.slice(-50).reverse()));

// ---- builder bounties on NEAR AI Agent Market (server/src/bounties.ts) ----
// Live: AGENT_MARKET_URL=https://market.near.ai AGENT_MARKET_API_KEY=<key from POST /v1/agents/register>. Default: an
// offline mock of the same API, mounted at /mock/agent-market, with demo builder agents (scripts/builder-agent.ts).
const MARKET_LIVE = !!env.AGENT_MARKET_URL;
const MARKET_URL = env.AGENT_MARKET_URL ?? `http://127.0.0.1:${PORT}/mock/agent-market`;
const MARKET_WEB = env.AGENT_MARKET_WEB ?? (MARKET_LIVE ? 'https://market.near.ai' : '');
const marketMock = MARKET_LIVE ? null : agentMarketMock();
if (marketMock) app.use('/mock/agent-market', marketMock.router);
let bounties: Bounties | null = null;
const BOUNTY_TEST_WALLET = env.BOUNTY_TEST_WALLET ?? 'bob.testnet';
const MIN_BOUNTY_DEPOSIT = 1_000_000n; // 1 USDC of guarantee deposit backing the delivered recipe's quotes
/** Checks a builder's delivery against the contract mirror and a live, runner-signed dry run. */
async function verifyDelivery(deliverable: string, b: { job_type: string; posted_at: number }, workerNear?: string): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => { checks.push({ name, ok, detail }); return ok; };
  let id = '';
  try { id = String(JSON.parse(deliverable).recipe_id ?? ''); } catch { /* below */ }
  if (!add('deliverable format', /^[A-Z0-9]{3,6}$/.test(id), id ? `recipe_id ${id}` : 'expected {"recipe_id": "<ID>"}')) return checks;
  const r = ledger.get_recipe(id); const l = listings.get(id);
  if (!add('listed on the Sealed Recipes contract', !!r && !!l && r.listed, r ? `published by ${r.creator}, version ${r.version}` : 'no such recipe')) return checks;
  add('implements the requested job type', l!.implements === b.job_type, `implements ${l!.implements ?? 'nothing'}`);
  const pub = ledger.events.find((e) => e.event === 'recipe_published' && (e.data[0] as { id: string }).id === id);
  add('published after the bounty', !!pub && BigInt(pub.timestamp_ns) >= BigInt(b.posted_at) * 1_000_000n, pub ? new Date(Number(BigInt(pub.timestamp_ns) / 1_000_000n)).toISOString() : 'no publish event');
  add('creator is the awarded builder', workerNear ? r!.creator === workerNear : true, workerNear ? `creator ${r!.creator}, awarded ${workerNear}` : 'Agent Market did not report the worker\'s NEAR account; skipped');
  add('guarantee deposit backs its quotes', r!.bond_available + r!.bond_locked >= MIN_BOUNTY_DEPOSIT, `${(Number(r!.bond_available + r!.bond_locked) / USDC).toFixed(2)} USDC (min ${(Number(MIN_BOUNTY_DEPOSIT) / USDC).toFixed(2)})`);
  // live dry run, exactly as a buyer would get it: sealed job -> runner quote sealed back to us -> signature verified
  const runner = ledger.runners.get(r!.runner_id)!;
  const reply = nacl.box.keyPair();
  const recipient = bytesToHex(nacl.sign.keyPair().publicKey); // a fresh implicit address
  const inputs = { wallet: BOUNTY_TEST_WALLET, recipient };
  const salt = randomBytes(16).toString('hex');
  const job_hash = jobHash(inputs, salt);
  const sealed_job = seal({ inputs, salt, reply_to: bytesToHex(reply.publicKey) }, runner.enc_pk_hex, 'inputs');
  const buyer = 'bounty-verifier.srs.testnet';
  const q = await backend.quote({ recipe_id: id, sealed_recipe: currentSealed(id), sealed_job, job_hash, buyer });
  if (!q.ok || !q.sealed_quote) { add('live dry run quotes', false, q.error ?? 'no quote'); return checks; }
  const o = openQuote(q.sealed_quote, reply.secretKey, { contractId: CONTRACT_ID, recipeId: id, signingPk: runner.signing_pk, buyer, inputsHash: sealedHash(sealed_job), jobHash: job_hash });
  add('live dry run quotes', o.verified && BigInt(o.promised ?? 0) > 0n, o.verified ? `test wallet ${BOUNTY_TEST_WALLET}: promises ${(Number(o.promised) / USDC).toFixed(2)} USDC at ${(Number(o.price) / USDC).toFixed(2)} per run` : `quote did not verify: ${o.problem}`);
  return checks;
}
app.get('/api/bounties', (_, res) => j(res, { mode: MARKET_LIVE ? 'live' : 'mock', market: MARKET_LIVE ? MARKET_URL : 'offline mock of the Agent Market API', ready: !!bounties, bounties: bounties ? [...bounties.list.values()].reverse() : [] }));
app.post('/api/bounties', guard(async (req, res) => {
  if (!bounties) throw new LedgerError('Agent Market is not connected');
  const { job_type, budget, by } = req.body as { job_type: string; budget: string; by: string };
  const jt = catalog.jobs?.find((x) => x.id === job_type); if (!jt) throw new LedgerError('unknown job type');
  if ([...listings.values()].some((l) => l.implements === job_type)) throw new LedgerError('a recipe already serves this job type');
  if (!(Number(budget) > 0 && Number(budget) <= 10_000)) throw new LedgerError('budget must be between 0 and 10000 USDC');
  try { j(res, await bounties.post({ job_type: jt as never, budget: String(Number(budget)), token: 'USDC', origin: `http://127.0.0.1:${PORT}`, by: String(by ?? 'marketplace') })); } catch (e) { throw new LedgerError((e as Error).message); }
}));
app.post('/api/bounties/:id/award', guard(async (req, res) => {
  if (!bounties) throw new LedgerError('Agent Market is not connected');
  try { j(res, await bounties.award(String(req.params.id), String(req.body?.bid_id))); } catch (e) { throw new LedgerError((e as Error).message); }
}));
app.post('/api/jobs', guard(async (req, res) => {
  const ip = req.ip ?? 'local';
  const now = Date.now();
  const recent = (jobLog.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= JOBS_PER_MINUTE) throw new LedgerError('too many jobs posted in the last minute');
  jobLog.set(ip, [...recent, now]);
  const { job_type, sealed_job, job_hash, only, buyer, max_price } = req.body as { job_type: string; sealed_job: SealedEnvelope; job_hash: string; only?: string; buyer: string; max_price?: string };
  if (max_price !== undefined && !/^\d+$/.test(String(max_price))) throw new LedgerError('max_price must be an integer amount of the payment token');
  if (typeof buyer !== 'string' || !/^[a-z0-9._-]{2,64}$/.test(buyer)) throw new LedgerError('buyer account required: quotes are bound to the account that pays');
  if (!catalog.jobs?.some((jt) => jt.id === job_type)) throw new LedgerError('unknown job type');
  if (!/^[0-9a-f]{64}$/.test(job_hash ?? '') || sealed_job?.purpose !== 'inputs') throw new LedgerError('expected a sealed job and its job_hash');
  const candidates = [...listings.values()].filter((l) => l.implements === job_type && (!only || l.ticker === only)).slice(0, MAX_QUOTES_PER_JOB);
  if (!candidates.length) { openDemand.push({ job_type, at: new Date().toISOString() }); j(res, { quotes: [], open_demand: true }); return; }
  const quotes = await Promise.all(candidates.map(async (l) => {
    const r = ledger.get_recipe(l.ticker)!;
    // buyer's price cap: a recipe listed above it isn't asked to quote (no dry run, no compute spent)
    const over = max_price !== undefined && r.price_per_run > BigInt(max_price);
    const q = over ? { ok: false, error: `list price $${(Number(r.price_per_run) / USDC).toFixed(4)} is above your max price`, sealed_quote: undefined }
      : await backend.quote({ recipe_id: l.ticker, sealed_recipe: currentSealed(l.ticker), sealed_job, job_hash, buyer });
    // relay only ciphertext: the quote's values describe the buyer's wallet and are sealed to the buyer's reply key
    return { recipe_id: l.ticker, ok: !!q.ok, error: q.error, sealed_quote: q.sealed_quote, listing: { ticker: l.ticker, name: l.name, creator: l.creator, price_per_run: r.price_per_run.toString(), price_floor: r.price_floor.toString(), price_ceiling: r.price_ceiling.toString(), privacy: l.privacy, risk: l.risk, disclosures: l.disclosures, parts: l.parts },
      track: { runs: r.runs, failed: r.failed, promised_total: r.promised_total, delivered_total: r.delivered_total, compensated_total: r.compensated_total, aborted: r.aborted, bond_available: r.bond_available } };
  }));
  j(res, { quotes, open_demand: false });
}));

// ---- runs ----
app.post('/api/runs/quote', guard(async (req, res) => {
  const { recipe_id, buyer, pay_asset, refund_to, sealed_inputs, signed_quote: sq, max_price } = req.body as { recipe_id: string; buyer: string; pay_asset: string; refund_to: string; sealed_inputs: SealedEnvelope; signed_quote?: SignedQuote; max_price?: string };
  const r = ledger.get_recipe(recipe_id); if (!r) throw new LedgerError('unknown recipe');
  // a signed quote locks its price; without one the buyer pays the current list price, protected by max_price
  const price = sq ? BigInt(sq.price) : r.price_per_run;
  if (max_price !== undefined && price > BigInt(max_price)) throw new LedgerError(`price $${(Number(price) / USDC).toFixed(4)} is above your max price`);
  if (sealed_inputs?.purpose !== 'inputs' || sealed_inputs.to !== ledger.runners.get(r.runner_id)!.enc_pk_hex) throw new LedgerError('inputs must be sealed to the recipe runner');
  const run_id = 'r-' + randomBytes(6).toString('hex');
  const inputs_hash = sealedHash(sealed_inputs);
  const msg = JSON.stringify({ action: 'run', recipe_id, run_id, inputs_hash, on_behalf_of: buyer, ...(max_price !== undefined ? { max_price: String(max_price) } : {}), ...(sq ? { quote: { sealed_hash: sq.sealed_hash, job_hash: sq.job_hash, price: sq.price, expected: sq.expected, promised: sq.promised, cover: sq.cover, expires_ns: sq.expires_ns, signature: sq.signature } } : {}) });
  const qreq = runPaymentQuoteRequest({ originAsset: pay_asset, refundTo: refund_to || buyer, contractId: CONTRACT_ID, price: price.toString(), msg });
  const quote = await mocks.oneclick.quote(qreq);
  const token = randomBytes(24).toString('hex');
  const ctx: RunCtx = { run_id, token, recipe_id, buyer, sealed_inputs, inputs_hash, quote, events: [], listeners: new Set(), started: false, approvalPending: false, approvals: {}, done: false };
  runs.set(run_id, ctx);
  pushEv(ctx, 'intents', 'quote', { request: qreq, quote: quote.quote, correlationId: quote.correlationId });
  j(res, { run_id, run_token: token, inputs_hash, msg, quote });
}));
const runFor = (req: express.Request) => {
  const r = runs.get(String(req.params.id));
  const tok = String(req.query.token ?? req.get('x-run-token') ?? '');
  if (!r || tok !== r.token) throw new LedgerError('unknown run or missing run token');
  return r;
};
app.post('/api/runs/:id/pay', guard(async (req, res) => {
  const r = runFor(req);
  const txHash = sha256Hex('pay|' + r.run_id + Date.now()).slice(0, 44);
  const dep = r.quote.quote.depositAddress!;
  await mocks.oneclick.submitDeposit(dep, txHash);
  pushEv(r, 'intents', 'deposit_submitted', { txHash, depositAddress: dep, amountIn: r.quote.quote.amountInFormatted, asset: r.quote.quoteRequest.originAsset });
  // poll 1Click status like a client would; delivery triggers ft_on_transfer (see onDelivered)
  void (async () => {
    let last = '';
    for (let i = 0; i < 60; i++) {
      const s = await fetch(`http://127.0.0.1:${PORT}/mock/1click/v0/status?depositAddress=${dep}`).then((x) => x.json()) as { status: string };
      if (s.status !== last) { last = s.status; pushEv(r, 'intents', 'status', { status: s.status, depositAddress: dep }); }
      if (['SUCCESS', 'FAILED', 'REFUNDED', 'INCOMPLETE_DEPOSIT'].includes(s.status)) return;
      await new Promise((ok) => setTimeout(ok, 350));
    }
  })();
  j(res, { ok: true, txHash });
}));
/**
 * Local demo wallet. The buyer's browser decrypted the approval request (sealed to its reply key)
 * and posts back the exact transactions it approved; a real wallet would sign and broadcast them.
 */
app.post('/api/runs/:id/approve', guard(async (req, res) => {
  const r = runFor(req); if (!r.approvalPending) throw new LedgerError('no approval pending');
  const approved = !!req.body?.approved;
  const txs = (approved ? req.body.transactions ?? [] : []) as { receiverId: string; actions: { type: string; params: { methodName: string; args: { receiver_id: string; amount: string } } }[] }[];
  const txHashes: string[] = [];
  for (const t of txs) {
    const a = t.actions?.[0];
    const m = a?.params?.methodName;
    // airdrop claims: claim({receiver_id}) on a demo distributor (airdrop.claim part)
    if (t.actions.length === 1 && a?.type === 'FunctionCall' && m === 'claim' && world.airdrops.has(t.receiverId)) {
      world.claim(t.receiverId, r.buyer, String(a.params.args.receiver_id));
      txHashes.push(sha256Hex(`claim|${t.receiverId}|${a.params.args.receiver_id}|${Date.now()}`).slice(0, 44));
      continue;
    }
    if (t.actions.length !== 1 || a.type !== 'FunctionCall' || (m !== 'ft_transfer' && m !== 'ft_transfer_call') || !/^\d+$/.test(a.params.args.amount)) throw new LedgerError('demo wallet only signs single ft_transfer / ft_transfer_call actions, and claim on a demo airdrop distributor');
    if (m === 'ft_transfer_call' && a.params.args.receiver_id !== 'intents.near') throw new LedgerError('demo wallet only deposits into intents.near with ft_transfer_call');
    world.debit(r.buyer, t.receiverId, BigInt(a.params.args.amount));
    if (m === 'ft_transfer_call') mocks.verifier.deposit(r.buyer, t.receiverId, BigInt(a.params.args.amount)); // deposit into the Verifier
    else world.credit(a.params.args.receiver_id, t.receiverId, BigInt(a.params.args.amount));
    txHashes.push(sha256Hex(`ft|${t.receiverId}|${a.params.args.receiver_id}|${Date.now()}`).slice(0, 44));
  }
  // NEP-413 message signing (NEAR Intents bundles): the demo wallet signs with the buyer's demo key
  const sm = approved ? (req.body.sign_message as Nep413Payload | undefined) : undefined;
  const signed = sm ? signNep413(sm, demoWalletKey(r.buyer).secretKey) : undefined;
  r.approvalPending = false;
  if (r.approvalNode) r.approvals[r.approvalNode] = { approved, txHashes, ...(signed ? { signed } : {}) }; // replayed if the runner has to resume
  await backend.approval(r.run_id, { approved, txHashes, signed });
  j(res, { ok: true, txHashes, signed: !!signed });
}));
app.get('/api/runs/:id/events', (req, res) => {
  let r: RunCtx; try { r = runFor(req); } catch { res.status(403).end(); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (e: Ev) => res.write(`data: ${JSON.stringify(toJson(e))}\n\n`);
  r.events.forEach(send); r.listeners.add(send);
  req.on('close', () => r.listeners.delete(send));
});
app.get('/api/runs', (_, res) => j(res, [...ledger.runs.values()].reverse().slice(0, 50)));

// ---- validation helper for the composer (pure; plaintext stays in the browser normally, this is optional) ----
app.post('/api/validate', (req, res) => { const v = validateRecipe(req.body, catalog); j(res, v); });

// ---- static web app ----
const dist = resolve(ROOT, 'web/dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api|mock).*/, (_, res) => res.sendFile(resolve(dist, 'index.html')));
}

// ---------- boot: owner verifies & registers the runner ----------
async function boot() {
  let att: { signing_pk: string; enc_pk_hex: string; codehash: string } | undefined;
  for (let i = 0; i < 50 && !att; i++) {
    try { att = await backend.attestation(randomBytes(16).toString('hex')); } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  if (!att) throw new Error(`runner not reachable at ${RUNNER}`);
  // the owner pins the audited release in AUDITED_CODEHASH (npm run pin-codehash). Edit runner/core code
  // without re-pinning and the runner's attestation no longer matches: the UI check turns red.
  const pinned = resolve(ROOT, 'AUDITED_CODEHASH');
  const audited = existsSync(pinned) ? readFileSync(pinned, 'utf8').trim() : computeCodehash(ROOT).codehash;
  if (att.codehash !== audited) console.warn(`[server] WARNING runner codehash ${att.codehash.slice(0, 12)} != audited ${audited.slice(0, 12)} — UI will show the mismatch`);
  ledger.call('srs-dao.testnet', (l) => l.add_runner({ id: RUNNER_ID, signing_pk: att!.signing_pk, enc_pk_hex: att!.enc_pk_hex, codehash: audited, fee_per_run: '30000' }));
  for (const b of catalog.parts) ledger.call(b.author, (l) => l.register_part({ id: b.id, version: b.id.split('@')[1], fee_per_call: b.fee_per_call, manifest_hash: hashObject(b) }));
  // SRS_HOST=0.0.0.0 makes it reachable from outside the machine (e.g. WSL without localhost forwarding); default: local only
  const HOST = env.SRS_HOST ?? '127.0.0.1';
  app.listen(PORT, HOST, () => {
    console.log(`[server] marketplace on http://${HOST}:${PORT}  (contract mirror ${CONTRACT_ID}, runner ${RUNNER})`);
    // Agent Market: use the given key, or register this marketplace as an agent on the mock
    (async () => {
      const key = env.AGENT_MARKET_API_KEY ?? (MARKET_LIVE ? undefined : (await AgentMarketClient.register(MARKET_URL, 'sealed-recipes', ['sealed-recipes', 'near'])).api_key);
      if (!key) { console.log('[server] Agent Market: AGENT_MARKET_URL set without AGENT_MARKET_API_KEY; bounties disabled'); return; }
      bounties = new Bounties(new AgentMarketClient(MARKET_URL, key), verifyDelivery, MARKET_WEB);
      setInterval(() => { void bounties!.tick(); }, 1500);
      console.log(`[server] Agent Market bounties: ${MARKET_LIVE ? MARKET_URL : 'offline mock at /mock/agent-market'}`);
    })().catch((e) => console.error('[server] Agent Market unavailable:', (e as Error).message));
  });
  // keeper: apply ended pricing periods so price_updated events are timely (anyone may call update_price)
  setInterval(() => { for (const id of ledger.recipes.keys()) { try { ledger.call('keeper.srs.testnet', (l) => l.update_price({ id })); } catch { /* ignore */ } } }, 1000);
  // keeper: activate recipe versions whose notice period has passed (anyone may call apply_update)
  setInterval(() => {
    const now = BigInt(Date.now()) * 1_000_000n;
    for (const r of ledger.recipes.values()) if (r.pending_sealed_hash && now >= r.update_effective_ns) { try { ledger.call('keeper.srs.testnet', (l) => l.apply_update({ id: r.id })); } catch { /* raced */ } }
  }, 1000);
}
void boot();
