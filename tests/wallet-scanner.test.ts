import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walletScanner } from '../runner/src/parts/near-wallet-scanner.js';
import { compilePart, runSandboxed, stageCompiled } from '../runner/src/sandbox.js';
import { readFileSync } from 'node:fs';

// near.wallet-scanner 1.1.0 must answer for any account within its manifest limits (8 s, 40 HTTP calls, 64 kB)
const LIMITS = { ms: 8000, calls: 40, bytes: 64000 };
const listed = Array.from({ length: 120 }, (_, i) => ({ assetId: `nep141:tok${i}.near`, symbol: `T${i}`, decimals: 18, price: String(1 + i), blockchain: 'near' }));
const json = (v: unknown) => new Response(JSON.stringify(v));

function world(nTokens: number, rpcDelayMs: number, opts: { missing?: boolean; hang?: boolean } = {}) {
  let calls = 0;
  const http = async (url: string, init?: RequestInit) => {
    calls++;
    if (url.includes('/v1/account/')) return json({ tokens: Array.from({ length: nTokens }, (_, i) => ({ contract_id: `tok${i}.near`, balance: i % 50 === 7 ? '' : i % 3 === 0 ? '0' : '1000000000000000000', last_update_block_height: i })) });
    if (url.includes('/v0/tokens')) return json(listed);
    const b = JSON.parse(String(init?.body));
    await new Promise((r) => setTimeout(r, opts.hang ? 9_000 : rpcDelayMs));
    if (b.params.request_type === 'view_account') return json(opts.missing ? { error: { cause: { name: 'UNKNOWN_ACCOUNT' } } } : { result: { amount: '1' } });
    return json({ result: { result: Array.from(new TextEncoder().encode(JSON.stringify({ symbol: 'X', name: b.params.account_id, decimals: 6 }))) } });
  };
  const ctx = { http, log: () => {}, params: {}, mode: 'quote', endpoints: { fastnear: 'https://api.fastnear.com', oneclick: 'https://1click.chaindefuser.com', rpc: 'https://rpc.mainnet.fastnear.com' } } as never;
  return { ctx, calls: () => calls };
}
const scan = async (account: string, w: ReturnType<typeof world>) => {
  const t = Date.now();
  const out = (await walletScanner({ account }, w.ctx)) as { holdings: any[]; coverage: any };
  return { ...out, ms: Date.now() - t, calls: w.calls(), bytes: JSON.stringify(out).length };
};

test('scanner 1.1: an account with ~1,800 tokens (a DEX) answers inside the limits and says what it left out', async () => {
  const r = await scan('v2.ref-finance.near', world(1800, 400));
  assert.ok(r.ms < LIMITS.ms - 1500, `took ${r.ms} ms`);
  assert.ok(r.calls <= LIMITS.calls, `${r.calls} HTTP calls`);
  assert.ok(r.bytes < LIMITS.bytes, `${r.bytes} bytes`);
  assert.equal(r.coverage.complete, false);
  assert.equal(r.coverage.tokens_total, 1176, 'zero and unreadable balances are not holdings');
  assert.equal(r.coverage.unreadable, 36);
  assert.equal(r.coverage.shown, r.holdings.length);
  assert.match(r.coverage.title, /^Showing \d+ of 1176 tokens/);
  assert.ok(r.holdings[0].listed && r.holdings[0].usd >= r.holdings[1].usd, 'priced tokens first, by value');
});

test('scanner 1.1: a stalled RPC cannot push the part past max_ms', async () => {
  const r = await scan('treasury.near', world(400, 0, { hang: true }));
  assert.ok(r.ms < LIMITS.ms - 1000, `took ${r.ms} ms`);
  assert.ok(r.holdings.every((h) => h.listed), 'unpriced tokens without metadata are left out, not guessed');
  assert.ok(r.coverage.metadata_skipped > 0);
});

test('scanner 1.1: small wallets are complete and need two calls', async () => {
  const r = await scan('alice.near', world(5, 50));
  assert.equal(r.calls, 2);
  assert.equal(r.coverage.complete, true);
  assert.equal(r.holdings.length, 3);
});

test('scanner 1.1: every account id form NEAR uses: named, sub-account, 64-hex implicit, 0x (ETH) implicit, upper case typed', async () => {
  for (const a of ['bob.near', 'app.bob.near', 'ab'.repeat(32), '0x' + 'ab'.repeat(20), 'Bob.NEAR']) {
    const r = await scan(a, world(3, 1));
    assert.equal(r.coverage.account, a.toLowerCase());
    assert.equal(r.holdings.length, 2, a);
  }
});

test('scanner 1.1: an empty account is a clean empty result; a missing one fails with a plain message', async () => {
  const empty = await scan('empty.near', world(0, 1));
  assert.deepEqual(empty.holdings, []);
  assert.equal(empty.coverage.account_found, true);
  await assert.rejects(scan('nobody.testnet', world(0, 1, { missing: true })), /does not exist on this network \(this scanner reads NEAR mainnet/);
  await assert.rejects(scan('Bad Account!', world(0, 1)), /"Bad Account!" is not a valid NEAR account id/);
});

test('sandbox: an open part can read HTTP responses (no WebAssembly-backed Response in the child)', async () => {
  const file = stageCompiled(await compilePart(readFileSync(new URL('../runner/src/parts/near-wallet-scanner.ts', import.meta.url), 'utf8')));
  const w = world(40, 1);
  const out = await runSandboxed(
    { file, exportName: 'walletScanner', inputs: { account: 'alice.near' }, maxMs: 8000, ctx: { nodeId: 'scan', manifest: { id: 'near.wallet-scanner@1.1.0' } as never, params: {}, mode: 'quote', endpoints: (w.ctx as any).endpoints } },
    { http: (u: string, i?: RequestInit) => (w.ctx as any).http(u, i), requestApproval: async () => ({ approved: false, txHashes: [] }), saveState: async () => {}, log: () => {}, wait: async () => {} },
  ) as { holdings: unknown[]; coverage: { complete: boolean } };
  assert.equal(out.coverage.complete, true);
  assert.equal(out.holdings.length, 25, "40 tokens: 14 zero balances, 1 unreadable");
});
