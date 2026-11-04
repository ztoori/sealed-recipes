/**
 * Marketplace + exchange server (local mode).
 *  - /api/chain/*  : view/relay surface of the fungible-recipes contract (backed by LocalLedger)
 *  - /api/*        : marketplace (listings, sealed vault, runs, market data, portfolio)
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
import { validateRecipe, labelsFromParts, type Catalog, type PublicListing } from '../../core/src/frs.js';
import { computeCodehash, loadCatalog } from '../../core/src/codehash.js';
import { runPaymentQuoteRequest, USDC_NEAR, type Token, type QuoteResponse } from '../../core/src/oneclick.js';
import { World } from './world.js';
import { mockRouter } from './mocks.js';
import { Market } from './market.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const env = process.env;
const PORT = Number(env.PORT ?? 8080);
const RUNNER = env.RUNNER_URL ?? 'http://127.0.0.1:8787';
const CONTRACT_ID = env.CONTRACT_ID ?? 'fungible-recipes.testnet';
const RUNNER_ID = env.RUNNER_ID ?? 'tee-runner-1.testnet';
const PAYMENT_TOKEN = USDC_NEAR.replace(/^nep141:/, '');
const SOLVER = 'solver-relay.intents.testnet';
const BOTS = env.FRS_BOTS !== '0';
const RUNNER_TOKEN = env.RUNNER_TOKEN ?? '';
const RUNNER_PUBLIC_URL = env.RUNNER_PUBLIC_URL ?? RUNNER; // browsers fetch attestation from the runner directly
const rh = { 'content-type': 'application/json', 'x-runner-token': RUNNER_TOKEN };

const catalog = loadCatalog(ROOT);
const tokens = JSON.parse(readFileSync(resolve(ROOT, 'fixtures/oneclick-tokens.json'), 'utf8')).tokens as Token[];
const world = new World(resolve(ROOT, 'fixtures/wallets.json'), resolve(ROOT, 'fixtures/oneclick-tokens.json'));
const BATCH_MS = Number(env.FRS_BATCH_MS ?? 12000);
/** notice period before a new recipe version takes effect (24 h is the suggested mainnet value; short for the demo) */
const UPDATE_DELAY_S = Number(env.FRS_UPDATE_DELAY_S ?? 30);
const ledger = new LocalLedger({ contractId: CONTRACT_ID, owner: 'frs-dao.testnet', paymentToken: PAYMENT_TOKEN, protocolAccount: 'frs-treasury.testnet', protocolFeeBps: 200, batchIntervalNs: BigInt(BATCH_MS) * 1_000_000n, updateDelayNs: BigInt(UPDATE_DELAY_S) * 1_000_000_000n });
const market = new Market(ledger);

// ---------- runs: per-run event log merged from payment (server) + execution (runner) ----------
type Ev = { seq: number; at: number; source: 'market' | 'intents' | 'runner' | 'chain'; type: string; data: Record<string, unknown> };
/** `token` is a capability returned only to the buyer who requested the quote: it gates the event stream and approvals. */
interface RunCtx { run_id: string; token: string; recipe_id: string; buyer: string; sealed_inputs: SealedEnvelope; inputs_hash: string; quote: QuoteResponse; events: Ev[]; listeners: Set<(e: Ev) => void>; started: boolean; approvalPending: boolean;
  /** durable runs: the latest checkpoint the runner stored (ciphertext sealed to the runner + its signature) */
  checkpoint?: CheckpointRecord;
  /** approvals relayed to the runner, by node: replayed on resume so the buyer is never asked to sign twice */
  approvals: Record<string, { approved: boolean; txHashes: string[] }>;
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
  const res = await fetch(`${RUNNER}/runs`, { method: 'POST', headers: rh, body: JSON.stringify({ run_id: r.run_id, recipe_id: r.recipe_id, sealed_recipe: sealed, sealed_inputs: r.sealed_inputs }) });
  if (!res.ok) { pushEv(r, 'runner', 'failed', { error: await res.text() }); return; }
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
      const sse = await fetch(`${RUNNER}/runs/${r.run_id}/events`, { headers: rh });
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
        const res = await fetch(`${RUNNER}/runs/${r.run_id}/resume`, { method: 'POST', headers: rh, body: JSON.stringify({ recipe_id: r.recipe_id, sealed_recipe: sealedFor(r), sealed_inputs: r.sealed_inputs, checkpoint: r.checkpoint ?? null, approvals: r.approvals }) });
        if (res.ok || res.status === 409) { pushEv(r, 'market', 'resume_requested', { checkpoint: r.checkpoint?.local_seq ?? null, attempt: attempt + 1 }); break; }
      } catch { /* runner still down */ }
    }
  }
}

