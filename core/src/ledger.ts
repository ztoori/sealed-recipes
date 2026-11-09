/**
 * LocalLedger — an in-process mirror of the `sealed-recipes` NEAR contract used
 * by the offline demo. Same methods, same arguments, same settlement math, same
 * signed-report format, same NEP-297 events. Parity is enforced by tests that run
 * the shared vectors in contracts/test-vectors against both implementations.
 *
 * Event names and fields follow docs/CONTRACT_EVENTS.md. Known differences from the contract:
 * withdraw() completes synchronously (no ft_transfer promise) and there is no storage accounting
 * (the contract charges `register_part` / `publish_recipe` callers for the bytes they store; the
 * mirror enforces the same limits on versions and hashes but takes no NEAR).
 */
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { sha256Hex } from './canonical.js';
import { base64 } from './seal.js';
import { rollPrice, MAX_PRICE, MAX_TARGET_RUNS } from './pricing.js';

/** Byte length as the contract measures it (`String::len` is UTF-8 bytes). */
const utf8Len = (s: string) => utf8ToBytes(s).length;
import { settlementSplit, minimumPrice, bondLock, bondRelease, bondSettle, bondWithdraw, bondDeposit, type Bond } from './settlement.js';

export const RUN_TIMEOUT_NS = 15n * 60n * 1_000_000_000n;
export const EVENT_STANDARD = 'sealed-recipes';
export const EVENT_VERSION = '1.0.0';

export interface LedgerPart { id: string; version: string; author: string; fee_per_call: bigint; manifest_hash: string; active: boolean }
export interface LedgerRunner { id: string; signing_pk: string; enc_pk_hex: string; codehash: string; fee_per_run: bigint; active: boolean }
export interface LedgerRecipe {
  id: string; name: string; creator: string; sealed_hash: string; runner_id: string; parts: string[];
  price_per_run: bigint; reserve_bps: number; runs: bigint; revenue: bigint; listed: boolean; created_ns: bigint;
  /** track record + bond (v2) */
  failed: bigint; aborted: bigint; promised_total: bigint; delivered_total: bigint; compensated_total: bigint; bond_available: bigint; bond_locked: bigint;
  /** v4: durable runs and versions with notice */
  settle_mode: SettleMode; version: number; pending_sealed_hash: string; update_effective_ns: bigint;
  /** v6: market-driven pricing; `price_per_run` is the current list price */
  price_floor: bigint; price_ceiling: bigint; target_runs: number; period_start_ns: bigint; period_runs: bigint;
}
export type SettleMode = 'final' | 'checkpoint';
export type RunStatus = 'Pending' | 'Settled' | 'Refunded';
export interface LedgerRun { run_id: string; recipe_id: string; buyer: string; amount: bigint; inputs_hash: string; sealed_hash: string; job_hash: string; expected: bigint; promised: bigint; covered: bigint; status: RunStatus; created_ns: bigint;
  /** v4: durable runs */
  checkpoint_seq: number; state_hash: string; parts_billed: string[]; billed: bigint; last_progress_ns: bigint }
export interface LedgerEvent { standard: string; version: string; event: string; data: Record<string, unknown>[]; block_height: number; timestamp_ns: string; tx_hash: string; signer: string }
export interface Payout { account_id: string; role: string; amount: bigint }

