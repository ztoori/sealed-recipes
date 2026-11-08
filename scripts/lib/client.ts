/**
 * Client-side helpers shared by the CLI scripts (they act as the creator / buyer
 * clients — the same steps the browser performs).
 */
import { randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import { bytesToHex } from '@noble/hashes/utils.js';
import { seal, publicListing, validateRecipe, verifyRunnerAttestation, creatorKeyFromSignature, creatorKeyMessage, demoWalletSign, type Catalog, type Recipe, type RunnerAttestation } from '../../core/src/index.js';

export const BASE = process.env.SRS_URL ?? 'http://127.0.0.1:8080';

export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(BASE + path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${path} → ${r.status} ${t}`);
  return JSON.parse(t) as T;
}

export async function verifiedRunner() {
  const nonce = randomBytes(32).toString('hex');
  const { attestation, onchain } = await api<{ attestation: RunnerAttestation; onchain: { signing_pk: string; enc_pk_hex: string; codehash: string } }>(`/api/runner/attestation?nonce=${nonce}`);
  const v = verifyRunnerAttestation(attestation, { nonce, signing_pk: onchain.signing_pk, enc_pk_hex: onchain.enc_pk_hex, codehash: onchain.codehash });
  if (!v.ok) throw new Error('runner attestation failed: ' + JSON.stringify(v.checks.filter((c) => c.status === 'fail')));
  return { attestation, onchain, checks: v.checks, hardware: v.hardware };
}

export async function publish(recipe: Recipe, catalog: Catalog, encPkHex: string) {
  const v = validateRecipe(recipe, catalog);
  if (!v.ok) throw new Error('invalid recipe: ' + JSON.stringify(v.diagnostics));
  const listing = publicListing(recipe, catalog);
  const sealed = seal(recipe, encPkHex, 'recipe');
  return api<{ sealed_hash: string; tx: string; height: number }>('/api/publish', { listing, sealed, bond: recipe.listing.bond ?? '0', settle_mode: recipe.listing.settle_mode ?? 'final', creator_copy: creatorCopy(recipe) });
}

/** a copy only the creator can reopen: sealed to a key derived from the creator's wallet signature (core/src/creator.ts) */
export function creatorCopy(recipe: Recipe) {
  const who = recipe.meta.creator;
  const { publicKeyHex } = creatorKeyFromSignature(demoWalletSign(who, creatorKeyMessage(who)));
  return seal(recipe, publicKeyHex, 'creator-copy');
}

export function freshImplicitAccount() {
  const kp = nacl.sign.keyPair();
  return { account: bytesToHex(kp.publicKey), secretKey: kp.secretKey };
}

/**
 * Quotes, client side: seal the inputs once (to the runner), then ask each recipe the buyer chose for a quote.
 * Each quote comes back sealed to this client's one-time reply key; it is opened and its runner signature is
 * verified here, against the exact message the contract will check, before anything is paid.
 */
export async function requestQuotes(recipes: string[], inputs: Record<string, unknown>, runner: { enc_pk_hex: string; signing_pk: string }, buyer: string, maxPrice?: bigint) {
  const { seal, jobHash, sealedHash, openQuote } = await import('../../core/src/index.js');
  const reply = nacl.box.keyPair();
  const salt = randomBytes(16).toString('hex');
  const job_hash = jobHash(inputs, salt);
  const sealed_job = seal({ inputs, salt, reply_to: bytesToHex(reply.publicKey) }, runner.enc_pk_hex, 'inputs');
  const inputsHash = sealedHash(sealed_job);
  const { contract_id } = await api<{ contract_id: string }>('/api/chain/config');
  // a recipe that is not listed (or refuses) comes back as a failed quote, so one bad entry doesn't sink the rest
  const quotes = await Promise.all(recipes.map((recipe_id) => api<{ quote: any }>('/api/quotes', { recipe_id, sealed_job, job_hash, buyer, ...(maxPrice !== undefined ? { max_price: maxPrice.toString() } : {}) })
    .then((r) => r.quote, (e: Error) => ({ recipe_id, ok: false, error: e.message, listing: { ticker: recipe_id } }))));
  for (const q of quotes) {
    if (!q.ok || !q.sealed_quote) continue;
    const o = openQuote(q.sealed_quote, reply.secretKey, { contractId: contract_id, recipeId: q.recipe_id, signingPk: runner.signing_pk, buyer, inputsHash, jobHash: job_hash });
    Object.assign(q, o, { details: o.details, ok: o.verified, error: o.problem });
  }
  return { quotes, sealed_job, job_hash, reply };
}

/** The quote object the contract checks, as sent in the run msg. */
export const signedQuote = (q: any) => ({ sealed_hash: q.sealed_hash, job_hash: q.job_hash, price: q.price, expected: q.expected, promised: q.promised, cover: q.cover, expires_ns: q.expires_ns, signature: q.signature });

/** An agent-style policy for picking a quote. */
export function pickQuote(quotes: any[], policy: { requirePrivacy?: 'confidential'; maxRisk?: 'low' | 'medium' | 'high'; sort: 'net' | 'value' | 'price' }) {
  const order = { low: 0, medium: 1, high: 2 } as Record<string, number>;
  const priceOf = (q: any) => Number(q.price ?? q.listing.price_per_run); // a signed quote locks its own price
  const net = (q: any) => Number(q.expected) - priceOf(q);
  return quotes
    .filter((q) => q.ok && (!policy.requirePrivacy || q.listing.privacy === policy.requirePrivacy) && (!policy.maxRisk || order[q.listing.risk] <= order[policy.maxRisk]))
    .sort((a, b) => (policy.sort === 'price' ? priceOf(a) - priceOf(b) : policy.sort === 'value' ? Number(b.expected) - Number(a.expected) : net(b) - net(a)))[0];
}

/**
 * Pays a chosen quote through the 1Click mock and follows the run's event stream to the end, approving wallet
 * requests (as the buyer's demo wallet). Returns the final event and every event seen, opened with the reply key.
 */
export async function payAndRun(job: { sealed_job: unknown; reply: { secretKey: Uint8Array } }, q: any, buyer: string, opts: { approve?: boolean; onEvent?: (e: any) => void } = {}) {
  const { open } = await import('../../core/src/index.js');
  const r = await api<{ run_id: string; run_token: string }>('/api/runs/quote', { recipe_id: q.recipe_id, buyer, pay_asset: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', refund_to: '0xB0b0000000000000000000000000000000000001', sealed_inputs: job.sealed_job, signed_quote: signedQuote(q) });
  await api(`/api/runs/${r.run_id}/pay?token=${r.run_token}`, {});
  const res = await fetch(`${BASE}/api/runs/${r.run_id}/events?token=${r.run_token}`);
  const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = '';
  const events: any[] = []; let final: any;
  for (let done = false; !done;) {
    const { value, done: end } = await reader.read(); if (end) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      let e = JSON.parse(buf.slice(6, i)); buf = buf.slice(i + 2);
      if (e.type === 'sealed') e = { ...e, ...open<{ type: string; data: any }>(e.data.envelope, job.reply.secretKey) };
      events.push(e); opts.onEvent?.(e);
      if (e.type === 'approval_required') await api(`/api/runs/${r.run_id}/approve?token=${r.run_token}`, { approved: opts.approve ?? true, transactions: e.data.transactions, sign_message: e.data.sign_message });
      if (e.type === 'completed' || e.type === 'failed') { final = e; done = true; break; }
    }
  }
  await reader.cancel().catch(() => {});
  return { run_id: r.run_id, final, events, result: events.find((e) => e.type === 'result')?.data };
}