// ---------- marketplace state ----------
/** ticker → sealed_hash → sealed recipe (ciphertext only). Every version is kept: a run paid for version N must
 *  still execute version N after version N+1 takes effect. Production: a durable store keyed the same way. */
const vault = new Map<string, Map<string, SealedEnvelope>>();
const vaultPut = (ticker: string, env: SealedEnvelope) => { if (!vault.has(ticker)) vault.set(ticker, new Map()); vault.get(ticker)!.set(sealedHash(env), env); };
const currentSealed = (ticker: string) => vault.get(ticker)?.get(ledger.recipes.get(ticker)?.sealed_hash ?? '');
const listings = new Map<string, PublicListing & { ipo_price: number; published_at: string; settle_mode?: string }>();

const app = express();
app.use('/mock', mocks.router);
app.use(express.json({ limit: '2mb' }));
const j = (res: express.Response, v: unknown) => res.json(toJson(v));
const guard = (fn: (req: express.Request, res: express.Response) => unknown) => async (req: express.Request, res: express.Response) => {
  try { await fn(req, res); } catch (e) { res.status(e instanceof LedgerError ? 400 : 500).json({ error: (e as Error).message }); }
};

// ---- chain surface (contract views + relayer) ----
app.get('/api/chain/config', (_, res) => j(res, { contract_id: CONTRACT_ID, owner: ledger.owner, payment_token: ledger.paymentToken, protocol_account: ledger.protocolAccount, protocol_fee_bps: ledger.protocolFeeBps, height: ledger.height, network: 'local-mirror' }));
app.get('/api/chain/recipes/:id', (req, res) => { const r = ledger.recipes.get(String(req.params.id)); r ? j(res, r) : res.status(404).json({ error: 'no recipe' }); });
app.get('/api/chain/runs/:id', (req, res) => { const r = ledger.runs.get(String(req.params.id)); r ? j(res, r) : res.status(404).json({ error: 'no run' }); });
app.get('/api/chain/runners/:id', (req, res) => { const r = ledger.runners.get(String(req.params.id)); r ? j(res, r) : res.status(404).json({ error: 'no runner' }); });
app.get('/api/chain/parts', (_, res) => j(res, [...ledger.parts.values()]));
app.get('/api/chain/events', (req, res) => { const since = req.query.last ? Math.max(0, ledger.events.length - Number(req.query.last)) : Number(req.query.since ?? 0); j(res, { height: ledger.height, events: ledger.events.slice(since).map((e, i) => ({ idx: since + i, ...e })) }); });
app.post('/api/chain/report_run', guard((req, res) => {
  const payouts = ledger.call('relayer.frs.testnet', (l) => l.report_run(req.body));
  const run = ledger.runs.get(req.body.run_id);
  const r = runs.get(req.body.run_id);
  const ev = ledger.events.at(-1)!;
  if (r) pushEv(r, 'chain', ev.event, { tx: ev.tx_hash, height: ev.block_height, ...ev.data[0] });
  j(res, { status: run?.status, payouts, tx: ev.tx_hash, height: ev.block_height });
}));
app.post('/api/chain/checkpoint_run', guard((req, res) => {
  const payouts = ledger.call('relayer.frs.testnet', (l) => l.checkpoint_run(req.body));
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
  if (!r.checkpoint || c.local_seq > r.checkpoint.local_seq) r.checkpoint = c;
  j(res, { ok: true, stored: r.checkpoint.local_seq });
}));
/** Versions with notice: the creator announces a new sealed version; it takes effect after the notice period. */
app.post('/api/recipes/:ticker/update', guard((req, res) => {
  const t = String(req.params.ticker);
  const { signer, sealed } = req.body as { signer: string; sealed: SealedEnvelope };
  if (sealed?.v !== 'frs-seal-v1' || sealed.purpose !== 'recipe') throw new LedgerError('expected a sealed recipe envelope');
  if (sealed.to !== ledger.runners.get(RUNNER_ID)!.enc_pk_hex) throw new LedgerError('envelope is not sealed to the registered runner key');
  ledger.call(signer, (l) => l.update_sealed({ id: t, sealed_hash: sealedHash(sealed) }));
  vaultPut(t, sealed); // stored now, served once it takes effect; older versions are kept
  const ev = ledger.events.at(-1)!;
  j(res, { ...(ev.data[0] as object), tx: ev.tx_hash });
}));
app.post('/api/recipes/:ticker/cancel-update', guard((req, res) => {
  ledger.call(String(req.body.signer), (l) => l.cancel_update({ id: String(req.params.ticker) }));
  j(res, { ok: true });
}));

