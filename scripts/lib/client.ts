/**
 * Client-side helpers shared by the CLI scripts (they act as the creator / buyer
 * clients — the same steps the browser performs).
 */
import { randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import { bytesToHex } from '@noble/hashes/utils.js';
import bs58 from 'bs58';
import { seal, publicListing, validateRecipe, verifyRunnerAttestation, creatorKeyFromSignature, creatorKeyMessage, demoWalletSign, base64, hashObject, type Catalog, type Recipe, type RunnerAttestation } from '../../core/src/index.js';

export const BASE = process.env.SRS_URL ?? 'http://127.0.0.1:8080';
/** SRS_COOKIE: a demo-gateway session cookie (e.g. `srs_sb=…`), so the CLI story can run inside one visitor's
 *  sandbox behind scripts/gateway.mjs (used by scripts/loadtest.mjs). Sent only to BASE. */
if (process.env.SRS_COOKIE) {
  const cookie = process.env.SRS_COOKIE, plain = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(BASE)) return plain(input, init);
    const headers = new Headers(init?.headers);
    headers.set('cookie', cookie);
    if (process.env.SRS_CLIENT_IP) headers.set('cf-connecting-ip', process.env.SRS_CLIENT_IP);
    return plain(input, { ...init, headers });
  }) as typeof fetch;
}

export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(BASE + path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${path} → ${r.status} ${t.slice(0, 300)}`);
  // a proxy or bot check in front of the marketplace answers with a web page, not JSON: say so plainly
  try { return JSON.parse(t) as T; } catch { throw new Error(`${BASE}${path} → ${r.status} ${r.headers.get('content-type') ?? ''}, not JSON (a proxy or bot check in front of the marketplace?): ${t.slice(0, 160).replace(/\s+/g, ' ')}`); }
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
/** `oneAtATime`: ask each recipe after the previous one answered. Every dry run shares the runner's per-host limits on
 *  outbound calls (core/src/outbound.ts), and a part's max_ms counts time spent waiting there, so recipes asked at the
 *  same time can push each other's parts over their limits. */
export async function requestQuotes(recipes: string[], inputs: Record<string, unknown>, runner: { enc_pk_hex: string; signing_pk: string }, buyer: string, maxPrice?: bigint, opts: { oneAtATime?: boolean } = {}) {
  const { seal, open, jobHash, sealedHash, openQuote } = await import('../../core/src/index.js');
  const reply = nacl.box.keyPair();
  const salt = randomBytes(16).toString('hex');
  const job_hash = jobHash(inputs, salt);
  const sealed_job = seal({ inputs, salt, reply_to: bytesToHex(reply.publicKey) }, runner.enc_pk_hex, 'inputs');
  const inputsHash = sealedHash(sealed_job);
  const { contract_id } = await api<{ contract_id: string }>('/api/chain/config');
  // a recipe that is not listed (or refuses) comes back as a failed quote, so one bad entry doesn't sink the rest
  const ask = (recipe_id: string) => api<{ quote: any }>('/api/quotes', { recipe_id, sealed_job, job_hash, buyer, ...(maxPrice !== undefined ? { max_price: maxPrice.toString() } : {}) })
    .then((r) => r.quote, (e: Error) => ({ recipe_id, ok: false, error: e.message, listing: { ticker: recipe_id } }));
  const quotes: any[] = [];
  if (opts.oneAtATime) for (const r of recipes) quotes.push(await ask(r));
  else quotes.push(...await Promise.all(recipes.map(ask)));
  for (const q of quotes) {
    // a failed dry run's detail may contain the inputs, so the runner seals it to this client
    if (!q.ok && q.sealed_error) { try { q.error = open<{ error: string }>(q.sealed_error, reply.secretKey).error; } catch { /* keep the generic text */ } continue; }
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

/**
 * What a buyer can check after a run, on its own: the runner's report (the `signed` event) is signed by the runner key
 * registered on-chain, is for this contract, run and recipe with outcome ok, and its output_hash commits to the sealed
 * result. The salt in that hash reaches only the buyer (SRS-1 §6), so only the buyer can make this last check.
 * Report message: srs-run-v3|contract|run|recipe|outcome|output_hash|delivered|parts (core/src/ledger.ts).
 */
export function checkSignedReport(a: { signed?: { message: string; signature: string }; result: { salt: string; output: unknown }; contractId: string; runId: string; recipeId: string; signingPk: string }) {
  const [version, contractId, runId, recipeId, outcome, outputHash, delivered = '0'] = a.signed?.message.split('|') ?? [];
  let sigOk = false;
  try { sigOk = !!a.signed && nacl.sign.detached.verify(new TextEncoder().encode(a.signed.message), base64.dec(a.signed.signature), bs58.decode(a.signingPk.replace(/^ed25519:/, ''))); } catch { sigOk = false; }
  const checks: [string, boolean][] = [
    ['report signed by the runner key registered on-chain', sigOk],
    ['report is for this contract, run and recipe, outcome ok', version === 'srs-run-v3' && contractId === a.contractId && runId === a.runId && recipeId === a.recipeId && outcome === 'ok'],
    ['sealed result matches the signed output_hash', !!outputHash && outputHash === hashObject({ run_id: a.runId, salt: a.result.salt, output: a.result.output })],
  ];
  return { checks, delivered, ok: checks.every(([, ok]) => ok) };
}
