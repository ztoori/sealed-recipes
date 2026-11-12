import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditReport } from '../runner/src/parts/report-audit-v1-1-0.js';

const ctx = { log: () => {}, params: {} } as never;
const run = async (account: string, keys: unknown[]) => ((await auditReport({ account, keys, holdings: [{ assetId: 'nep141:usdc', symbol: 'USDC', amount: '1', decimals: 6, usd: 100 }], flags: [] }, ctx)) as { report: any }).report;

test('audit: keys that call the account\'s own contract (multisig, lockup) are kept, never "delete"', async () => {
  // like foundation.near on mainnet: no full-access key, function-call keys on its own contract
  const keys = [1, 2, 3].map((i) => ({ public_key: `ed25519:key${i}`, kind: 'function-call', receiver: 'org.near', action: 'revoke', reason: 'unlimited allowance for an unvetted app (org.near)' }));
  const r = await run('org.near', keys);
  assert.equal(r.counts.contract_keys, 3);
  assert.equal(r.counts.revoke, 0);
  assert.ok(!r.fixes.some((f: any) => f.action === 'delete app key'));
  assert.equal(r.severity, 'low');
  assert.match(r.items.find((i: any) => i.label === 'Full-access keys').detail, /controlled by its own contract/);
});

test('audit: app keys for other contracts are still judged by the rules', async () => {
  const r = await run('alice.near', [
    { public_key: 'ed25519:full1', kind: 'full', action: 'keep' },
    { public_key: 'ed25519:app1', kind: 'function-call', receiver: 'gone-app.near', action: 'revoke', reason: 'gone-app.near no longer exists' },
  ]);
  assert.equal(r.counts.revoke, 1);
  assert.equal(r.severity, 'medium');
  assert.ok(r.fixes.some((f: any) => f.action === 'delete app key' && f.app === 'gone-app.near'));
});

test('audit: more than one full-access key puts the whole value at risk', async () => {
  const r = await run('bob.near', [
    { public_key: 'ed25519:f1', kind: 'full', action: 'review', reason: 'one of 2 full-access keys' },
    { public_key: 'ed25519:f2', kind: 'full', action: 'review', reason: 'one of 2 full-access keys' },
  ]);
  assert.equal(r.severity, 'high');
  assert.match(r.items.find((i: any) => i.label === 'Value at risk').detail, /\$100/);
});