/** local demo only: crash the runner process (it is restarted by the launcher) */
if (env.FRS_ALLOW_CRASH === '1') app.post('/api/dev/crash-runner', guard(async (_, res) => { await fetch(`${RUNNER}/__crash`, { method: 'POST', headers: rh }).catch(() => {}); j(res, { ok: true }); }));

/** demo wallet: sign "as" an account. Local mode only — testnet mode uses a real NEAR wallet. */
const ALLOWED = new Set(['register_part', 'place_ask', 'cancel_order', 'transfer_shares', 'claim_dividends', 'withdraw', 'bid', 'clear_batch']);
app.post('/api/chain/tx', guard((req, res) => {
  const { signer, method, args } = req.body as { signer: string; method: string; args: Record<string, string> };
  if (!ALLOWED.has(method)) throw new LedgerError('method not allowed from demo wallet');
  let out: unknown;
  if (method === 'bid') {
    const amount = (BigInt(args.price) * BigInt(args.qty)).toString();
    out = ledger.call(PAYMENT_TOKEN, (l) => l.ft_on_transfer({ sender_id: signer, amount, msg: JSON.stringify({ action: 'bid', recipe_id: args.recipe_id, price: args.price, qty: args.qty }) }));
  } else {
    out = ledger.call(signer, (l) => (l as unknown as Record<string, (a: unknown) => unknown>)[method](args));
  }
  const ev = ledger.events.at(-1);
  j(res, { ok: true, result: out, tx: ev?.tx_hash, height: ledger.height });
}));

// ---- marketplace ----
app.get('/api/mode', (_, res) => j(res, {
  mode: 'local', batch_ms: BATCH_MS, contract_id: CONTRACT_ID, runner_id: RUNNER_ID, runner_url: RUNNER_PUBLIC_URL, bots: BOTS ? market.bots : [],
  services: { fastnear: 'mock', rpc: 'mock', oneclick: 'fixture (frozen token sample)', nearai: 'mock (real secp256k1 signatures, no hardware quote)', tee: 'local-dev runner (no hardware quote)' },
  ai_signing_address: mocks.aiSigningAddress,
}));
app.get('/api/catalog', (_, res) => j(res, { ...catalog, onchain: Object.fromEntries([...ledger.parts].map(([k, b]) => [k, { author: b.author, manifest_hash: b.manifest_hash, fee_per_call: b.fee_per_call, active: b.active }])) }));
app.get('/api/listings', (_, res) => j(res, [...listings.values()].map((l) => ({ ...l, market: market.ticker(l.ticker), onchain: ledger.recipes.get(l.ticker) }))));
app.get('/api/vault/:ticker', (req, res) => { const v = currentSealed(String(req.params.ticker)); v ? res.json({ envelope: v, sealed_hash: sealedHash(v) }) : res.status(404).json({ error: 'not found' }); });
app.get('/api/vault/:ticker/versions', (req, res) => { const t = String(req.params.ticker); const r = ledger.recipes.get(t); if (!r) { res.status(404).json({ error: 'not found' }); return; }
  j(res, { current: r.sealed_hash, version: r.version, pending: r.pending_sealed_hash || null, effective_ns: r.update_effective_ns, stored: [...(vault.get(t)?.keys() ?? [])] }); });
app.get('/api/runner/attestation', guard(async (req, res) => {
  const a = await fetch(`${RUNNER}/attestation?nonce=${encodeURIComponent(String(req.query.nonce ?? ''))}`).then((x) => x.json());
  j(res, { attestation: a, onchain: ledger.runners.get(RUNNER_ID) });
}));