export type Outcome = 'ok' | 'fail' | 'abort';
export function runReportMessage(contractId: string, runId: string, recipeId: string, outcome: Outcome, outputHash: string, delivered: string, partsUsed: string[]): string {
  return ['srs-run-v3', contractId, runId, recipeId, outcome, outputHash, delivered, partsUsed.join(',')].join('|');
}
/** what a runner signs when a recipe quotes for a job: bound to the recipe version, the sealed job, the buyer and the cover */
export interface PricingInput { price_floor: string; price_ceiling: string; target_runs: number }
export interface QuoteFields { sealed_hash: string; job_hash: string; price: string; expected: string; promised: string; cover: string; expires_ns: string }
export interface SignedQuote extends QuoteFields { signature: string }
/** what a runner signs at a checkpoint (v4): progress, the sealed state's hash, and parts to bill now */
export function checkpointMessage(contractId: string, runId: string, recipeId: string, seq: number, stateHash: string, partsDone: string[]): string {
  return ['srs-ckpt-v1', contractId, runId, recipeId, String(seq), stateHash, partsDone.join(',')].join('|');
}
/** removes `sub` from `pool` by first occurrences; null when `sub` is not a sub-multiset */
export function subtractMultiset(pool: string[], sub: string[]): string[] | null {
  const rest = [...pool];
  for (const x of sub) { const i = rest.indexOf(x); if (i < 0) return null; rest.splice(i, 1); }
  return rest;
}
export function quoteMessage(contractId: string, recipeId: string, inputsHash: string, buyer: string, q: QuoteFields): string {
  return ['srs-quote-v3', contractId, recipeId, q.sealed_hash, q.job_hash, inputsHash, buyer, q.price, q.expected, q.promised, q.cover, q.expires_ns].join('|');
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new LedgerError(msg);
}
export class LedgerError extends Error {}

const ser = (v: unknown): unknown =>
  typeof v === 'bigint' ? v.toString() : Array.isArray(v) ? v.map(ser) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, ser(x)])) : v;

export class LocalLedger {
  readonly contractId: string;
  readonly owner: string;
  readonly paymentToken: string;
  protocolAccount: string;
  protocolFeeBps: number;
  parts = new Map<string, LedgerPart>();
  runners = new Map<string, LedgerRunner>();
  recipes = new Map<string, LedgerRecipe>();
  runs = new Map<string, LedgerRun>();
  balances = new Map<string, bigint>();
  events: LedgerEvent[] = [];
  usedQuotes = new Set<string>();
  height = 100_000_000;
  private nextOrderId = 1;
  private clock: () => bigint;
  private predecessor = '';
  private txCounter = 0;

  readonly updateDelayNs: bigint;
  readonly pricePeriodNs: bigint;
  constructor(o: { contractId: string; owner: string; paymentToken: string; protocolAccount: string; protocolFeeBps: number; updateDelayNs?: bigint; pricePeriodNs?: bigint; clock?: () => bigint }) {
    assert(o.protocolFeeBps <= 1000, 'protocol fee too high');
    this.contractId = o.contractId; this.owner = o.owner; this.paymentToken = o.paymentToken;
    this.protocolAccount = o.protocolAccount; this.protocolFeeBps = o.protocolFeeBps;
    this.clock = o.clock ?? (() => BigInt(Date.now()) * 1_000_000n);
    this.updateDelayNs = o.updateDelayNs ?? 24n * 3600n * 1_000_000_000n;
    this.pricePeriodNs = o.pricePeriodNs ?? 3600n * 1_000_000_000n;
    assert(this.pricePeriodNs > 0n, 'price_period_ns must be > 0');
  }

  /** Execute a call "as" a NEAR account; mirrors one transaction/receipt. */
  call<T>(signer: string, fn: (l: this) => T): T {
    this.predecessor = signer;
    this.height += 1;
    this.txCounter += 1;
    const before = this.events.length;
    try {
      return fn(this);
    } catch (e) {
      this.events.length = before; // receipt failed: no events, state changes below are guarded by asserts-first
      throw e;
    } finally {
      this.predecessor = '';
    }
  }

