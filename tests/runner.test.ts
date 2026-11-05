import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, mkdirSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { guardedFetch, validateInputs, parseRewrites, HANDLERS } from '../runner/src/executor.js';
import { computeCodehash } from '../core/src/codehash.js';
import type { Catalog, FormField } from '../core/src/srs.js';

const root = fileURLToPath(new URL('..', import.meta.url));

test('parts can only reach hosts they declare (capability guard)', async () => {
  const f = guardedFetch('filter.dust@1.0.0', [], new Map());
  await assert.rejects(() => f('https://evil.example/exfiltrate'), /capability violation/);
  const g = guardedFetch('x', ['net:api.fastnear.com'], new Map());
  await assert.rejects(() => g('https://cloud-api.near.ai/v1/models'), /capability violation/);
});

test('every catalog part has a runner implementation', () => {
  const cat = JSON.parse(readFileSync(join(root, 'standard/parts.json'), 'utf8')) as Catalog;
  for (const b of cat.parts) assert.ok(HANDLERS[b.id], `no handler for ${b.id}`);
});

test('buyer inputs are validated against the public form', () => {
  const form: FormField[] = [{ id: 'wallet', label: 'Wallet', type: 'near.account', required: true }, { id: 't', label: 'T', type: 'usd' }, { id: 'a', label: 'A', type: 'asset.id', options: ['x', 'y'] }];
  assert.deepEqual(validateInputs(form, { wallet: 'bob.testnet', t: 3, a: 'x' }), []);
  assert.equal(validateInputs(form, { wallet: 'Bad Account!', t: -1, a: 'z' }).length, 3);
  assert.deepEqual([...parseRewrites('a.com=http://x/y,b.com=http://z')], [['a.com', 'http://x/y'], ['b.com', 'http://z']]);
});

test('the marketplace server never touches plaintext recipes', () => {
  for (const f of readdirSync(join(root, 'server/src'))) {
    const src = readFileSync(join(root, 'server/src', f), 'utf8');
    assert.ok(!src.includes('seed/recipes'), `${f} must not read seed recipes`);
    assert.ok(!/import\s*\{[^}]*\bopen\b[^}]*\}\s*from\s*'[./]*core\/src\/(seal|index)/.test(src), `${f} must not import the decryption function`);
  }
});

test('code hash is stable across line endings and changes when code changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'srs-'));
  for (const d of ['runner/src', 'core/src', 'standard']) mkdirSync(join(dir, d), { recursive: true });
  cpSync(join(root, 'runner/src'), join(dir, 'runner/src'), { recursive: true });
  cpSync(join(root, 'core/src'), join(dir, 'core/src'), { recursive: true });
  cpSync(join(root, 'standard/parts.json'), join(dir, 'standard/parts.json'));
  cpSync(join(root, 'standard/jobs.json'), join(dir, 'standard/jobs.json'));
  const a = computeCodehash(dir).codehash;
  assert.equal(a, computeCodehash(root).codehash);
  const f = join(dir, 'runner/src/types.ts');
  writeFileSync(f, readFileSync(f, 'utf8').replace(/\n/g, '\r\n'));
  assert.equal(computeCodehash(dir).codehash, a, 'CRLF checkout gives the same hash');
  writeFileSync(f, readFileSync(f, 'utf8') + '\n// tampered');
  assert.notEqual(computeCodehash(dir).codehash, a);
});

test('AUDITED_CODEHASH is pinned to the current runner source (run `npm run pin-codehash` after reviewing changes)', () => {
  assert.equal(readFileSync(join(root, 'AUDITED_CODEHASH'), 'utf8').trim(), computeCodehash(root).codehash);
});

