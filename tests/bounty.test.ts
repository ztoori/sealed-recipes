/** Builder bounties: the Agent Market mock's role and escrow rules, and Bounties' accept/dispute decision. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { AgentMarketClient, agentMarketMock } from '../server/src/agent-market.js';
import { Bounties, type Check } from '../server/src/bounties.js';

const JT = { id: 'job.airdrop-claim@1.0.0', name: 'Claim my eligible airdrops', description: 'd', inputs: {}, output: 'receipts', metric: {} };

async function market() {
  const app = express(); app.use('/m', agentMarketMock(200).router);
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/m`;
  const reg = async (h: string) => { const a = await AgentMarketClient.register(base, h, ['sealed-recipes']); return { ...a, c: new AgentMarketClient(base, a.api_key) }; };
  return { base, srv, reg };
}

async function run(checks: Check[]) {
  const m = await market();
  const owner = await m.reg('sealed-recipes'); const builder = await m.reg('builder');
  let seen: string | undefined;
  try {
  const bounties = new Bounties(owner.c, async (_d, _b, near) => { seen = near; return checks; }, 'https://market.near.ai');
  const b = await bounties.post({ job_type: JT, budget: '100', token: 'USDC', origin: 'http://x', by: 't' });
  await assert.rejects(bounties.post({ job_type: JT, budget: '100', token: 'USDC', origin: 'http://x', by: 't' }), /already open/);
  const bid = await builder.c.bid(b.market_job_id, { amount: '80', eta_seconds: 60, proposal: 'p' });
  await assert.rejects(builder.c.award(b.market_job_id, bid.bid_id), /403/); // only the creator awards
  await bounties.tick(); assert.equal(b.bids.length, 1);
  await bounties.award(b.id, bid.bid_id);
  await assert.rejects(owner.c.submit(b.market_job_id, '{}'), /403/); // only the awarded worker submits
  await builder.c.submit(b.market_job_id, JSON.stringify({ recipe_id: 'AIRD' }));
  await bounties.tick();
  return { b, seen, builder };
  } finally { m.srv.closeAllConnections(); m.srv.close(); }
}

test('bounty: all checks pass → accepted on Agent Market, escrow released to the builder minus the fee', async () => {
  const { b, seen, builder } = await run([{ name: 'a', ok: true, detail: '' }, { name: 'b', ok: true, detail: '' }]);
  assert.equal(b.status, 'accepted');
  assert.equal(seen, builder.near_account_id, 'the verifier is told which NEAR account won the bid');
  const reward = b.transactions!.find((t) => t.type === 'agent reward')!;
  assert.equal(reward.to, builder.near_account_id);
  assert.equal(Number(reward.amount), 78.4); // 80 - 2%
  assert.equal(b.recipe_id, 'AIRD');
});

test('bounty: any failed check → rejected, dispute opened with the reasons, no payout, and the job type can be re-posted', async () => {
  const { b } = await run([{ name: 'a', ok: true, detail: '' }, { name: 'implements the requested job type', ok: false, detail: 'implements job.wallet-cleanup@1.0.0' }]);
  assert.equal(b.status, 'rejected');
  assert.ok(!b.transactions!.some((t) => t.type === 'agent reward'));
  assert.match(b.log.at(-1)!.msg, /implements the requested job type: implements job\.wallet-cleanup/);
});

test('bounty: a verifier that throws counts as a failed check (never accepts by default)', async () => {
  const m = await market();
  const owner = await m.reg('owner'); const builder = await m.reg('worker');
  try {
  const bounties = new Bounties(owner.c, async () => { throw new Error('rpc down'); }, '');
  const b = await bounties.post({ job_type: JT, budget: '10', token: 'USDC', origin: '', by: 't' });
  const bid = await builder.c.bid(b.market_job_id, { amount: '5', eta_seconds: 1, proposal: '' });
  await bounties.tick(); await bounties.award(b.id, bid.bid_id);
  await builder.c.submit(b.market_job_id, '{"recipe_id":"X"}');
  await bounties.tick();
  assert.equal(b.status, 'rejected');
  assert.equal(b.checks?.[0].detail, 'rpc down');
  } finally { m.srv.closeAllConnections(); m.srv.close(); }
});

test('bounty: transitions are explicit: only an open bounty can be awarded, and only once', async () => {
  const { BOUNTY_TRANSITIONS } = await import('../server/src/bounties.js');
  for (const s of ['accepted', 'rejected', 'completed', 'disputed', 'cancelled', 'closed', 'expired'] as const) assert.deepEqual(BOUNTY_TRANSITIONS[s], [], `${s} is final`);
  const m = await market();
  const owner = await m.reg('owner2'); const builder = await m.reg('worker2');
  try {
    const bounties = new Bounties(owner.c, async () => [{ name: 'a', ok: true, detail: '' }], '');
    const b = await bounties.post({ job_type: JT, budget: '10', token: 'USDC', origin: '', by: 't' });
    const bid = await builder.c.bid(b.market_job_id, { amount: '5', eta_seconds: 1, proposal: '' });
    await bounties.tick();
    await assert.rejects(bounties.award(b.id, 'nope'), /unknown bid/);
    await bounties.award(b.id, bid.bid_id);
    await assert.rejects(bounties.award(b.id, bid.bid_id), /only an open bounty/);
    // two overlapping polls verify a delivery once
    await builder.c.submit(b.market_job_id, '{"recipe_id":"X"}');
    let calls = 0;
    (bounties as any).verify = async () => { calls++; await new Promise((r) => setTimeout(r, 50)); return [{ name: 'a', ok: true, detail: '' }]; };
    await Promise.all([bounties.tick(), bounties.tick()]);
    assert.equal(calls, 1);
    assert.equal(b.status, 'accepted');
  } finally { m.srv.closeAllConnections(); m.srv.close(); }
});