  private now(): bigint { return this.clock(); }
  private emit(event: string, data: Record<string, unknown>) {
    const ts = this.now();
    const tx_hash = bs58.encode(utf8ToBytes(sha256Hex(`${this.txCounter}|${event}|${ts}`).slice(0, 32)));
    this.events.push({ standard: EVENT_STANDARD, version: EVENT_VERSION, event, data: [ser(data) as Record<string, unknown>], block_height: this.height, timestamp_ns: ts.toString(), tx_hash, signer: this.predecessor });
  }
  private caller(): string { assert(this.predecessor, 'no predecessor: wrap calls in ledger.call()'); return this.predecessor; }
  private credit(account: string, amount: bigint) { if (amount > 0n) this.balances.set(account, (this.balances.get(account) ?? 0n) + amount); }
  // ---------- admin ----------
  add_runner(a: { id: string; signing_pk: string; enc_pk_hex: string; codehash: string; fee_per_run: string }) {
    assert(this.caller() === this.owner, 'only owner');
    assert(!this.runners.has(a.id), 'runner exists');
    assert(a.signing_pk.startsWith('ed25519:') && bs58.decode(a.signing_pk.slice(8)).length === 32, 'signing_pk must be ed25519');
    assert(/^[0-9a-f]{64}$/.test(a.enc_pk_hex), 'enc_pk_hex must be 32-byte hex');
    const r = { id: a.id, signing_pk: a.signing_pk, enc_pk_hex: a.enc_pk_hex, codehash: a.codehash, fee_per_run: BigInt(a.fee_per_run), active: true };
    this.runners.set(a.id, r);
    this.emit('runner_added', { ...r });
  }
  set_runner_active(a: { id: string; active: boolean }) {
    assert(this.caller() === this.owner, 'only owner');
    const r = this.runners.get(a.id); assert(r, 'no runner'); r.active = a.active;
  }

  // ---------- builders & creators ----------
  register_part(a: { id: string; version: string; fee_per_call: string; manifest_hash: string }) {
    const author = this.caller();
    assert(/^[a-z0-9._@-]{1,64}$/.test(a.id), 'part id must match ^[a-z0-9._@-]{1,64}$');
    assert(!this.parts.has(a.id), 'part id taken');
    assert(utf8Len(a.version) >= 1 && utf8Len(a.version) <= 32, 'version must be 1..=32 bytes');
    assert(utf8Len(a.manifest_hash) >= 1 && utf8Len(a.manifest_hash) <= 128, 'manifest_hash must be 1..=128 bytes');
    const b = { id: a.id, version: a.version, author, fee_per_call: BigInt(a.fee_per_call), manifest_hash: a.manifest_hash, active: true };
    this.parts.set(a.id, b);
    this.emit('part_registered', { ...b });
  }

  publish_recipe(a: { id: string; name: string; sealed_hash: string; runner_id: string; parts: string[]; price_per_run: string; reserve_bps?: number; settle_mode?: string | null; pricing?: PricingInput | null }) {
    const creator = this.caller();
    assert(/^[A-Z0-9]{3,6}$/.test(a.id), 'invalid ticker');
    assert(!this.recipes.has(a.id), 'ticker taken');
    assert(utf8Len(a.sealed_hash) <= 128, 'sealed_hash must be at most 128 bytes');
    const reserveBps = a.reserve_bps ?? 0;
    assert(Number.isInteger(reserveBps) && reserveBps >= 0 && reserveBps <= 10000, 'reserve_bps must be <= 10000');
    const runner = this.runners.get(a.runner_id); assert(runner?.active, 'runner not active');
    assert(a.parts.length > 0, 'recipe needs at least one part');
    const fees = a.parts.map((b) => { const blk = this.parts.get(b); assert(blk?.active, `unknown part ${b}`); return blk.fee_per_call; });
    const price = BigInt(a.price_per_run);
    const band = this.checkPricing(a.pricing ?? { price_floor: a.price_per_run, price_ceiling: a.price_per_run, target_runs: 1 }, runner.fee_per_run, fees);
    assert(band.floor <= price && price <= band.ceiling, 'price_per_run must be within price_floor and price_ceiling');
    const mode = a.settle_mode ?? 'final';
    assert(mode === 'final' || mode === 'checkpoint', 'settle_mode must be "final" or "checkpoint"');
    const r: LedgerRecipe = { id: a.id, name: a.name, creator, sealed_hash: a.sealed_hash, runner_id: a.runner_id, parts: a.parts, price_per_run: price, reserve_bps: reserveBps, runs: 0n, revenue: 0n, listed: true, created_ns: this.now(),
      failed: 0n, aborted: 0n, promised_total: 0n, delivered_total: 0n, compensated_total: 0n, bond_available: 0n, bond_locked: 0n,
      settle_mode: mode as SettleMode, version: 1, pending_sealed_hash: '', update_effective_ns: 0n,
      price_floor: band.floor, price_ceiling: band.ceiling, target_runs: band.target, period_start_ns: this.now(), period_runs: 0n };
    this.recipes.set(a.id, r);
    const { created_ns: _c, ...pub } = r;
    this.emit('recipe_published', { ...pub, runs: 0 });
  }

