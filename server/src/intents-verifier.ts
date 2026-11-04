/**
 * Local stand-in for the NEAR Intents Verifier (intents.near) and the Solver Relay (Message Bus) JSON-RPC,
 * for atomic multi-swap bundles. It reproduces the documented semantics that matter here:
 *
 *  - users deposit NEP-141 tokens into the Verifier (ft_transfer_call to intents.near) and hold internal balances;
 *  - `quote` asks solvers for firm quotes (each with a quote_hash);
 *  - `publish_intent` submits ONE NEP-413-signed payload holding several intents (token_diff per swap, then
 *    ft_withdraw); the relay adds each quoted solver's counter-diff and the Verifier executes the whole batch:
 *    every token must net to zero and every balance must stay non-negative, or NOTHING changes;
 *  - `get_status` reports PENDING → SETTLED, or NOT_FOUND_OR_NOT_VALID with a reason.
 * Real endpoints: POST https://solver-relay-v2.chaindefuser.com/rpc, Verifier `intents.near` (docs.near-intents.org).
 * Simplifications, stated: one built-in solver; a signer's key is checked against the demo wallet key instead of
 * the account's registered keys; ft_withdraw pays out inside the same step (on NEAR it is a follow-up receipt).
 */
import { sha256Hex } from '../../core/src/canonical.js';
import { verifyNep413, type SignedNep413 } from '../../core/src/nep413.js';
import { demoWalletKey } from '../../core/src/creator.js';
import bs58 from 'bs58';
import type { Token } from '../../core/src/oneclick.js';
import type { World } from './world.js';

interface Quote { quote_hash: string; defuse_asset_identifier_in: string; defuse_asset_identifier_out: string; amount_in: string; amount_out: string; expiration_time: string }
type Intent = { intent: 'token_diff'; diff: Record<string, string> } | { intent: 'ft_withdraw'; token: string; receiver_id: string; amount: string };

export class IntentsVerifierMock {
  readonly balances = new Map<string, Map<string, bigint>>(); // account -> token id (nep141:contract) -> amount
  private quotes = new Map<string, Quote>();
  private statuses = new Map<string, { status: string; reason?: string; tx_hash?: string; settled_at?: string }>();
  /** local demo hook: the solver backs out of fills that involve these assets (to show all-or-nothing) */
  readonly failing = new Set<string>();
  readonly log: { at: string; method: string; summary: string }[] = [];

  constructor(private world: World, private tokens: Token[], private clock = () => Date.now()) {}

  balanceOf(account: string, token: string) { return this.balances.get(account)?.get(token) ?? 0n; }
  private add(m: Map<string, Map<string, bigint>>, account: string, token: string, d: bigint) {
    if (!m.has(account)) m.set(account, new Map());
    const b = m.get(account)!; b.set(token, (b.get(token) ?? 0n) + d);
  }
  /** ft_transfer_call(receiver_id = intents.near): the token contract credits the Verifier for `account` */
  deposit(account: string, contract: string, amount: bigint) { this.add(this.balances, account, `nep141:${contract}`, amount); }

  private price(asset: string) {
    const t = this.tokens.find((x) => x.assetId === asset);
    if (!t) throw new Error(`no solver quotes ${asset}`);
    return { price: Number(t.price), decimals: t.decimals };
  }

  quote(p: { defuse_asset_identifier_in: string; defuse_asset_identifier_out: string; exact_amount_in: string }): Quote[] {
    const a = this.price(p.defuse_asset_identifier_in), b = this.price(p.defuse_asset_identifier_out);
    const usd = (Number(p.exact_amount_in) / 10 ** a.decimals) * a.price * (1 - 0.003); // solver spread
    const out = BigInt(Math.floor((usd / b.price) * 10 ** b.decimals));
    if (out <= 0n) return [];
    const q: Quote = {
      quote_hash: bs58.encode(Buffer.from(sha256Hex(`${p.defuse_asset_identifier_in}|${p.exact_amount_in}|${this.clock()}|${Math.random()}`).slice(0, 32), 'hex')),
      defuse_asset_identifier_in: p.defuse_asset_identifier_in, defuse_asset_identifier_out: p.defuse_asset_identifier_out,
      amount_in: p.exact_amount_in, amount_out: out.toString(), expiration_time: new Date(this.clock() + 60_000).toISOString(),
    };
    this.quotes.set(q.quote_hash, q);
    return [q];
  }

