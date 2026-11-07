/**
 * NEAR AI Agent Market (market.near.ai): a small REST client, and an offline mock of the same API for the demo.
 *
 * Used for builder bounties: when buyers post a job type no recipe serves, the marketplace posts a paid job on
 * Agent Market asking builders to create the recipe, awards a bid, verifies the delivery against the chain and a
 * live dry run, and only then accepts it (which releases Agent Market's escrow to the builder).
 *
 * Endpoints follow Agent Market's published skill.md (https://market.near.ai/skill.md):
 *   POST /v1/agents/register {handle, tags}                 -> {agent_id, api_key, near_account_id, handle}
 *   POST /v1/jobs {title, description, tags, budget_amount, budget_token, deadline_seconds} -> {job_id, status}
 *   GET  /v1/jobs?status=&tags=                             -> job[]
 *   GET  /v1/jobs/{job_id}
 *   POST /v1/jobs/{job_id}/bids {amount, eta_seconds, proposal}
 *   POST /v1/jobs/{job_id}/award {bid_id}                    (funds escrow, starts work)
 *   POST /v1/jobs/{job_id}/submit {deliverable}
 *   POST /v1/jobs/{job_id}/accept                            (releases escrow to the worker)
 *   POST /v1/jobs/{job_id}/dispute
 *   GET  /v1/platform/fee-schedule
 * Not specified there, so assumed here (check against https://market.near.ai/openapi.json before going live):
 *   GET  /v1/jobs/{job_id}/bids -> bid[] (bid listing is only "referenced in the flow doc"), the dispute body
 *   {reason}, and the exact job/bid field names beyond those listed above.
 */
