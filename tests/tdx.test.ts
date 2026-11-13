/**
 * The browser's Intel DCAP check (web/src/tdx.ts) on a real Intel TDX quote and collateral (fixtures/tdx, from dcap-qvl).
 * The same code runs in the page; here it gets the collateral directly instead of from /api/tee/collateral.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

(globalThis as { location?: unknown }).location ??= { href: 'http://localhost/' }; // web/src/api.ts reads the page location
const { checkWithIntel } = await import('../web/src/tdx.js');
const dir = new URL('../fixtures/tdx/', import.meta.url);
const quote = readFileSync(new URL('tdx_quote', dir)).toString('hex');
const collateral = JSON.parse(readFileSync(new URL('tdx_quote_collateral.json', dir), 'utf8'));
const NOW = 1751000000; // when the sample collateral is valid

test('tdx: a genuine Intel TDX quote verifies, and returns the REPORTDATA Intel signed', async () => {
  const r = await checkWithIntel(quote, undefined, { collateral, nowSecs: NOW });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.status, 'UpToDate');
  assert.match(r.reportData ?? '', /^[0-9a-f]{128}$/);
  assert.equal((await checkWithIntel(quote, r.reportData!.slice(0, 64), { collateral, nowSecs: NOW })).ok, true);
});

test('tdx: a quote whose REPORTDATA does not carry the runner keys and nonce is refused', async () => {
  const r = await checkWithIntel(quote, 'ab'.repeat(32), { collateral, nowSecs: NOW });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /REPORTDATA/);
});

test('tdx: a tampered quote is refused', async () => {
  const bad = quote.slice(0, 1200) + (quote[1200] === '0' ? '1' : '0') + quote.slice(1201);
  const r = await checkWithIntel(bad, undefined, { collateral, nowSecs: NOW });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /signature/i);
});

test('tdx: expired collateral is refused (the marketplace cannot replay old collateral)', async () => {
  const r = await checkWithIntel(quote, undefined, { collateral, nowSecs: NOW + 400 * 86400 });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /expired/i);
});
