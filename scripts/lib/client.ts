/**
 * Client-side helpers shared by the CLI scripts (they act as the creator / buyer
 * clients — the same steps the browser performs).
 */
import { randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import { bytesToHex } from '@noble/hashes/utils.js';
import { seal, publicListing, validateRecipe, verifyRunnerAttestation, type Catalog, type Recipe, type RunnerAttestation } from '../../core/src/index.js';

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
  return api<{ sealed_hash: string; tx: string; height: number }>('/api/publish', { listing, sealed, ipo, bond: recipe.listing.bond ?? '0' });
}

export function freshImplicitAccount() {
  const kp = nacl.sign.keyPair();
  return { account: bytesToHex(kp.publicKey), secretKey: kp.secretKey };
}

/** Recipe intents, client side: seal the job once (to the runner), post it, collect competing quotes. */
export async function postJob(jobType: string, inputs: Record<string, unknown>, runnerEncPk: string, only?: string) {
  const { randomBytes } = await import('node:crypto');
  const { seal, jobHash, open } = await import('../../core/src/index.js');
  const reply = nacl.box.keyPair();
  const salt = randomBytes(16).toString('hex');
  const job_hash = jobHash(inputs, salt);
  const sealed_job = seal({ inputs, salt, reply_to: bytesToHex(reply.publicKey) }, runnerEncPk, 'inputs');
  const r = await api<{ quotes: any[]; open_demand: boolean }>('/api/jobs', { job_type: jobType, sealed_job, job_hash, ...(only ? { only } : {}) });
  for (const q of r.quotes) if (q.details) q.details = open(q.details, reply.secretKey);
  return { ...r, sealed_job, job_hash, reply };
}

/** An agent-style policy for picking a quote. */
export function pickQuote(quotes: any[], policy: { requirePrivacy?: 'confidential'; maxRisk?: 'low' | 'medium' | 'high'; sort: 'net' | 'value' | 'price' }) {
  const order = { low: 0, medium: 1, high: 2 } as Record<string, number>;
  const net = (q: any) => Number(q.expected) - Number(q.listing.price_per_run);
  return quotes
    .filter((q) => q.ok && (!policy.requirePrivacy || q.listing.privacy === policy.requirePrivacy) && (!policy.maxRisk || order[q.listing.risk] <= order[policy.maxRisk]))
    .sort((a, b) => (policy.sort === 'price' ? Number(a.listing.price_per_run) - Number(b.listing.price_per_run) : policy.sort === 'value' ? Number(b.expected) - Number(a.expected) : net(b) - net(a)))[0];
}
