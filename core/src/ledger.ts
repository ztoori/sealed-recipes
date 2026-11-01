/**
 * LocalLedger — an in-process mirror of the `fungible-recipes` NEAR contract used
 * by the offline demo. Same methods, same arguments, same settlement math, same
 * signed-report format, same NEP-297 events. Parity is enforced by tests that run
 * the shared vectors in contracts/test-vectors against both implementations.
 *
 * Event names and fields follow docs/CONTRACT_EVENTS.md. Known differences from the contract:
 * withdraw() completes synchronously (no ft_transfer promise) and there is no storage accounting.
 */
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { sha256Hex } from './canonical.js';
import { base64 } from './seal.js';
import { SCALE, settlementSplit, minimumPrice } from './settlement.js';
import { clearAuction, type AuctionOrder } from './auction.js';

export const RUN_TIMEOUT_NS = 15n * 60n * 1_000_000_000n;
export const MAX_ORDERS_PER_BOOK = 200;
export const EVENT_STANDARD = 'fungible-recipes';
export const EVENT_VERSION = '1.0.0';

export interface LedgerBlock { id: string; version: string; author: string; fee_per_call: bigint; manifest_hash: string; active: boolean }
export interface LedgerRunner { id: string; signing_pk: string; enc_pk_hex: string; codehash: string; fee_per_run: bigint; active: boolean }
export interface LedgerRecipe {
  id: string; name: string; creator: string; sealed_hash: string; runner_id: string; blocks: string[];
  price_per_run: bigint; royalty_bps: number; total_shares: bigint; acc_per_share: bigint; runs: bigint; revenue: bigint; listed: boolean; created_ns: bigint;
}
export type RunStatus = 'Pending' | 'Settled' | 'Refunded';
export interface LedgerRun { run_id: string; recipe_id: string; buyer: string; amount: bigint; inputs_hash: string; sealed_hash: string; status: RunStatus; created_ns: bigint }
export interface LedgerOrder { id: number; recipe_id: string; owner: string; side: 'Bid' | 'Ask'; price: bigint; qty: bigint; created_ns: bigint }
export interface LedgerEvent { standard: string; version: string; event: string; data: Record<string, unknown>[]; block_height: number; timestamp_ns: string; tx_hash: string; signer: string }
export interface Payout { account_id: string; role: string; amount: bigint }
export interface Holding { shares: bigint; reward_debt: bigint; locked: bigint }

