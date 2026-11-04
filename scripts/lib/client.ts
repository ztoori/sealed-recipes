/**
 * Client-side helpers shared by the CLI scripts (they act as the creator / buyer
 * clients — the same steps the browser performs).
 */
import { randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import { bytesToHex } from '@noble/hashes/utils.js';
import { seal, publicListing, validateRecipe, verifyRunnerAttestation, creatorKeyFromSignature, creatorKeyMessage, demoWalletSign, type Catalog, type Recipe, type RunnerAttestation } from '../../core/src/index.js';

export const BASE = process.env.FRS_URL ?? 'http://127.0.0.1:8080';

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

export async function publish(recipe: Recipe, catalog: Catalog, encPkHex: string, ipo: { price: number; float_pct: number }) {
  const v = validateRecipe(recipe, catalog);
  if (!v.ok) throw new Error('invalid recipe: ' + JSON.stringify(v.diagnostics));
  const listing = publicListing(recipe, catalog);
  const sealed = seal(recipe, encPkHex, 'recipe');
  return api<{ sealed_hash: string; tx: string; height: number }>('/api/publish', { listing, sealed, ipo, bond: recipe.listing.bond ?? '0', settle_mode: recipe.listing.settle_mode ?? 'final', creator_copy: creatorCopy(recipe) });
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
 * Recipe intents, client side: seal the job once (to the runner), post it, collect competing quotes.
 * Each quote comes back sealed to this client's one-time reply key; it is opened and its runner signature is
 * verified here, against the exact message the contract will check, before anything is paid.
 */
export async function postJob(jobType: string, inputs: Record<string, unknown>, runner: { enc_pk_hex: string; signing_pk: string }, buyer: string, only?: string) {
  const { seal, jobHash, sealedHash, openQuote } = await import('../../core/src/index.js');
  const reply = nacl.box.keyPair();
  const salt = randomBytes(16).toString('hex');
  const job_hash = jobHash(inputs, salt);
  const sealed_job = seal({ inputs, salt, reply_to: bytesToHex(reply.publicKey) }, runner.enc_pk_hex, 'inputs');
  const inputsHash = sealedHash(sealed_job);
  const { contract_id } = await api<{ contract_id: string }>('/api/chain/config');
  const r = await api<{ quotes: any[]; open_demand: boolean }>('/api/jobs', { job_type: jobType, sealed_job, job_hash, buyer, ...(only ? { only } : {}) });
  for (const q of r.quotes) {
    if (!q.ok || !q.sealed_quote) continue;
    const o = openQuote(q.sealed_quote, reply.secretKey, { contractId: contract_id, recipeId: q.recipe_id, signingPk: runner.signing_pk, buyer, inputsHash, jobHash: job_hash });
    Object.assign(q, o, { details: o.details, ok: o.verified, error: o.problem });
  }
  return { ...r, sealed_job, job_hash, reply };
}

/** The quote object the contract checks, as sent in the run msg. */
export const signedQuote = (q: any) => ({ sealed_hash: q.sealed_hash, job_hash: q.job_hash, expected: q.expected, promised: q.promised, cover: q.cover, expires_ns: q.expires_ns, signature: q.signature });

/** An agent-style policy for picking a quote. */
export function pickQuote(quotes: any[], policy: { requirePrivacy?: 'confidential'; maxRisk?: 'low' | 'medium' | 'high'; sort: 'net' | 'value' | 'price' }) {
  const order = { low: 0, medium: 1, high: 2 } as Record<string, number>;
  const net = (q: any) => Number(q.expected) - Number(q.listing.price_per_run);
  return quotes
    .filter((q) => q.ok && (!policy.requirePrivacy || q.listing.privacy === policy.requirePrivacy) && (!policy.maxRisk || order[q.listing.risk] <= order[policy.maxRisk]))
    .sort((a, b) => (policy.sort === 'price' ? Number(a.listing.price_per_run) - Number(b.listing.price_per_run) : policy.sort === 'value' ? Number(b.expected) - Number(a.expected) : net(b) - net(a)))[0];
}