test('per-run resource limits: http calls, model calls, time (approval wait excluded) and output size', async () => {
  const { enforceLimits } = await import('../runner/src/limits.js');
  const m = (limits: object) => ({ id: 'x@1', limits: { max_ms: 200, max_http_calls: 2, max_model_calls: 1, max_output_bytes: 50, ...limits } }) as any;
  const ok = async () => new Response('{}');
  await assert.rejects(() => enforceLimits(m({}), ok, async (http) => { await http('https://a.b/1'); await http('https://a.b/2'); await http('https://a.b/3'); return {}; }), /max_http_calls/);
  await assert.rejects(() => enforceLimits(m({ max_http_calls: 9 }), ok, async (http) => { await http('https://cloud-api.near.ai/v1/chat/completions'); await http('https://cloud-api.near.ai/v1/chat/completions'); return {}; }), /max_model_calls/);
  await assert.rejects(() => enforceLimits(m({}), ok, () => new Promise((r) => setTimeout(() => r({}), 500))), /max_ms/);
  const waited = await enforceLimits(m({}), ok, async (_h, approval) => { await approval(() => new Promise((r) => setTimeout(r, 400))); return { done: true }; });
  assert.deepEqual(waited, { done: true }, 'time waiting for the wallet does not count');
  await assert.rejects(() => enforceLimits(m({}), ok, async () => ({ big: 'x'.repeat(100) })), /max_output_bytes/);
});

test('bonded runs credit what the buyer withheld after the re-check (verification/tla NoBondDrain)', async () => {
  const { measure, creditedDelivered } = await import('../runner/src/metrics.js');
  const job = { id: 'j', metric: { name: 'value_delivered', unit: 'payment-token' } } as any;
  const U = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
  const r = (status: string, out: string, min: string) => ({ status, assetOut: U, amountOutUnits: out, minAmountOutUnits: min });
  // honest: everything deposited, market delivers 9.9 against a 10.0 minimum
  let m = measure(job, [r('SUCCESS', '9900000', '10000000')], new Map());
  assert.equal(m.executed, 10000000n); assert.equal(creditedDelivered(m.delivered, 10000000n, m.executed), 9900000n, 'market shortfall stays visible to the bond');
  // attacker: re-check saw 10.0, then sent only part of one deposit (INCOMPLETE_DEPOSIT) and none of another
  m = measure(job, [r('INCOMPLETE_DEPOSIT', '0', '6000000'), r('SUCCESS', '3990000', '4000000')], new Map());
  assert.equal(m.executed, 4000000n);
  assert.equal(creditedDelivered(m.delivered, 10000000n, m.executed), 9990000n, 'withheld 6.0 counts as delivered: bond pays only the 0.01 market loss');
  // market failure on a full deposit is still insured
  m = measure(job, [r('REFUNDED', '0', '10000000')], new Map());
  assert.equal(creditedDelivered(m.delivered, 10000000n, m.executed), 0n);
});