export function runReportMessage(contractId: string, runId: string, recipeId: string, ok: boolean, outputHash: string, blocksUsed: string[]): string {
  return ['frs-run-v1', contractId, runId, recipeId, ok ? 'ok' : 'fail', outputHash, blocksUsed.join(',')].join('|');
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
  blocks = new Map<string, LedgerBlock>();
  runners = new Map<string, LedgerRunner>();
  recipes = new Map<string, LedgerRecipe>();
  runs = new Map<string, LedgerRun>();
  orders = new Map<number, LedgerOrder>();
  holdings = new Map<string, Holding>(); // key `${recipe}|${account}`
  balances = new Map<string, bigint>();
  events: LedgerEvent[] = [];
  batches = new Map<string, { id: number; opened_ns: bigint }>();
  readonly batchIntervalNs: bigint;
  height = 100_000_000;
  private nextOrderId = 1;
  private clock: () => bigint;
  private predecessor = '';
  private txCounter = 0;

  constructor(o: { contractId: string; owner: string; paymentToken: string; protocolAccount: string; protocolFeeBps: number; batchIntervalNs?: bigint; clock?: () => bigint }) {
    assert(o.protocolFeeBps <= 1000, 'protocol fee too high');
    this.contractId = o.contractId; this.owner = o.owner; this.paymentToken = o.paymentToken;
    this.protocolAccount = o.protocolAccount; this.protocolFeeBps = o.protocolFeeBps;
    this.clock = o.clock ?? (() => BigInt(Date.now()) * 1_000_000n);
    this.batchIntervalNs = o.batchIntervalNs ?? 12n * 1_000_000_000n;
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
  private hkey(recipe: string, account: string) { return `${recipe}|${account}`; }
  private holding(recipe: string, account: string): Holding {
    const k = this.hkey(recipe, account);
    let h = this.holdings.get(k);
    if (!h) { h = { shares: 0n, reward_debt: 0n, locked: 0n }; this.holdings.set(k, h); }
    return h;
  }
  /** harvest pending dividends straight into the withdrawable balance and re-baseline reward_debt (same as contract). */
  private harvest(r: LedgerRecipe, account: string): Holding {
    const h = this.holding(r.id, account);
    const accrued = (h.shares * r.acc_per_share) / SCALE;
    const pending = accrued - h.reward_debt;
    h.reward_debt = accrued;
    this.lastHarvest = pending;
    this.credit(account, pending);
    return h;
  }
  private lastHarvest = 0n;
  private rebase(r: LedgerRecipe, h: Holding) { h.reward_debt = (h.shares * r.acc_per_share) / SCALE; }

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
  register_block(a: { id: string; version: string; fee_per_call: string; manifest_hash: string }) {
    const author = this.caller();
    assert(/^[a-z0-9._@-]{1,64}$/.test(a.id), 'block id must match ^[a-z0-9._@-]{1,64}$');
    assert(!this.blocks.has(a.id), 'block id taken');
    const b = { id: a.id, version: a.version, author, fee_per_call: BigInt(a.fee_per_call), manifest_hash: a.manifest_hash, active: true };
    this.blocks.set(a.id, b);
    this.emit('block_registered', { ...b });
  }

  publish_recipe(a: { id: string; name: string; sealed_hash: string; runner_id: string; blocks: string[]; price_per_run: string; royalty_bps: number; total_shares: string }) {
    const creator = this.caller();
    assert(/^[A-Z0-9]{3,6}$/.test(a.id), 'invalid ticker');
    assert(!this.recipes.has(a.id), 'ticker taken');
    assert(a.royalty_bps <= 5000, 'royalty too high');
    const total = BigInt(a.total_shares); assert(total > 0n, 'total_shares must be > 0');
    const runner = this.runners.get(a.runner_id); assert(runner?.active, 'runner not active');
    assert(a.blocks.length > 0, 'recipe needs at least one block');
    const fees = a.blocks.map((b) => { const blk = this.blocks.get(b); assert(blk?.active, `unknown block ${b}`); return blk.fee_per_call; });
    const price = BigInt(a.price_per_run);
    assert(minimumPrice(price, this.protocolFeeBps, runner.fee_per_run, fees), 'price below minimum viable price');
    const r: LedgerRecipe = { id: a.id, name: a.name, creator, sealed_hash: a.sealed_hash, runner_id: a.runner_id, blocks: a.blocks, price_per_run: price, royalty_bps: a.royalty_bps, total_shares: total, acc_per_share: 0n, runs: 0n, revenue: 0n, listed: true, created_ns: this.now() };
    this.recipes.set(a.id, r);
    const h = this.holding(a.id, creator); h.shares = total; this.rebase(r, h);
    this.batches.set(a.id, { id: 1, opened_ns: this.now() }); // opening auction
    const { created_ns: _c, ...pub } = r;
    this.emit('recipe_published', { ...pub, runs: 0 });
  }

  update_sealed(a: { id: string; sealed_hash: string }) {
    const r = this.recipes.get(a.id); assert(r, 'no recipe'); assert(r.creator === this.caller(), 'only creator');
    r.sealed_hash = a.sealed_hash; // affects runs paid from now on; paid runs keep their snapshot
    this.emit('recipe_updated', { recipe_id: a.id, sealed_hash: a.sealed_hash });
  }

  // ---------- NEAR Intents delivery (ft_transfer_call from payment token) ----------
  ft_on_transfer(a: { sender_id: string; amount: string; msg: string }): string {
    assert(this.caller() === this.paymentToken, 'only payment token');
    const amount = BigInt(a.amount);
    let m: { action: string; [k: string]: string };
    try { m = JSON.parse(a.msg); } catch { throw new LedgerError('invalid msg'); }
    if (m.action !== 'run' && m.action !== 'bid') throw new LedgerError('invalid msg');
    const owner = m.on_behalf_of || a.sender_id; // NEAR Intents: sender is the solver side, not the buyer
    // validate everything before touching state (same order and reasons as the contract)
    const reject = (reason: string): string => {
      if (!m.on_behalf_of) throw new LedgerError(reason); // token contract refunds sender
      this.credit(m.on_behalf_of, amount);
      this.emit('transfer_rejected', { on_behalf_of: m.on_behalf_of, sender_id: a.sender_id, amount, reason });
      return '0';
    };
    if (m.action === 'run') {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(m.run_id ?? '')) return reject('run_id must match ^[A-Za-z0-9_-]{1,64}$');
      if (!/^[0-9a-f]{64}$/.test(m.inputs_hash ?? '')) return reject('inputs_hash must be 64 lowercase hex');
      if (this.runs.has(m.run_id)) return reject('run exists');
      const r = this.recipes.get(m.recipe_id);
      if (!r) return reject('unknown recipe');
      if (!r.listed) return reject('recipe not listed');
      if (amount < r.price_per_run) return reject('payment below price_per_run');
      this.credit(owner, amount - r.price_per_run);
      const run: LedgerRun = { run_id: m.run_id, recipe_id: r.id, buyer: owner, amount: r.price_per_run, inputs_hash: m.inputs_hash, sealed_hash: r.sealed_hash, status: 'Pending', created_ns: this.now() };
      this.runs.set(m.run_id, run);
      this.emit('run_requested', { ...run });
      return '0';
    }
    const r = this.recipes.get(m.recipe_id);
    if (!r) return reject('unknown recipe');
    let price: bigint, qty: bigint;
    try { price = BigInt(m.price); qty = BigInt(m.qty); } catch { return reject('price and qty must be > 0'); }
    if (price <= 0n || qty <= 0n) return reject('price and qty must be > 0');
    if (price * qty >= 2n ** 128n) return reject('price * qty overflows');
    const need = price * qty;
    if (amount < need) return reject('deposit below price * qty');
    if (this.bookSize(r.id) >= MAX_ORDERS_PER_BOOK) return reject('order book full');
    this.credit(owner, amount - need);
    this.rest(r.id, owner, 'Bid', price, qty);
    return '0';
  }

  report_run(a: { run_id: string; success: boolean; blocks_used: string[]; output_hash: string; signature: string }) {
    const run = this.runs.get(a.run_id); assert(run, 'no run'); assert(run.status === 'Pending', 'run not pending');
    const r = this.recipes.get(run.recipe_id)!;
    const runner = this.runners.get(r.runner_id); assert(runner?.active, 'runner inactive');
    assert(/^[0-9a-f]{64}$/.test(a.output_hash), 'output_hash must be 64 lowercase hex');
    const msg = runReportMessage(this.contractId, a.run_id, r.id, a.success, a.output_hash, a.blocks_used);
    const pk = bs58.decode(runner.signing_pk.slice(8));
    const sig = base64.dec(a.signature);
    assert(sig.length === 64 && nacl.sign.detached.verify(utf8ToBytes(msg), sig, pk), 'invalid runner signature');
    if (!a.success) {
      run.status = 'Refunded'; this.credit(run.buyer, run.amount);
      this.emit('run_refunded', { run_id: run.run_id, buyer: run.buyer, amount: run.amount, reason: 'runner_reported_failure' });
      return [];
    }
    const pool = [...r.blocks];
    for (const b of a.blocks_used) { const i = pool.indexOf(b); assert(i >= 0, 'blocks_used not part of recipe'); pool.splice(i, 1); }
    const fees = a.blocks_used.map((b) => this.blocks.get(b)!.fee_per_call);
    const s = settlementSplit({ price: run.amount, protocolFeeBps: this.protocolFeeBps, runnerFee: runner.fee_per_run, blockFees: fees, royaltyBps: r.royalty_bps, totalShares: r.total_shares });
    const payouts: Payout[] = [];
    payouts.push({ account_id: this.protocolAccount, role: 'protocol', amount: s.protocolTotal });
    payouts.push({ account_id: runner.id, role: 'runner', amount: s.runner });
    a.blocks_used.forEach((b, i) => payouts.push({ account_id: this.blocks.get(b)!.author, role: `block:${b}`, amount: s.blocks[i] }));
    payouts.push({ account_id: r.creator, role: 'creator_royalty', amount: s.creator });
    for (const p of payouts) this.credit(p.account_id, p.amount);
    r.acc_per_share += s.accIncrement;
    r.runs += 1n; r.revenue += run.amount;
    run.status = 'Settled';
    this.emit('frs_settlement', { run_id: run.run_id, recipe_id: r.id, buyer: run.buyer, price: run.amount, output_hash: a.output_hash, payouts, shareholder_pool: s.distributed, acc_increment: s.accIncrement });
    return payouts;
  }

  reclaim_run(a: { run_id: string }) {
    const run = this.runs.get(a.run_id); assert(run, 'no run');
    assert(run.buyer === this.caller(), 'only buyer'); assert(run.status === 'Pending', 'run not pending');
    assert(this.now() >= run.created_ns + RUN_TIMEOUT_NS, 'timeout not reached');
    run.status = 'Refunded'; this.credit(run.buyer, run.amount);
    this.emit('run_refunded', { run_id: run.run_id, buyer: run.buyer, amount: run.amount, reason: 'timeout' });
  }

  // ---------- shares & dividends ----------
  transfer_shares(a: { recipe_id: string; receiver_id: string; qty: string }) {
    const from = this.caller(); const qty = BigInt(a.qty);
    const r = this.recipes.get(a.recipe_id); assert(r, 'no recipe'); assert(qty > 0n, 'qty must be > 0');
    assert(a.receiver_id !== from, 'cannot transfer to self');
    const hf = this.harvest(r, from); assert(hf.shares - hf.locked >= qty, 'insufficient available shares');
    const ht = this.harvest(r, a.receiver_id);
    hf.shares -= qty; ht.shares += qty; this.rebase(r, hf); this.rebase(r, ht);
    this.emit('shares_transferred', { recipe_id: r.id, from, to: a.receiver_id, qty });
  }

  claim_dividends(a: { recipe_id: string }): bigint {
    const who = this.caller(); const r = this.recipes.get(a.recipe_id); assert(r, 'no recipe');
    this.harvest(r, who); const amt = this.lastHarvest;
    this.emit('dividends_claimed', { recipe_id: r.id, account_id: who, amount: amt });
    return amt;
  }

  withdraw(a: { amount?: string } = {}): bigint {
    const who = this.caller(); const bal = this.balances.get(who) ?? 0n;
    const amt = a.amount ? BigInt(a.amount) : bal; assert(amt > 0n && amt <= bal, 'insufficient balance');
    this.balances.set(who, bal - amt);
    this.emit('withdrawn', { account_id: who, amount: amt });
    return amt;
  }

  // ---------- share trading: frequent batch auctions ----------
  private bookSize(recipe_id: string) { let n = 0; for (const o of this.orders.values()) if (o.recipe_id === recipe_id) n++; return n; }

  place_ask(a: { recipe_id: string; price: string; qty: string }): number {
    const seller = this.caller();
    const price = BigInt(a.price), qty = BigInt(a.qty); assert(price > 0n && qty > 0n, 'price and qty must be > 0');
    const r = this.recipes.get(a.recipe_id); assert(r, 'no recipe');
    assert(this.bookSize(r.id) < MAX_ORDERS_PER_BOOK, 'order book full');
    const h = this.holding(r.id, seller); assert(h.shares - h.locked >= qty, 'insufficient available shares');
    h.locked += qty; // shares stay with the seller and keep earning until the order fills
    return this.rest(r.id, seller, 'Ask', price, qty);
  }

  /** every accepted order rests; nothing fills until the batch clears */
  private rest(recipe_id: string, owner: string, side: 'Bid' | 'Ask', price: bigint, qty: bigint): number {
    const id = this.nextOrderId++;
    const o = { id, recipe_id, owner, side, price, qty, created_ns: this.now() };
    this.orders.set(id, o);
    this.emit('order_placed', { ...o });
    return id;
  }

  private bookOrders(recipe_id: string): AuctionOrder[] {
    return [...this.orders.values()].filter((o) => o.recipe_id === recipe_id).map((o) => ({ id: o.id, side: o.side, owner: o.owner, price: o.price, qty: o.qty }));
  }

  /** permissionless once the batch interval has elapsed; always opens the next batch */
  clear_batch(a: { recipe_id: string }) {
    const r = this.recipes.get(a.recipe_id); assert(r, 'no recipe');
    const b = this.batches.get(r.id)!;
    assert(this.now() >= b.opened_ns + this.batchIntervalNs, 'batch still open');
    const res = clearAuction(this.bookOrders(r.id));
    // move shares (harvesting dividends first) and pay out, then shrink or remove filled orders
    for (const f of res.fills) {
      const o = this.orders.get(f.order_id)!;
      const h = this.harvest(r, f.owner);
      if (f.side === 'Bid') { h.shares += f.qty; this.credit(f.owner, (o.price - res.price!) * f.qty); }
      else { h.shares -= f.qty; h.locked -= f.qty; this.credit(f.owner, f.qty * res.price!); }
      this.rebase(r, h);
      o.qty -= f.qty;
      if (o.qty === 0n) this.orders.delete(o.id);
    }
    this.emit('batch_cleared', { recipe_id: r.id, batch_id: b.id, price: res.price, volume: res.volume, fills: res.fills.map((f) => ({ order_id: f.order_id, owner: f.owner, side: f.side, qty: f.qty })) });
    this.batches.set(r.id, { id: b.id + 1, opened_ns: this.now() });
    return { batch_id: b.id, price: res.price, volume: res.volume, fills: res.fills.length };
  }

  get_batch(recipe_id: string) {
    const b = this.batches.get(recipe_id); assert(b, 'no recipe');
    return { id: b.id, opened_ns: b.opened_ns, closes_ns: b.opened_ns + this.batchIntervalNs };
  }

  indicative_clearing(recipe_id: string) {
    const res = clearAuction(this.bookOrders(recipe_id));
    return { price: res.price, volume: res.volume, demand: res.demand, supply: res.supply };
  }

  cancel_order(a: { order_id: number }) {
    const o = this.orders.get(a.order_id); assert(o, 'no order'); assert(o.owner === this.caller(), 'only order owner');
    this.orders.delete(o.id);
    if (o.side === 'Ask') this.holding(o.recipe_id, o.owner).locked -= o.qty;
    else this.credit(o.owner, o.price * o.qty);
    this.emit('order_cancelled', { ...o });
  }

  // ---------- views ----------
  shares_of(recipe_id: string, account: string): bigint { return this.holdings.get(this.hkey(recipe_id, account))?.shares ?? 0n; }
  locked_of(recipe_id: string, account: string): bigint { return this.holdings.get(this.hkey(recipe_id, account))?.locked ?? 0n; }
  pending_dividends(recipe_id: string, account: string): bigint {
    const r = this.recipes.get(recipe_id); const h = this.holdings.get(this.hkey(recipe_id, account));
    if (!r || !h) return 0n;
    return (h.shares * r.acc_per_share) / SCALE - h.reward_debt;
  }
  balance_of(account: string): bigint { return this.balances.get(account) ?? 0n; }
  get_book(recipe_id: string) {
    const os = [...this.orders.values()].filter((o) => o.recipe_id === recipe_id);
    return {
      bids: os.filter((o) => o.side === 'Bid').sort((a, b) => (b.price > a.price ? 1 : b.price < a.price ? -1 : a.id - b.id)),
      asks: os.filter((o) => o.side === 'Ask').sort((a, b) => (a.price > b.price ? 1 : a.price < b.price ? -1 : a.id - b.id)),
    };
  }
  quote_settlement(recipe_id: string, blocks_used: string[]) {
    const r = this.recipes.get(recipe_id); assert(r, 'no recipe');
    const runner = this.runners.get(r.runner_id)!;
    return settlementSplit({ price: r.price_per_run, protocolFeeBps: this.protocolFeeBps, runnerFee: runner.fee_per_run, blockFees: blocks_used.map((b) => this.blocks.get(b)!.fee_per_call), royaltyBps: r.royalty_bps, totalShares: r.total_shares });
  }
  holders(recipe_id: string): { account: string; shares: bigint; locked: bigint }[] {
    return [...this.holdings.entries()].filter(([k, h]) => k.startsWith(recipe_id + '|') && h.shares > 0n).map(([k, h]) => ({ account: k.split('|')[1], shares: h.shares, locked: h.locked })).sort((a, b) => (b.shares > a.shares ? 1 : -1));
  }
}

export const toJson = ser;