  // ---------- market-driven pricing (v6) ----------
  private checkPricing(p: PricingInput, runnerFee: bigint, partFees: bigint[]) {
    const t = p.target_runs, floor = BigInt(p.price_floor), ceiling = BigInt(p.price_ceiling);
    assert(Number.isInteger(t) && t >= 1 && t <= MAX_TARGET_RUNS, 'target_runs must be 1..=1000000');
    assert(floor <= ceiling, 'price_floor must be <= price_ceiling');
    assert(ceiling <= MAX_PRICE, 'price_ceiling too high');
    const fixed = (floor * BigInt(this.protocolFeeBps)) / 10000n + runnerFee + partFees.reduce((x, y) => x + y, 0n);
    assert(floor >= fixed, `price_floor below minimum viable price ${fixed} (protocol + runner + part fees)`);
    return { floor, ceiling, target: t };
  }
  /** the recipe with every ended pricing period applied (pure; what the contract's views return) */
  private rolled(r: LedgerRecipe): { next: LedgerRecipe; ended: bigint } {
    const x = rollPrice({ price: r.price_per_run, periodRuns: r.period_runs, periodStartNs: r.period_start_ns, periodNs: this.pricePeriodNs, now: this.now(), target: r.target_runs, floor: r.price_floor, ceiling: r.price_ceiling });
    if (x.ended === 0n) return { next: r, ended: 0n };
    return { next: { ...r, price_per_run: x.price, period_start_ns: x.periodStartNs, period_runs: 0n }, ended: x.ended };
  }
  /** applies ended periods to storage; emits price_updated when the price moved */
  private rollPrice(r: LedgerRecipe) {
    const { next, ended } = this.rolled(r);
    if (ended === 0n) return;
    if (next.price_per_run !== r.price_per_run) this.emit('price_updated', { recipe_id: r.id, previous: r.price_per_run, price: next.price_per_run, periods: ended, runs: r.period_runs, target_runs: r.target_runs });
    Object.assign(r, { price_per_run: next.price_per_run, period_start_ns: next.period_start_ns, period_runs: 0n });
  }
  set_pricing(a: { id: string; pricing: PricingInput }) {
    const r = this.recipes.get(a.id); assert(r, 'unknown recipe'); assert(r.creator === this.caller(), 'creator only');
    const band = this.checkPricing(a.pricing, this.runners.get(r.runner_id)!.fee_per_run, r.parts.map((b) => this.parts.get(b)?.fee_per_call ?? 0n));
    this.rollPrice(r);
    r.price_floor = band.floor; r.price_ceiling = band.ceiling; r.target_runs = band.target;
    r.price_per_run = r.price_per_run < band.floor ? band.floor : r.price_per_run > band.ceiling ? band.ceiling : r.price_per_run;
    this.emit('pricing_updated', { recipe_id: r.id, price_floor: r.price_floor, price_ceiling: r.price_ceiling, target_runs: r.target_runs, price: r.price_per_run });
  }
  /** anyone may apply ended pricing periods (keeper); returns the current list price */
  update_price(a: { id: string }): bigint {
    const r = this.recipes.get(a.id); assert(r, 'unknown recipe');
    this.rollPrice(r);
    return r.price_per_run;
  }
  /** view: the recipe as of now (ended pricing periods applied), like the contract's get_recipe */
  get_recipe(id: string): LedgerRecipe | undefined { const r = this.recipes.get(id); return r && this.rolled(r).next; }
  list_recipes(): LedgerRecipe[] { return [...this.recipes.values()].map((r) => this.rolled(r).next); }