app.post('/api/publish', guard((req, res) => {
  const { listing, sealed, ipo, bond, settle_mode } = req.body as { listing: PublicListing; sealed: SealedEnvelope; ipo?: { price: number; float_pct: number }; bond?: string; settle_mode?: string };
  if (sealed?.v !== 'frs-seal-v1' || sealed.purpose !== 'recipe') throw new LedgerError('expected a sealed recipe envelope');
  const runner = ledger.runners.get(RUNNER_ID)!;
  if (sealed.to !== runner.enc_pk_hex) throw new LedgerError('envelope is not sealed to the registered runner key');
  if ((listing as unknown as Record<string, unknown>).nodes) throw new LedgerError('refusing plaintext recipe: only the public listing may be sent');
  try { labelsFromParts(listing.parts, catalog); } catch (e) { throw new LedgerError((e as Error).message); }
  const sh = sealedHash(sealed);
  ledger.call(listing.creator, (l) => l.publish_recipe({ id: listing.ticker, name: listing.name, sealed_hash: sh, runner_id: RUNNER_ID, parts: listing.parts, price_per_run: listing.price_per_run, royalty_bps: listing.royalty_bps, total_shares: listing.total_shares, settle_mode: settle_mode ?? 'final' }));
  const tx = ledger.events.at(-1)!;
  // the creator backs the recipe's quotes with a bond (ft_transfer_call with {"action":"bond"})
  if (bond && BigInt(bond) > 0n) ledger.call(PAYMENT_TOKEN, (l) => l.ft_on_transfer({ sender_id: listing.creator, amount: bond, msg: JSON.stringify({ action: 'bond', recipe_id: listing.ticker }) }));
  vaultPut(listing.ticker, sealed);
  const ipoPrice = ipo?.price ?? 0.01;
  // trust labels are recomputed from the on-chain parts (the runner refuses sealed recipes whose parts differ),
  // so what a creator writes in the listing cannot make a closed-model recipe look low-risk or confidential
  const labels = labelsFromParts(listing.parts, catalog);
  listings.set(listing.ticker, { ...listing, risk: labels.risk, disclosures: labels.disclosures, privacy: labels.privacy, capabilities: labels.capabilities, settle_mode: settle_mode ?? 'final', ipo_price: ipoPrice, published_at: new Date().toISOString() });
  market.seedHistory(listing.ticker, ipoPrice, 0.0004, 0.02, [...listing.ticker].reduce((s, c) => s * 31 + c.charCodeAt(0), 7));
  if (ipo && ipo.float_pct > 0) {
    const qty = (BigInt(listing.total_shares) * BigInt(Math.round(ipo.float_pct * 100))) / 10000n;
    const px = Math.round(ipoPrice * 1_000_000);
    // opening auction: the float is offered across 5 price levels from the reserve price up
    for (let k = 0; k < 5; k++) ledger.call(listing.creator, (l) => l.place_ask({ recipe_id: listing.ticker, price: String(Math.round(px * (1 + k * 0.01))), qty: (qty / 5n).toString() }));
  }
  if (BOTS) setTimeout(() => market.openingBids(listing.ticker, ipoPrice), 1500);
  j(res, { ok: true, sealed_hash: sh, tx: tx.tx_hash, height: tx.block_height });
}));

app.get('/api/market/:ticker', guard((req, res) => {
  const t = String(req.params.ticker);
  if (!ledger.recipes.has(t)) { res.status(404).json({ error: 'unknown ticker' }); return; }
  const book = ledger.get_book(t);
  const agg = (os: typeof book.bids) => { const m = new Map<string, { price: number; qty: number; orders: number }>(); for (const o of os) { const k = o.price.toString(); const x = m.get(k) ?? { price: Number(o.price) / 1e6, qty: 0, orders: 0 }; x.qty += Number(o.qty); x.orders++; m.set(k, x); } return [...m.values()]; };
  const cleared = ledger.events.filter((e) => e.event === 'batch_cleared' && (e.data[0] as { recipe_id: string }).recipe_id === t);
  // the latest 30 batches, plus the opening auction (batch #1) so the IPO clearing stays visible
  const shown = cleared.length > 30 ? [cleared[0], ...cleared.slice(-29)] : cleared;
  const auctions = shown.reverse().map((e) => {
    const d = e.data[0] as { batch_id: number; price: string | null; volume: string; fills: unknown[] };
    return { batch_id: d.batch_id, price: d.price, volume: d.volume, fills: d.fills.length, tx: e.tx_hash, ts: e.timestamp_ns };
  });
  const settlements = ledger.events.filter((e) => e.event === 'frs_settlement' && (e.data[0] as { recipe_id: string }).recipe_id === t).slice(-20).reverse().map((e) => ({ ...(e.data[0] as Record<string, unknown>), tx: e.tx_hash, height: e.block_height }));
  j(res, { stats: market.ticker(t), candles: market.candles.get(t), book: { bids: agg(book.bids), asks: agg(book.asks) }, auctions, settlements, onchain: ledger.recipes.get(t), holders: ledger.holders(t).slice(0, 10), listing: listings.get(t) });
}));
app.get('/api/tickers', (_, res) => j(res, [...ledger.recipes.keys()].map((t) => market.ticker(t))));
/** Local world only: the account owner moves tokens out of their own wallet (stands in for a signed ft_transfer).
 *  Used by `npm run attack:drain` to show that emptying a wallet after a quote gets an abort, not the bond. */
