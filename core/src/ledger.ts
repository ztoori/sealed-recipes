/**
 * LocalLedger — an in-process mirror of the `fungible-recipes` NEAR contract used
 * by the offline demo. Same methods, same arguments, same settlement math, same
 * signed-report format, same NEP-297 events. Parity is enforced by tests that run
 * the shared vectors in contracts/test-vectors against both implementations.
 *
 * In testnet mode the server swaps this for `NearContractAdapter` (server/src/chain.ts).
 */
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { sha256Hex } from './canonical.js';
import { base64 } from './seal.js';
import { SCALE, settlementSplit, minimumPrice } from './settlement.js';

export const RUN_TIMEOUT_NS = 15n * 60n * 1_000_000_000n;
export const EVENT_STANDARD = 'fungible-recipes';
export const EVENT_VERSION = '1.0.0';

export interface LedgerBlock { id: string; version: string; author: string; fee_per_call: bigint; manifest_hash: string; active: boolean }
export interface LedgerRunner { id: string; signing_pk: string; enc_pk_hex: string; codehash: string; fee_per_run: bigint; active: boolean }
export interface LedgerRecipe {
  id: string; name: string; creator: string; sealed_hash: string; runner_id: string; blocks: string[];
  price_per_run: bigint; royalty_bps: number; total_shares: bigint; acc_per_share: bigint; runs: bigint; revenue: bigint; created_ns: bigint;
}
export type RunStatus = 'Pending' | 'Settled' | 'Refunded';
export interface LedgerRun { run_id: string; recipe_id: string; buyer: string; amount: bigint; inputs_hash: string; status: RunStatus; created_ns: bigint }
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
  height = 100_000_000;
  private nextOrderId = 1;
  private clock: () => bigint;
  private predecessor = '';
  private txCounter = 0;

  constructor(o: { contractId: string; owner: string; paymentToken: string; protocolAccount: string; protocolFeeBps: number; clock?: () => bigint }) {
    assert(o.protocolFeeBps <= 1000, 'protocol fee too high');
    this.contractId = o.contractId; this.owner = o.owner; this.paymentToken = o.paymentToken;
    this.protocolAccount = o.protocolAccount; this.protocolFeeBps = o.protocolFeeBps;
    this.clock = o.clock ?? (() => BigInt(Date.now()) * 1_000_000n);
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
    this.runners.set(a.id, { ...a, fee_per_run: BigInt(a.fee_per_run), active: true });
    this.emit('runner_added', { runner_id: a.id, codehash: a.codehash });
  }
  set_runner_active(a: { id: string; active: boolean }) {
    assert(this.caller() === this.owner, 'only owner');
    const r = this.runners.get(a.id); assert(r, 'no runner'); r.active = a.active;
  }

  // ---------- builders & creators ----------
  register_block(a: { id: string; version: string; fee_per_call: string; manifest_hash: string }) {
    const author = this.caller();
    assert(!this.blocks.has(a.id), 'block id taken');
    this.blocks.set(a.id, { id: a.id, version: a.version, author, fee_per_call: BigInt(a.fee_per_call), manifest_hash: a.manifest_hash, active: true });
    this.emit('block_registered', { block_id: a.id, author, fee_per_call: a.fee_per_call, manifest_hash: a.manifest_hash });
  }

  publish_recipe(a: { id: string; name: string; sealed_hash: string; runner_id: string; blocks: string[]; price_per_run: string; royalty_bps: number; total_shares: string }) {
    const creator = this.caller();
    assert(/^[A-Z0-9]{3,6}$/.test(a.id), 'invalid ticker');
    assert(!this.recipes.has(a.id), 'ticker taken');
    assert(a.royalty_bps <= 5000, 'royalty too high');
    const total = BigInt(a.total_shares); assert(total > 0n, 'total_shares must be > 0');
    const runner = this.runners.get(a.runner_id); assert(runner?.active, 'runner not active');
    assert(a.blocks.length > 0, 'no blocks');
    const fees = a.blocks.map((b) => { const blk = this.blocks.get(b); assert(blk?.active, `unknown block ${b}`); return blk.fee_per_call; });
    const price = BigInt(a.price_per_run);
    assert(minimumPrice(price, this.protocolFeeBps, runner.fee_per_run, fees), 'price below minimum viable price');
    const r: LedgerRecipe = { id: a.id, name: a.name, creator, sealed_hash: a.sealed_hash, runner_id: a.runner_id, blocks: a.blocks, price_per_run: price, royalty_bps: a.royalty_bps, total_shares: total, acc_per_share: 0n, runs: 0n, revenue: 0n, created_ns: this.now() };
    this.recipes.set(a.id, r);
    const h = this.holding(a.id, creator); h.shares = total; this.rebase(r, h);
    this.emit('recipe_published', { recipe_id: a.id, creator, sealed_hash: a.sealed_hash, price_per_run: a.price_per_run, total_shares: a.total_shares });
  }

  update_sealed(a: { id: string; sealed_hash: string }) {
    const r = this.recipes.get(a.id); assert(r, 'no recipe'); assert(r.creator === this.caller(), 'only creator');
    r.sealed_hash = a.sealed_hash;
  }

  // ---------- NEAR Intents delivery (ft_transfer_call from payment token) ----------
  ft_on_transfer(a: { sender_id: string; amount: string; msg: string }): string {
    assert(this.caller() === this.paymentToken, 'only payment token');
    const amount = BigInt(a.amount);
    let m: { action: string; [k: string]: string };
    try { m = JSON.parse(a.msg); } catch { throw new LedgerError('bad msg'); }
    const owner = m.on_behalf_of || a.sender_id; // NEAR Intents: sender is the solver
    if (m.action === 'run') {
      const r = this.recipes.get(m.recipe_id); assert(r, 'no recipe');
      assert(!this.runs.has(m.run_id), 'run id used');
      assert(/^[0-9a-f]{64}$/.test(m.inputs_hash ?? ''), 'inputs_hash must be sha256 hex');
      assert(amount >= r.price_per_run, 'insufficient payment');
      this.credit(owner, amount - r.price_per_run);
      this.runs.set(m.run_id, { run_id: m.run_id, recipe_id: r.id, buyer: owner, amount: r.price_per_run, inputs_hash: m.inputs_hash, status: 'Pending', created_ns: this.now() });
      this.emit('run_requested', { run_id: m.run_id, recipe_id: r.id, buyer: owner, amount: r.price_per_run, inputs_hash: m.inputs_hash, paid_by: a.sender_id });
      return '0';
    }
    if (m.action === 'bid') {
      const r = this.recipes.get(m.recipe_id); assert(r, 'no recipe');
      const price = BigInt(m.price), qty = BigInt(m.qty);
      assert(price > 0n && qty > 0n, 'price and qty must be > 0');
      const need = price * qty; assert(amount >= need, 'insufficient escrow');
      this.credit(owner, amount - need);
      this.matchBid(r, owner, price, qty);
      return '0';
    }
    throw new LedgerError('unknown action');
  }

  report_run(a: { run_id: string; success: boolean; blocks_used: string[]; output_hash: string; signature: string }) {
    const run = this.runs.get(a.run_id); assert(run, 'no run'); assert(run.status === 'Pending', 'run not pending');
    const r = this.recipes.get(run.recipe_id)!;
    const runner = this.runners.get(r.runner_id); assert(runner?.active, 'runner inactive');
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
    this.emit('dividends_claimed', { recipe_id: r.id, account: who, amount: amt });
    return amt;
  }

  withdraw(a: { amount?: string } = {}): bigint {
    const who = this.caller(); const bal = this.balances.get(who) ?? 0n;
    const amt = a.amount ? BigInt(a.amount) : bal; assert(amt > 0n && amt <= bal, 'insufficient balance');
    this.balances.set(who, bal - amt);
    this.emit('withdrawn', { account: who, amount: amt, token: this.paymentToken });
    return amt;
  }

  // ---------- order book ----------
  place_ask(a: { recipe_id: string; price: string; qty: string }) {
    const seller = this.caller(); const r = this.recipes.get(a.recipe_id); assert(r, 'no recipe');
    const price = BigInt(a.price), qty = BigInt(a.qty); assert(price > 0n && qty > 0n, 'price and qty must be > 0');
    const h = this.holding(r.id, seller); assert(h.shares - h.locked >= qty, 'insufficient available shares');
    h.locked += qty;
    let left = qty;
    const bids = [...this.orders.values()].filter((o) => o.recipe_id === r.id && o.side === 'Bid' && o.price >= price).sort((x, y) => (y.price > x.price ? 1 : y.price < x.price ? -1 : x.id - y.id));
    for (const b of bids) {
      if (left === 0n) break;
      const q = b.qty < left ? b.qty : left;
      this.fill(r, seller, b.owner, q, b.price, b.id, 'Ask');
      b.qty -= q; left -= q;
      if (b.qty === 0n) this.orders.delete(b.id);
    }
    if (left > 0n) this.rest(r.id, seller, 'Ask', price, left);
  }

  private matchBid(r: LedgerRecipe, buyer: string, price: bigint, qty: bigint) {
    let left = qty;
    const asks = [...this.orders.values()].filter((o) => o.recipe_id === r.id && o.side === 'Ask' && o.price <= price).sort((x, y) => (x.price > y.price ? 1 : x.price < y.price ? -1 : x.id - y.id));
    for (const ask of asks) {
      if (left === 0n) break;
      const q = ask.qty < left ? ask.qty : left;
      this.fill(r, ask.owner, buyer, q, ask.price, ask.id, 'Bid');
      this.credit(buyer, (price - ask.price) * q); // price improvement back to taker
      ask.qty -= q; left -= q;
      if (ask.qty === 0n) this.orders.delete(ask.id);
    }
    if (left > 0n) this.rest(r.id, buyer, 'Bid', price, left);
  }

  private fill(r: LedgerRecipe, seller: string, buyer: string, qty: bigint, price: bigint, makerId: number, takerSide: 'Bid' | 'Ask') {
    const hs = this.harvest(r, seller); const hb = this.harvest(r, buyer);
    hs.locked -= qty; hs.shares -= qty; hb.shares += qty;
    this.rebase(r, hs); this.rebase(r, hb);
    this.credit(seller, qty * price);
    this.emit('trade', { recipe_id: r.id, maker_order_id: makerId, taker_side: takerSide, seller, buyer, qty, price });
  }

  private rest(recipe_id: string, owner: string, side: 'Bid' | 'Ask', price: bigint, qty: bigint) {
    const id = this.nextOrderId++;
    this.orders.set(id, { id, recipe_id, owner, side, price, qty, created_ns: this.now() });
    this.emit('order_placed', { order_id: id, recipe_id, owner, side, price, qty });
  }

  cancel_order(a: { order_id: number }) {
    const o = this.orders.get(a.order_id); assert(o, 'no order'); assert(o.owner === this.caller(), 'only order owner');
    this.orders.delete(o.id);
    if (o.side === 'Ask') this.holding(o.recipe_id, o.owner).locked -= o.qty;
    else this.credit(o.owner, o.price * o.qty);
    this.emit('order_cancelled', { order_id: o.id, recipe_id: o.recipe_id, owner: o.owner });
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