  // ---------- versions with notice (v4) ----------
  /** activates a due pending update (the contract does this lazily too) */
  private activate(r: LedgerRecipe) {
    if (r.pending_sealed_hash && this.now() >= r.update_effective_ns) {
      r.sealed_hash = r.pending_sealed_hash; r.version += 1; r.pending_sealed_hash = ''; r.update_effective_ns = 0n;
      this.emit('recipe_updated', { recipe_id: r.id, sealed_hash: r.sealed_hash, version: r.version });
    }
  }
  update_sealed(a: { id: string; sealed_hash: string }) {
    const r = this.recipes.get(a.id); assert(r, 'unknown recipe'); assert(r.creator === this.caller(), 'creator only');
    assert(/^[0-9a-f]{64}$/.test(a.sealed_hash), 'sealed_hash must be 64 lowercase hex');
    this.activate(r);
    assert(a.sealed_hash !== r.sealed_hash, 'same as current version');
    r.pending_sealed_hash = a.sealed_hash; r.update_effective_ns = this.now() + this.updateDelayNs;
    this.emit('recipe_update_scheduled', { recipe_id: r.id, sealed_hash: a.sealed_hash, version: r.version + 1, effective_ns: r.update_effective_ns });
  }
  cancel_update(a: { id: string }) {
    const r = this.recipes.get(a.id); assert(r, 'unknown recipe'); assert(r.creator === this.caller(), 'creator only');
    assert(r.pending_sealed_hash, 'no pending update');
    const sh = r.pending_sealed_hash; r.pending_sealed_hash = ''; r.update_effective_ns = 0n;
    this.emit('recipe_update_cancelled', { recipe_id: r.id, sealed_hash: sh });
  }
  apply_update(a: { id: string }) {
    const r = this.recipes.get(a.id); assert(r, 'unknown recipe');
    assert(r.pending_sealed_hash && this.now() >= r.update_effective_ns, 'update not due');
    this.activate(r);
  }