import express, { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';

export type JobStatus = 'open' | 'in_progress' | 'submitted' | 'completed' | 'closed' | 'cancelled' | 'disputed';
export interface MarketBid { bid_id: string; job_id: string; agent_id: string; handle: string; near_account_id?: string; amount: string; eta_seconds: number; proposal: string; status: 'pending' | 'accepted' | 'rejected' }
export interface MarketJob {
  job_id: string; title: string; description: string; tags: string[]; budget_amount: string; budget_token: string;
  status: JobStatus; creator_agent_id: string; created_at: string; deadline_seconds: number;
  worker_agent_id?: string; awarded_bid_id?: string; deliverable?: string; deliverable_hash?: string;
  transactions?: { type: string; to: string; amount: string; token: string; tx: string; at: string }[];
}

export class AgentMarketClient {
  constructor(readonly base: string, private apiKey: string) {}
  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(this.base.replace(/\/$/, '') + path, {
      method, headers: { authorization: `Bearer ${this.apiKey}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`Agent Market ${method} ${path} → ${r.status} ${t.slice(0, 300)}`);
    return (t ? JSON.parse(t) : {}) as T;
  }
  static async register(base: string, handle: string, tags: string[]) {
    const r = await fetch(base.replace(/\/$/, '') + '/v1/agents/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, tags }) });
    if (!r.ok) throw new Error(`Agent Market register → ${r.status} ${await r.text()}`);
    return (await r.json()) as { agent_id: string; api_key: string; near_account_id: string; handle: string };
  }
  createJob(b: { title: string; description: string; tags: string[]; budget_amount: string; budget_token: 'NEAR' | 'USDC' | 'USD'; deadline_seconds?: number }) { return this.call<MarketJob>('POST', '/v1/jobs', b); }
  listJobs(q: { status?: string; tags?: string[] } = {}) {
    const p = new URLSearchParams(); if (q.status) p.set('status', q.status); if (q.tags?.length) p.set('tags', q.tags.join(','));
    return this.call<MarketJob[] | { data: MarketJob[] }>('GET', `/v1/jobs?${p}`).then((r) => (Array.isArray(r) ? r : r.data));
  }
  getJob(id: string) { return this.call<MarketJob>('GET', `/v1/jobs/${id}`); }
  bids(id: string) { return this.call<MarketBid[]>('GET', `/v1/jobs/${id}/bids`); }
  bid(id: string, b: { amount: string; eta_seconds: number; proposal: string }) { return this.call<MarketBid>('POST', `/v1/jobs/${id}/bids`, b); }
  award(id: string, bid_id: string) { return this.call<MarketJob>('POST', `/v1/jobs/${id}/award`, { bid_id }); }
  submit(id: string, deliverable: string) { return this.call<MarketJob>('POST', `/v1/jobs/${id}/submit`, { deliverable }); }
  accept(id: string) { return this.call<MarketJob>('POST', `/v1/jobs/${id}/accept`); }
  dispute(id: string, reason: string) { return this.call<MarketJob>('POST', `/v1/jobs/${id}/dispute`, { reason }); }
}

/**
 * Offline mock of the endpoints above, with escrow bookkeeping, for the local demo and tests. It enforces the
 * roles the real API does (only the creator awards and accepts, only the awarded worker submits) and keeps a
 * transaction log shaped like the one Agent Market shows on job pages. Nothing here touches a real network.
 */
export function agentMarketMock(feeBps = 200): { router: Router; jobs: Map<string, MarketJob> } {
  const r = Router();
  r.use(express.json());
  const agents = new Map<string, { agent_id: string; handle: string; near_account_id: string; tags: string[] }>();
  const keys = new Map<string, string>(); // api_key -> agent_id
  const jobs = new Map<string, MarketJob>();
  const bids = new Map<string, MarketBid[]>();
  const tx = () => randomBytes(16).toString('hex');
  const now = () => new Date().toISOString();
  const who = (req: express.Request) => keys.get(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
  const auth = (req: express.Request, res: express.Response) => { const a = who(req); if (!a) res.status(401).json({ error: 'unauthorized', details: 'Bearer api_key required' }); return a; };
  const job = (req: express.Request, res: express.Response) => { const j = jobs.get(String(req.params.id)); if (!j) res.status(404).json({ error: 'not_found' }); return j; };

  r.post('/v1/agents/register', (req, res) => {
    const handle = String(req.body?.handle ?? '');
    if (!/^[a-z0-9_-]{3,32}$/.test(handle)) { res.status(400).json({ error: 'invalid_handle' }); return; }
    if ([...agents.values()].some((a) => a.handle === handle)) { res.status(409).json({ error: 'handle_taken' }); return; }
    const a = { agent_id: `ag_${randomBytes(6).toString('hex')}`, handle, near_account_id: `${handle}.testnet`, tags: (req.body?.tags ?? []).slice(0, 10) };
    const api_key = `sk_demo_${randomBytes(12).toString('hex')}`;
    agents.set(a.agent_id, a); keys.set(api_key, a.agent_id);
    res.json({ ...a, api_key });
  });
  r.get('/v1/platform/fee-schedule', (_, res) => res.json({ marketplace_fee_bps: feeBps, minimum_job_creation_balance: '0', note: 'demo mock' }));
  r.post('/v1/jobs', (req, res) => {
    const a = auth(req, res); if (!a) return;
    const b = req.body ?? {};
    if (String(b.title ?? '').length < 10 || String(b.title).length > 200) { res.status(400).json({ error: 'invalid_title', details: '10-200 chars' }); return; }
    if (String(b.description ?? '').length < 50) { res.status(400).json({ error: 'invalid_description', details: '50-50000 chars' }); return; }
    if (!['NEAR', 'USDC', 'USD'].includes(b.budget_token) || !(Number(b.budget_amount) > 0)) { res.status(400).json({ error: 'invalid_budget' }); return; }
    const j: MarketJob = { job_id: randomBytes(8).toString('hex'), title: b.title, description: b.description, tags: (b.tags ?? []).slice(0, 10), budget_amount: String(b.budget_amount), budget_token: b.budget_token,
      status: 'open', creator_agent_id: a, created_at: now(), deadline_seconds: Number(b.deadline_seconds ?? 86400), transactions: [] };
    jobs.set(j.job_id, j); bids.set(j.job_id, []);
    res.json(j);
  });
  r.get('/v1/jobs', (req, res) => {
    if (!auth(req, res)) return;
    const tags = String(req.query.tags ?? '').split(',').filter(Boolean);
    res.json([...jobs.values()].filter((j) => (!req.query.status || j.status === req.query.status) && tags.every((t) => j.tags.includes(t))));
  });
  r.get('/v1/jobs/:id', (req, res) => { if (!auth(req, res)) return; const j = job(req, res); if (j) res.json(j); });
  r.get('/v1/jobs/:id/bids', (req, res) => {
    const a = auth(req, res); if (!a) return; const j = job(req, res); if (!j) return;
    res.json((bids.get(j.job_id) ?? []).filter((b) => j.creator_agent_id === a || b.agent_id === a)); // proposals are visible only to the creator
  });
  r.post('/v1/jobs/:id/bids', (req, res) => {
    const a = auth(req, res); if (!a) return; const j = job(req, res); if (!j) return;
    if (j.status !== 'open') { res.status(409).json({ error: 'job_not_open' }); return; }
    if (j.creator_agent_id === a) { res.status(403).json({ error: 'cannot_bid_on_own_job' }); return; }
    const ag = agents.get(a)!;
    const b: MarketBid = { bid_id: randomBytes(6).toString('hex'), job_id: j.job_id, agent_id: a, handle: ag.handle, near_account_id: ag.near_account_id, amount: String(req.body?.amount), eta_seconds: Number(req.body?.eta_seconds ?? 3600), proposal: String(req.body?.proposal ?? ''), status: 'pending' };
    bids.get(j.job_id)!.push(b); res.json(b);
  });
  r.post('/v1/jobs/:id/award', (req, res) => {
    const a = auth(req, res); if (!a) return; const j = job(req, res); if (!j) return;
    if (j.creator_agent_id !== a) { res.status(403).json({ error: 'creator_only' }); return; }
    if (j.status !== 'open') { res.status(409).json({ error: 'job_not_open' }); return; }
    const list = bids.get(j.job_id)!; const b = list.find((x) => x.bid_id === req.body?.bid_id);
    if (!b) { res.status(404).json({ error: 'bid_not_found' }); return; }
    for (const x of list) x.status = x === b ? 'accepted' : 'rejected';
    Object.assign(j, { status: 'in_progress', worker_agent_id: b.agent_id, awarded_bid_id: b.bid_id });
    j.transactions!.push({ type: 'secure deposit', to: 'escrow.ai.near', amount: b.amount, token: j.budget_token, tx: tx(), at: now() });
    res.json(j);
  });
  r.post('/v1/jobs/:id/submit', (req, res) => {
    const a = auth(req, res); if (!a) return; const j = job(req, res); if (!j) return;
    if (j.worker_agent_id !== a) { res.status(403).json({ error: 'worker_only' }); return; }
    if (j.status !== 'in_progress') { res.status(409).json({ error: 'not_in_progress' }); return; }
    const d = String(req.body?.deliverable ?? '');
    Object.assign(j, { status: 'submitted', deliverable: d, deliverable_hash: createHash('sha256').update(d).digest('hex') });
    res.json(j);
  });
  r.post('/v1/jobs/:id/accept', (req, res) => {
    const a = auth(req, res); if (!a) return; const j = job(req, res); if (!j) return;
    if (j.creator_agent_id !== a) { res.status(403).json({ error: 'creator_only' }); return; }
    if (j.status !== 'submitted') { res.status(409).json({ error: 'not_submitted' }); return; }
    const b = bids.get(j.job_id)!.find((x) => x.bid_id === j.awarded_bid_id)!;
    const fee = (Number(b.amount) * feeBps) / 10000;
    j.status = 'completed';
    j.transactions!.push({ type: 'agent reward', to: agents.get(b.agent_id)!.near_account_id, amount: (Number(b.amount) - fee).toFixed(6), token: j.budget_token, tx: tx(), at: now() });
    j.transactions!.push({ type: 'marketplace fee', to: 'treasury.ai.near', amount: fee.toFixed(6), token: j.budget_token, tx: tx(), at: now() });
    res.json(j);
  });
  r.post('/v1/jobs/:id/dispute', (req, res) => {
    const a = auth(req, res); if (!a) return; const j = job(req, res); if (!j) return;
    if (j.creator_agent_id !== a && j.worker_agent_id !== a) { res.status(403).json({ error: 'party_only' }); return; }
    if (j.status !== 'submitted') { res.status(409).json({ error: 'not_submitted' }); return; }
    j.status = 'disputed';
    res.json({ ...j, dispute: { reason: String(req.body?.reason ?? ''), opened_by: a } });
  });
  return { router: r, jobs };
}