app.post('/api/world/transfer', guard((req, res) => {
  const { from, token, to, amount } = req.body as { from: string; token: string; to: string; amount: string };
  if (!/^[a-z0-9._-]{2,64}$/.test(from ?? '') || !/^[a-z0-9._-]{2,64}$/.test(to ?? '')) throw new LedgerError('from and to must be NEAR accounts');
  world.debit(from, token, BigInt(amount)); world.credit(to, token, BigInt(amount));
  j(res, { ok: true });
}));
app.get('/api/portfolio/:account', (req, res) => {
  const a = String(req.params.account);
  j(res, {
    account: a, balance: ledger.balance_of(a),
    positions: [...ledger.recipes.keys()].map((t) => ({ ticker: t, shares: ledger.shares_of(t, a), locked: ledger.locked_of(t, a), pending: ledger.pending_dividends(t, a), last: market.lastPrice(t) })).filter((p) => p.shares > 0n || p.pending > 0n),
    orders: [...ledger.orders.values()].filter((o) => o.owner === a),
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
app.post('/api/jobs', guard(async (req, res) => {
  const ip = req.ip ?? 'local';
  const now = Date.now();
  const recent = (jobLog.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= JOBS_PER_MINUTE) throw new LedgerError('too many jobs posted in the last minute');
  jobLog.set(ip, [...recent, now]);
  const { job_type, sealed_job, job_hash, only, buyer } = req.body as { job_type: string; sealed_job: SealedEnvelope; job_hash: string; only?: string; buyer: string };
  if (typeof buyer !== 'string' || !/^[a-z0-9._-]{2,64}$/.test(buyer)) throw new LedgerError('buyer account required: quotes are bound to the account that pays');
  if (!catalog.jobs?.some((jt) => jt.id === job_type)) throw new LedgerError('unknown job type');
  if (!/^[0-9a-f]{64}$/.test(job_hash ?? '') || sealed_job?.purpose !== 'inputs') throw new LedgerError('expected a sealed job and its job_hash');
  const candidates = [...listings.values()].filter((l) => l.implements === job_type && (!only || l.ticker === only)).slice(0, MAX_QUOTES_PER_JOB);
  if (!candidates.length) { openDemand.push({ job_type, at: new Date().toISOString() }); j(res, { quotes: [], open_demand: true }); return; }
  const quotes = await Promise.all(candidates.map(async (l) => {
    const q = await fetch(`${RUNNER}/quotes`, { method: 'POST', headers: rh, body: JSON.stringify({ recipe_id: l.ticker, sealed_recipe: currentSealed(l.ticker), sealed_job, job_hash, buyer }) }).then((x) => x.json()).catch((e) => ({ recipe_id: l.ticker, ok: false, error: String(e) }));
    // relay only ciphertext: the quote's values describe the buyer's wallet and are sealed to the buyer's reply key
    const r = ledger.recipes.get(l.ticker)!;
    return { recipe_id: l.ticker, ok: !!q.ok, error: q.error, sealed_quote: q.sealed_quote, listing: { ticker: l.ticker, name: l.name, creator: l.creator, price_per_run: l.price_per_run, privacy: l.privacy, risk: l.risk, disclosures: l.disclosures, parts: l.parts },
      track: { runs: r.runs, failed: r.failed, promised_total: r.promised_total, delivered_total: r.delivered_total, compensated_total: r.compensated_total, aborted: r.aborted, bond_available: r.bond_available } };
  }));
  j(res, { quotes, open_demand: false });
}));

// ---- runs ----
app.post('/api/runs/quote', guard(async (req, res) => {
  const { recipe_id, buyer, pay_asset, refund_to, sealed_inputs, signed_quote: sq } = req.body as { recipe_id: string; buyer: string; pay_asset: string; refund_to: string; sealed_inputs: SealedEnvelope; signed_quote?: SignedQuote };
  const r = ledger.recipes.get(recipe_id); if (!r) throw new LedgerError('unknown recipe');
  if (sealed_inputs?.purpose !== 'inputs' || sealed_inputs.to !== ledger.runners.get(r.runner_id)!.enc_pk_hex) throw new LedgerError('inputs must be sealed to the recipe runner');
  const run_id = 'r-' + randomBytes(6).toString('hex');
  const inputs_hash = sealedHash(sealed_inputs);
  const msg = JSON.stringify({ action: 'run', recipe_id, run_id, inputs_hash, on_behalf_of: buyer, ...(sq ? { quote: { sealed_hash: sq.sealed_hash, job_hash: sq.job_hash, expected: sq.expected, promised: sq.promised, cover: sq.cover, expires_ns: sq.expires_ns, signature: sq.signature } } : {}) });
  const qreq = runPaymentQuoteRequest({ originAsset: pay_asset, refundTo: refund_to || buyer, contractId: CONTRACT_ID, price: r.price_per_run.toString(), msg });
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
    if (t.actions.length !== 1 || a.type !== 'FunctionCall' || a.params.methodName !== 'ft_transfer' || !/^\d+$/.test(a.params.args.amount)) throw new LedgerError('demo wallet only signs single ft_transfer actions');
    world.debit(r.buyer, t.receiverId, BigInt(a.params.args.amount));
    world.credit(a.params.args.receiver_id, t.receiverId, BigInt(a.params.args.amount));
    txHashes.push(sha256Hex(`ft|${t.receiverId}|${a.params.args.receiver_id}|${Date.now()}`).slice(0, 44));
  }
  r.approvalPending = false;
  if (r.approvalNode) r.approvals[r.approvalNode] = { approved, txHashes }; // replayed if the runner has to resume
  await fetch(`${RUNNER}/runs/${r.run_id}/approval`, { method: 'POST', headers: rh, body: JSON.stringify({ approved, txHashes }) });
  j(res, { ok: true, txHashes });
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
    try { att = await fetch(`${RUNNER}/attestation?nonce=${randomBytes(16).toString('hex')}`).then((r) => r.json()); } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  if (!att) throw new Error(`runner not reachable at ${RUNNER}`);
  // the owner pins the audited release in AUDITED_CODEHASH (npm run pin-codehash). Edit runner/core code
  // without re-pinning and the runner's attestation no longer matches: the UI check turns red.
  const pinned = resolve(ROOT, 'AUDITED_CODEHASH');
  const audited = existsSync(pinned) ? readFileSync(pinned, 'utf8').trim() : computeCodehash(ROOT).codehash;
  if (att.codehash !== audited) console.warn(`[server] WARNING runner codehash ${att.codehash.slice(0, 12)} != audited ${audited.slice(0, 12)} — UI will show the mismatch`);
  ledger.call('frs-dao.testnet', (l) => l.add_runner({ id: RUNNER_ID, signing_pk: att!.signing_pk, enc_pk_hex: att!.enc_pk_hex, codehash: audited, fee_per_run: '30000' }));
  for (const b of catalog.parts) ledger.call(b.author, (l) => l.register_part({ id: b.id, version: b.id.split('@')[1], fee_per_call: b.fee_per_call, manifest_hash: hashObject(b) }));
  app.listen(PORT, '127.0.0.1', () => console.log(`[server] marketplace on http://127.0.0.1:${PORT}  (contract mirror ${CONTRACT_ID}, runner ${RUNNER})`));
  setInterval(() => market.keeperTick(), 500);
  // keeper: activate recipe versions whose notice period has passed (anyone may call apply_update)
  setInterval(() => {
    const now = BigInt(Date.now()) * 1_000_000n;
    for (const r of ledger.recipes.values()) if (r.pending_sealed_hash && now >= r.update_effective_ns) { try { ledger.call('keeper.frs.testnet', (l) => l.apply_update({ id: r.id })); } catch { /* raced */ } }
  }, 1000);
  if (BOTS) setInterval(() => market.botTick(), 1200);
}
void boot();