  // ---------- NEAR Intents delivery (ft_transfer_call from payment token) ----------
  ft_on_transfer(a: { sender_id: string; amount: string; msg: string }): string {
    assert(this.caller() === this.paymentToken, 'only payment token');
    const amount = BigInt(a.amount);
    let m: { action: string; quote?: SignedQuote; [k: string]: unknown } & Record<string, any>;
    try { m = JSON.parse(a.msg); } catch { throw new LedgerError('invalid msg'); }
    if (m.action !== 'run' && m.action !== 'bond') throw new LedgerError('invalid msg');
    const owner = m.on_behalf_of || a.sender_id; // NEAR Intents: sender is the solver side, not the buyer
    // validate everything before touching state (same order and reasons as the contract)
    const reject = (reason: string): string => {
      if (!m.on_behalf_of) throw new LedgerError(reason); // token contract refunds sender
      this.credit(m.on_behalf_of, amount);
      this.emit('transfer_rejected', { on_behalf_of: m.on_behalf_of, sender_id: a.sender_id, amount, reason });
      return '0';
    };
    if (m.action === 'run') {
      { const due = this.recipes.get(m.recipe_id); if (due) { this.activate(due); this.rollPrice(due); } } // due update + ended pricing periods first
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(m.run_id ?? '')) return reject('run_id must match ^[A-Za-z0-9_-]{1,64}$');
      if (!/^[0-9a-f]{64}$/.test(m.inputs_hash ?? '')) return reject('inputs_hash must be 64 lowercase hex');
      if (this.runs.has(m.run_id)) return reject('run exists');
      const r = this.recipes.get(m.recipe_id);
      if (!r) return reject('unknown recipe');
      if (!r.listed) return reject('recipe not listed');
      // a signed quote locks its price (within the band); otherwise the current list price applies
      const qp = m.quote as SignedQuote | undefined;
      if (qp && !(typeof qp.price === 'string' && /^\d+$/.test(qp.price))) throw new LedgerError('invalid msg');
      if (m.max_price !== undefined && !(typeof m.max_price === 'string' && /^\d+$/.test(m.max_price))) throw new LedgerError('invalid msg');
      const price = qp ? BigInt(qp.price) : r.price_per_run;
      if (price < r.price_floor || price > r.price_ceiling) return reject('quoted price outside price_floor..price_ceiling');
      if (m.max_price !== undefined && price > BigInt(m.max_price)) return reject('price above max_price');
      if (amount < price) return reject('payment below price');
      let job_hash = '', expected = 0n, promised = 0n, covered = 0n, quoteKey = '';
      if (m.quote) {
        const q = m.quote as SignedQuote;
        const dec = (x: unknown) => typeof x === 'string' && /^\d+$/.test(x);
        // malformed quote objects make the msg unparseable, like the contract (panic → token refunds the sender)
        if (![q.expected, q.promised, q.cover, q.expires_ns].every(dec) || typeof q.signature !== 'string' || typeof q.sealed_hash !== 'string' || typeof q.job_hash !== 'string') throw new LedgerError('invalid msg');
        let sig: Uint8Array; try { sig = base64.dec(q.signature); } catch { throw new LedgerError('invalid msg'); }
        const norm = { sealed_hash: q.sealed_hash, job_hash: q.job_hash, price: BigInt(q.price).toString(), expected: BigInt(q.expected).toString(), promised: BigInt(q.promised).toString(), cover: BigInt(q.cover).toString(), expires_ns: BigInt(q.expires_ns).toString() };
        if (!/^[0-9a-f]{64}$/.test(q.job_hash)) return reject('job_hash must be 64 lowercase hex');
        if (q.sealed_hash !== r.sealed_hash) return reject('quote for an outdated recipe version');
        const runner = this.runners.get(r.runner_id)!;
        if (!runner.active) return reject('runner inactive');
        const msg = quoteMessage(this.contractId, r.id, m.inputs_hash, owner, norm);
        let ok = false;
        try { ok = sig.length === 64 && nacl.sign.detached.verify(utf8ToBytes(msg), sig, bs58.decode(runner.signing_pk.slice(8))); } catch { ok = false; }
        if (!ok) return reject('invalid quote signature');
        if (this.now() > BigInt(norm.expires_ns)) return reject('quote expired');
        quoteKey = sha256Hex(msg);
        if (this.usedQuotes.has(quoteKey)) return reject('quote already used');
        if (BigInt(norm.cover) > BigInt(norm.promised)) return reject('cover exceeds promise');
        if (r.bond_available < BigInt(norm.cover)) return reject('bond below quoted cover');
        job_hash = q.job_hash; expected = BigInt(norm.expected); promised = BigInt(norm.promised); covered = BigInt(norm.cover);
      }
      if (quoteKey) this.usedQuotes.add(quoteKey);
      this.credit(owner, amount - price);
      this.setBond(r, bondLock(this.bondOf(r), covered)!);
      r.period_runs += 1n; // demand counted at payment
      const run: LedgerRun = { run_id: m.run_id, recipe_id: r.id, buyer: owner, amount: price, inputs_hash: m.inputs_hash, sealed_hash: r.sealed_hash, job_hash, expected, promised, covered, status: 'Pending', created_ns: this.now(),
        checkpoint_seq: 0, state_hash: '', parts_billed: [], billed: 0n, last_progress_ns: this.now() };
      this.runs.set(m.run_id, run);
      this.emit('run_requested', { ...run });
      return '0';
    }
    if (m.action === 'bond') {
      const rb = this.recipes.get(m.recipe_id);
      if (!rb) return reject('unknown recipe');
      this.setBond(rb, bondDeposit(this.bondOf(rb), amount)!);
      this.emit('bond_posted', { recipe_id: rb.id, from: owner, amount, bond_available: rb.bond_available });
      return '0';
    }
    return reject('invalid msg');
  }

  report_run(a: { run_id: string; outcome: Outcome; parts_used: string[]; output_hash: string; delivered: string; signature: string }) {
    // same check order and messages as the contract
    const run = this.runs.get(a.run_id); assert(run, 'unknown run'); assert(run.status === 'Pending', 'run not pending');
    assert(a.outcome === 'ok' || a.outcome === 'fail' || a.outcome === 'abort', 'invalid outcome');
    assert(/^[0-9a-f]{64}$/.test(a.output_hash), 'output_hash must be 64 lowercase hex');
    const r = this.recipes.get(run.recipe_id)!;
    const runner = this.runners.get(r.runner_id); assert(runner?.active, 'runner inactive');
    const msg = runReportMessage(this.contractId, a.run_id, r.id, a.outcome, a.output_hash, a.delivered, a.parts_used);
    const pk = bs58.decode(runner.signing_pk.slice(8));
    const sig = base64.dec(a.signature);
    assert(sig.length === 64 && nacl.sign.detached.verify(utf8ToBytes(msg), sig, pk), 'invalid runner signature');
    if (a.outcome !== 'ok') {
      run.status = 'Refunded'; this.credit(run.buyer, run.amount - run.billed); // parts billed at checkpoints stay paid
      this.releaseCover(r, run);
      if (a.outcome === 'abort') r.aborted += 1n; else r.failed += 1n;
      this.emit('run_refunded', { run_id: run.run_id, buyer: run.buyer, amount: run.amount - run.billed, reason: a.outcome === 'abort' ? 'runner_aborted' : 'runner_reported_failure' });
      return [];
    }
    assert(subtractMultiset(r.parts, a.parts_used), 'parts_used not part of recipe');
    const unbilled = subtractMultiset(a.parts_used, run.parts_billed); assert(unbilled, 'parts_used must include billed parts');
    const fees = a.parts_used.map((b) => this.parts.get(b)!.fee_per_call);
    const s = settlementSplit({ price: run.amount, protocolFeeBps: this.protocolFeeBps, runnerFee: runner.fee_per_run, partFees: fees, reserveBps: r.reserve_bps });
    const payouts: Payout[] = [];
    payouts.push({ account_id: this.protocolAccount, role: 'protocol', amount: s.protocol });
    payouts.push({ account_id: runner.id, role: 'runner', amount: s.runner });
    // parts already billed at checkpoints are not paid again (first occurrences are the billed ones)
    const toSkip = [...run.parts_billed];
    a.parts_used.forEach((b, i) => { const k = toSkip.indexOf(b); if (k >= 0) { toSkip.splice(k, 1); return; } payouts.push({ account_id: this.parts.get(b)!.author, role: `part:${b}`, amount: s.parts[i] }); });
    payouts.push({ account_id: r.creator, role: 'creator', amount: s.creator });
    for (const p of payouts) this.credit(p.account_id, p.amount);
    this.setBond(r, bondDeposit(this.bondOf(r), s.reserve)!); // the creator's reserve grows the guarantee deposit
    r.runs += 1n; r.revenue += run.amount;
    // bonded quote: compensate any shortfall from the cover locked when the run was paid
    const delivered = BigInt(a.delivered);
    const [bond, compensation] = bondSettle(this.bondOf(r), run.covered, run.promised, delivered)!;
    this.setBond(r, bond);
    this.credit(run.buyer, compensation);
    if (run.job_hash) { r.promised_total += run.promised; r.delivered_total += delivered; }
    r.compensated_total += compensation;
    run.status = 'Settled';
    this.emit('srs_settlement', { run_id: run.run_id, recipe_id: r.id, buyer: run.buyer, price: run.amount, output_hash: a.output_hash, payouts, reserve: s.reserve, delivered, compensation });
    return payouts;
  }

  reclaim_run(a: { run_id: string }) {
    const run = this.runs.get(a.run_id); assert(run, 'no run');
    assert(run.buyer === this.caller(), 'only buyer'); assert(run.status === 'Pending', 'run not pending');
    assert(this.now() >= run.last_progress_ns + RUN_TIMEOUT_NS, 'timeout not reached'); // checkpoints extend it
    run.status = 'Refunded'; this.credit(run.buyer, run.amount - run.billed);
    const r = this.recipes.get(run.recipe_id)!; this.releaseCover(r, run); r.failed += 1n;
    this.emit('run_refunded', { run_id: run.run_id, buyer: run.buyer, amount: run.amount - run.billed, reason: 'timeout' });
  }

  /** v4: durable progress. Records the sealed state's hash, extends the timeout, and in checkpoint mode pays
   *  the authors of the parts finished since the last checkpoint. Same check order and messages as the contract. */
  checkpoint_run(a: { run_id: string; seq: number; state_hash: string; parts_done: string[]; signature: string }) {
    const run = this.runs.get(a.run_id); assert(run, 'unknown run'); assert(run.status === 'Pending', 'run not pending');
    const r = this.recipes.get(run.recipe_id)!;
    const runner = this.runners.get(r.runner_id); assert(runner?.active, 'runner inactive');
    assert(a.seq === run.checkpoint_seq + 1, 'seq must be checkpoint_seq + 1');
    assert(/^[0-9a-f]{64}$/.test(a.state_hash), 'state_hash must be 64 lowercase hex');
    const msg = checkpointMessage(this.contractId, a.run_id, r.id, a.seq, a.state_hash, a.parts_done);
    let sig: Uint8Array; try { sig = base64.dec(a.signature); } catch { sig = new Uint8Array(); }
    assert(sig.length === 64 && nacl.sign.detached.verify(utf8ToBytes(msg), sig, bs58.decode(runner.signing_pk.slice(8))), 'invalid runner signature');
    const payouts: Payout[] = [];
    if (a.parts_done.length) {
      assert(r.settle_mode === 'checkpoint', 'parts can only be billed at checkpoints in checkpoint mode');
      assert(subtractMultiset(r.parts, [...run.parts_billed, ...a.parts_done]), 'parts_done not part of recipe');
      for (const id of a.parts_done) { const p = this.parts.get(id)!; payouts.push({ account_id: p.author, role: `part:${id}`, amount: p.fee_per_call }); }
      for (const p of payouts) { this.credit(p.account_id, p.amount); run.billed += p.amount; }
      run.parts_billed.push(...a.parts_done);
    }
    run.checkpoint_seq = a.seq; run.state_hash = a.state_hash; run.last_progress_ns = this.now();
    this.emit('run_checkpoint', { run_id: run.run_id, seq: a.seq, state_hash: a.state_hash, parts_done: a.parts_done, billed: run.billed, payouts });
    return payouts;
  }

  private releaseCover(r: LedgerRecipe, run: LedgerRun) { this.setBond(r, bondRelease(this.bondOf(r), run.covered)!); }
  private bondOf(r: LedgerRecipe): Bond { return { available: r.bond_available, locked: r.bond_locked }; }
  private setBond(r: LedgerRecipe, b: Bond) { r.bond_available = b.available; r.bond_locked = b.locked; }

  withdraw_bond(a: { recipe_id: string; amount: string }) {
    const r = this.recipes.get(a.recipe_id); assert(r, 'unknown recipe');
    assert(r.creator === this.caller(), 'creator only');
    const amt = BigInt(a.amount); assert(amt > 0n, 'amount must be > 0'); assert(amt <= r.bond_available, 'amount exceeds bond_available');
    this.setBond(r, bondWithdraw(this.bondOf(r), amt)!); this.credit(r.creator, amt);
    this.emit('bond_withdrawn', { recipe_id: r.id, amount: amt, bond_available: r.bond_available });
  }

  withdraw(a: { amount?: string } = {}): bigint {
    const who = this.caller(); const bal = this.balances.get(who) ?? 0n;
    const amt = a.amount ? BigInt(a.amount) : bal; assert(amt > 0n && amt <= bal, 'insufficient balance');
    this.balances.set(who, bal - amt);
    this.emit('withdrawn', { account_id: who, amount: amt });
    return amt;
  }

  balance_of(account: string): bigint { return this.balances.get(account) ?? 0n; }
  quote_settlement(recipe_id: string, parts_used: string[]) {
    const r = this.get_recipe(recipe_id); assert(r, 'no recipe');
    const runner = this.runners.get(r.runner_id)!;
    return { price: r.price_per_run, ...settlementSplit({ price: r.price_per_run, protocolFeeBps: this.protocolFeeBps, runnerFee: runner.fee_per_run, partFees: parts_used.map((b) => this.parts.get(b)!.fee_per_call), reserveBps: r.reserve_bps }) };
  }
}

export const toJson = ser;