  publish(p: { quote_hashes: string[]; signed_data: SignedNep413 }): { status: string; intent_hash: string } {
    const intent_hash = bs58.encode(Buffer.from(sha256Hex(JSON.stringify(p.signed_data)).slice(0, 32), 'hex'));
    const fail = (reason: string) => { this.statuses.set(intent_hash, { status: 'NOT_FOUND_OR_NOT_VALID', reason }); this.log.push({ at: new Date(this.clock()).toISOString(), method: 'publish_intent', summary: `rejected: ${reason}` }); return { status: 'OK', intent_hash }; };
    const s = p.signed_data;
    if (s?.standard !== 'nep413' || s.payload.recipient !== 'intents.near') return fail('expected a nep413 payload for intents.near');
    if (!verifyNep413(s)) return fail('invalid signature');
    let msg: { signer_id: string; deadline: string; intents: Intent[] };
    try { msg = JSON.parse(s.payload.message); } catch { return fail('unparseable message'); }
    if ('ed25519:' + bs58.encode(demoWalletKey(msg.signer_id).publicKey) !== s.public_key) return fail('public key is not registered for signer'); // demo wallet keys
    if (new Date(msg.deadline).getTime() < this.clock()) return fail('deadline passed');

    // build the batch: the user's intents plus each quoted solver's mirror diff, applied to a scratch copy
    const scratch = new Map([...this.balances].map(([a, m]) => [a, new Map(m)]));
    const net = new Map<string, bigint>();
    const credit = (acct: string, tok: string, d: bigint) => { this.add(scratch, acct, tok, d); net.set(tok, (net.get(tok) ?? 0n) + d); };
    const payouts: { token: string; to: string; amount: bigint }[] = [];
    for (const it of msg.intents) {
      if (it.intent === 'token_diff') for (const [tok, d] of Object.entries(it.diff)) credit(msg.signer_id, tok, BigInt(d));
      else if (it.intent === 'ft_withdraw') { this.add(scratch, msg.signer_id, `nep141:${it.token}`, -BigInt(it.amount)); payouts.push({ token: it.token, to: it.receiver_id, amount: BigInt(it.amount) }); }
      else return fail(`unsupported intent ${(it as { intent: string }).intent}`);
    }
    for (const h of p.quote_hashes) {
      const q = this.quotes.get(h);
      if (!q) return fail(`unknown quote ${h}`);
      if (new Date(q.expiration_time).getTime() < this.clock()) return fail(`quote ${h} expired`);
      if (this.failing.has(q.defuse_asset_identifier_in)) return fail(`solver could not fill ${q.defuse_asset_identifier_in}`);
      // solver's counter-diff: receives amount_in, pays amount_out
      credit('solver-1.near', q.defuse_asset_identifier_in, BigInt(q.amount_in));
      credit('solver-1.near', q.defuse_asset_identifier_out, -BigInt(q.amount_out));
    }
    for (const [tok, v] of net) if (v !== 0n) return fail(`diffs do not net to zero for ${tok} (${v})`);
    for (const [acct, m] of scratch) if (acct !== 'solver-1.near') for (const [tok, v] of m) if (v < 0n) return fail(`insufficient ${tok} balance for ${acct}`);

    // commit everything at once
    for (const [acct, m] of scratch) this.balances.set(acct, m);
    for (const po of payouts) this.world.credit(po.to, po.token, po.amount);
    const tx_hash = bs58.encode(Buffer.from(sha256Hex(`execute_intents|${intent_hash}`).slice(0, 32), 'hex'));
    this.statuses.set(intent_hash, { status: 'SETTLED', tx_hash, settled_at: new Date(this.clock()).toISOString() });
    this.log.push({ at: new Date(this.clock()).toISOString(), method: 'publish_intent', summary: `settled ${p.quote_hashes.length} swaps + ${payouts.length} withdrawal in one execute_intents (${tx_hash})` });
    return { status: 'OK', intent_hash };
  }

  /** the account withdraws its own balances back to its wallet (on NEAR: signed ft_withdraw intents) */
  withdrawAll(account: string) {
    const m = this.balances.get(account); if (!m) return 0;
    let n = 0;
    for (const [tok, v] of m) if (v > 0n) { this.world.credit(account, tok.replace(/^nep141:/, ''), v); m.set(tok, 0n); n++; }
    this.log.push({ at: new Date(this.clock()).toISOString(), method: 'ft_withdraw', summary: `${account} withdrew ${n} token balance(s) back to its wallet` });
    return n;
  }

  status(intent_hash: string) {
    const s = this.statuses.get(intent_hash);
    return s ? { intent_hash, ...s, data: s.tx_hash ? { hash: s.tx_hash } : undefined } : { intent_hash, status: 'NOT_FOUND_OR_NOT_VALID', reason: 'unknown intent' };
  }
}