test('durable store: content-addressed, integrity-checked, survives a restart', async () => {
  const { FileBlobStore, BlobCorrupted } = await import('../server/src/store.js');
  const { seal, sealedHash } = await import('../core/src/seal.js');
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'srs-store-'));
  const env = seal({ hello: 'world' }, 'ab'.repeat(32), 'recipe');
  const a = new FileBlobStore(dir);
  const h = a.put(env);
  assert.equal(h, sealedHash(env), 'the id is the on-chain hash');
  a.writeMeta('vault', { recipes: { X: { versions: [h], creator_copies: {} } } });
  const b = new FileBlobStore(dir); // "restarted"
  assert.deepEqual(b.get(h), env);
  assert.deepEqual(b.readMeta('vault', null), { recipes: { X: { versions: [h], creator_copies: {} } } });
  const p = join(dir, 'blobs', `${h}.json`);
  writeFileSync(p, readFileSync(p, 'utf8').replace(/"ct":"(.)/, (_m, c: string) => `"ct":"${c === 'A' ? 'B' : 'A'}`));
  assert.throws(() => b.get(h), BlobCorrupted, 'a tampered blob is refused');
});

test('NEAR Intents bundles: NEP-413 signatures, and the Verifier stand-in executes all intents or none', async () => {
  const { IntentsVerifierMock } = await import('../server/src/intents-verifier.js');
  const { World } = await import('../server/src/world.js');
  const { signNep413, verifyNep413 } = await import('../core/src/nep413.js');
  const { demoWalletKey } = await import('../core/src/creator.js');
  const { base64 } = await import('../core/src/seal.js');
  const { readFileSync } = await import('node:fs');
  const root = new URL('..', import.meta.url).pathname;
  const world = new World(`${root}fixtures/wallets.json`, `${root}fixtures/oneclick-tokens.json`);
  const tokens = JSON.parse(readFileSync(`${root}fixtures/oneclick-tokens.json`, 'utf8')).tokens;
  const V = new IntentsVerifierMock(world, tokens);
  const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
  const held = world.tokensOf('bob.testnet').filter((t: any) => BigInt(t.balance) > 0n && tokens.some((x: any) => x.assetId === `nep141:${t.contract_id}`) && `nep141:${t.contract_id}` !== USDC).slice(0, 2);
  assert.equal(held.length, 2);
  for (const h of held) V.deposit('bob.testnet', h.contract_id, BigInt(h.balance));
  const qs = held.map((h: any) => V.quote({ defuse_asset_identifier_in: `nep141:${h.contract_id}`, defuse_asset_identifier_out: USDC, exact_amount_in: h.balance })[0]);
  const total = qs.reduce((s: bigint, q: any) => s + BigInt(q.amount_out), 0n);
  const bundle = (out = total) => signNep413({ recipient: 'intents.near', nonce: base64.enc(new Uint8Array(32).fill(7)), message: JSON.stringify({ signer_id: 'bob.testnet', deadline: new Date(Date.now() + 60_000).toISOString(), intents: [
    ...qs.map((q: any) => ({ intent: 'token_diff', diff: { [q.defuse_asset_identifier_in]: `-${q.amount_in}`, [USDC]: q.amount_out } })),
    { intent: 'ft_withdraw', token: USDC.slice(7), receiver_id: 'fresh.testnet', amount: out.toString() }] }) }, demoWalletKey('bob.testnet').secretKey);
  const signed = bundle();
  assert.ok(verifyNep413(signed));
  assert.ok(!verifyNep413({ ...signed, payload: { ...signed.payload, message: signed.payload.message.replace('fresh', 'evil') } }), 'any change breaks the signature');
  const snapshot = JSON.stringify([...V.balances].map(([a, m]) => [a, [...m].map(([k, v]) => [k, String(v)])]));
  // one leg cannot be filled -> nothing at all changes
  V.failing.add(qs[1].defuse_asset_identifier_in);
  const bad = V.publish({ quote_hashes: qs.map((q: any) => q.quote_hash), signed_data: signed });
  assert.equal(V.status(bad.intent_hash).status, 'NOT_FOUND_OR_NOT_VALID');
  assert.equal(JSON.stringify([...V.balances].map(([a, m]) => [a, [...m].map(([k, v]) => [k, String(v)])])), snapshot, 'no partial execution');
  V.failing.clear();
  // withdrawing more than the swaps produce: rejected as a whole
  const greedy = V.publish({ quote_hashes: qs.map((q: any) => q.quote_hash), signed_data: bundle(total + 1n) });
  assert.match(V.status(greedy.intent_hash).reason ?? '', /insufficient/);
  // all legs fillable -> everything settles in one step, proceeds paid out
  const ok = V.publish({ quote_hashes: qs.map((q: any) => q.quote_hash), signed_data: signed });
  assert.equal(V.status(ok.intent_hash).status, 'SETTLED');
  assert.equal(world.tokensOf('fresh.testnet').find((t: any) => `nep141:${t.contract_id}` === USDC)?.balance, total.toString());
});
