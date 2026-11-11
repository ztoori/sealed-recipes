import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OutboundGuard, safeToRepeat } from '../core/src/outbound.js';

/** a fake upstream: answers from a script of responses and records what it saw */
function upstream(script: (n: number, url: string, init?: RequestInit) => Response | Promise<Response> | 'network-error') {
  const seen: { url: string; at: number }[] = [];
  let inFlight = 0, maxInFlight = 0;
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const n = seen.length;
    seen.push({ url: String(input), at: Date.now() });
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const r = await script(n, String(input), init);
      if (r === 'network-error') throw new TypeError('fetch failed');
      return r;
    } finally { inFlight--; }
  }) as typeof fetch;
  return { fetchImpl, seen, max: () => maxInFlight };
}
const ok = (body = '{}') => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
const rpc = (method: string) => ({ method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }) });

test('outbound: a 429 pauses the host for Retry-After and the call is retried', async () => {
  const u = upstream((n) => n === 0 ? new Response('slow down', { status: 429, headers: { 'retry-after': '0.3' } }) : ok());
  const g = new OutboundGuard({ 'svc.test': { rps: 100, burst: 10 } }, { fetchImpl: u.fetchImpl });
  const t = Date.now();
  const r = await g.fetch('https://svc.test/v0/x');
  assert.equal(r.status, 200);
  assert.equal(u.seen.length, 2);
  assert.ok(u.seen[1].at - u.seen[0].at >= 250, 'waited out Retry-After before retrying');
  assert.equal(g.stats()['svc.test'].rate_limited_429, 1);
  assert.ok(Date.now() - t < 5000);
});

test('outbound: a transaction broadcast is never sent twice, even after a network error', async () => {
  const u = upstream(() => 'network-error');
  const g = new OutboundGuard({ 'rpc.test': { retries: 3 } }, { fetchImpl: u.fetchImpl });
  await assert.rejects(g.fetch('https://rpc.test/', rpc('broadcast_tx_commit')));
  assert.equal(u.seen.length, 1);
  assert.equal(safeToRepeat('POST', new URL('https://rpc.test/'), JSON.stringify({ jsonrpc: '2.0', method: 'send_tx' })), false);
});

test('outbound: a read (JSON-RPC query) is retried after a 503', async () => {
  const u = upstream((n) => n === 0 ? new Response('busy', { status: 503 }) : ok('{"result":1}'));
  const g = new OutboundGuard({ 'rpc.test': { retries: 2 } }, { fetchImpl: u.fetchImpl });
  const r = await g.fetch('https://rpc.test/', rpc('query'));
  assert.equal(r.status, 200);
  assert.equal(u.seen.length, 2);
});

test('outbound: a POST that moves funds is not retried after a 503', async () => {
  const u = upstream(() => new Response('busy', { status: 503 }));
  const g = new OutboundGuard({ 'svc.test': { retries: 3 } }, { fetchImpl: u.fetchImpl });
  const r = await g.fetch('https://svc.test/v0/deposit/submit', { method: 'POST', body: '{}' });
  assert.equal(r.status, 503);
  assert.equal(u.seen.length, 1);
});

test('outbound: GETs are cached, and identical GETs in flight share one request', async () => {
  const u = upstream(async () => { await new Promise((r) => setTimeout(r, 50)); return ok('{"v":1}'); });
  const g = new OutboundGuard({ 'api.test': { cacheTtlMs: 10_000 } }, { fetchImpl: u.fetchImpl });
  const both = await Promise.all([g.fetch('https://api.test/a'), g.fetch('https://api.test/a')]);
  for (const r of both) assert.deepEqual(await r.json(), { v: 1 });
  const third = await g.fetch('https://api.test/a');
  assert.deepEqual(await third.json(), { v: 1 });
  assert.equal(u.seen.length, 1);
  const s = g.stats()['api.test'];
  assert.equal(s.shared, 1);
  assert.equal(s.cached, 1);
});

test('outbound: no more calls in flight than the host allows', async () => {
  const u = upstream(async () => { await new Promise((r) => setTimeout(r, 80)); return ok(); });
  const g = new OutboundGuard({ 'svc.test': { concurrency: 2, rps: 1000, burst: 100 } }, { fetchImpl: u.fetchImpl });
  await Promise.all(Array.from({ length: 6 }, (_, i) => g.fetch(`https://svc.test/${i}`)));
  assert.equal(u.max(), 2);
});

test('outbound: requests are paced to the rate limit', async () => {
  const u = upstream(() => ok());
  const g = new OutboundGuard({ 'svc.test': { rps: 10, burst: 2, concurrency: 10 } }, { fetchImpl: u.fetchImpl });
  const t = Date.now();
  await Promise.all(Array.from({ length: 6 }, (_, i) => g.fetch(`https://svc.test/${i}`)));
  // 2 at once from the burst, then 4 more at 10 per second
  assert.ok(Date.now() - t >= 350, `took ${Date.now() - t} ms`);
});

test('outbound: a call that would wait too long fails fast instead of piling up', async () => {
  const u = upstream(async () => { await new Promise((r) => setTimeout(r, 400)); return ok(); });
  const g = new OutboundGuard({ 'svc.test': { concurrency: 1, maxWaitMs: 100, rps: 100, burst: 10 } }, { fetchImpl: u.fetchImpl });
  const first = g.fetch('https://svc.test/1');
  await assert.rejects(g.fetch('https://svc.test/2'), /too many requests queued/);
  assert.equal((await first).status, 200);
});

test('outbound: calls to this machine (the demo mocks) are not limited', async () => {
  const u = upstream(() => ok());
  const g = new OutboundGuard({ '*': { rps: 0.001, burst: 1, concurrency: 1 } }, { fetchImpl: u.fetchImpl });
  await Promise.all(Array.from({ length: 5 }, () => g.fetch('http://127.0.0.1:8080/mock/fastnear/x')));
  assert.equal(u.seen.length, 5);
  assert.deepEqual(g.stats(), {});
});
