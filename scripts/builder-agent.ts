/**
 * A builder agent for NEAR AI Agent Market bounties posted by Sealed Recipes.
 *
 * It watches Agent Market for open jobs tagged `sealed-recipes`, bids on the job types it has a recipe for, and when
 * awarded, publishes that recipe sealed on Sealed Recipes from its own NEAR account (the recipe never goes to Agent
 * Market) and submits `{"recipe_id": ...}` as the deliverable. Sealed Recipes then verifies and accepts it.
 *
 * In the local demo it runs against the offline Agent Market mock (scripts/demo.mjs starts one). Against the real
 * market it needs AGENT_MARKET_URL=https://market.near.ai and AGENT_MARKET_API_KEY, and a real Sealed Recipes
 * deployment (SRS_URL); it is the same code, written to the API in market.near.ai/skill.md.
 *
 *   npx tsx scripts/builder-agent.ts [--handle dropsmith] [--bid-pct 75] [--deliver-wrong SWPR] [--once]
 *   --deliver-wrong <ID>  submit someone else's recipe instead (tests that verification rejects it)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../core/src/codehash.js';
import type { Recipe } from '../core/src/index.js';
import { AgentMarketClient, type MarketJob } from '../server/src/agent-market.js';
import { BASE, publish, verifiedRunner } from './lib/client.js';

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const HANDLE = arg('handle', 'dropsmith')!;
const BID_PCT = Number(arg('bid-pct', '75'));
const WRONG = arg('deliver-wrong');
const MARKET = process.env.AGENT_MARKET_URL ?? `${BASE}/mock/agent-market`;
const say = (s: string) => console.log(`[builder:${HANDLE}] ${s}`);
const root = new URL('..', import.meta.url);
const catalog = loadCatalog(fileURLToPath(root));
// the recipes this builder can deliver, by the job type they implement
const templates = new Map<string, Recipe>(readdirSync(new URL('seed/bounty/', root)).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(new URL(`seed/bounty/${f}`, root), 'utf8')) as Recipe).map((r) => [r.implements!, r]));

let me: { agent_id: string; near_account_id: string; api_key: string };
if (process.env.AGENT_MARKET_API_KEY) me = { agent_id: process.env.AGENT_AGENT_ID ?? '', near_account_id: process.env.AGENT_NEAR_ACCOUNT ?? '', api_key: process.env.AGENT_MARKET_API_KEY };
else {
  for (let i = 0; ; i++) { // the mock comes up with the marketplace server
    try { me = await AgentMarketClient.register(MARKET, HANDLE, ['sealed-recipes', 'near', 'srs-1', 'recipes']); break; }
    catch (e) { if (i > 60) throw e; await new Promise((r) => setTimeout(r, 1000)); }
  }
}
const market = new AgentMarketClient(MARKET, me.api_key);
say(`registered on Agent Market as @${HANDLE} (${me.near_account_id}); can build: ${[...templates.keys()].join(', ')}`);

const bidOn = new Set<string>();
const delivered = new Set<string>();
const jobTypeOf = (j: MarketJob) => /\((job\.[a-z0-9.-]+@\d+\.\d+\.\d+)\)/.exec(j.description)?.[1];

async function tick() {
  for (const j of await market.listJobs({ status: 'open', tags: ['sealed-recipes'] })) {
    if (bidOn.has(j.job_id) || j.creator_agent_id === me.agent_id) continue;
    const jt = jobTypeOf(j); const t = jt && templates.get(jt);
    bidOn.add(j.job_id);
    if (!t) { say(`skip "${j.title}": no recipe for ${jt}`); continue; }
    const amount = ((Number(j.budget_amount) * BID_PCT) / 100).toFixed(2);
    await market.bid(j.job_id, { amount, eta_seconds: 3600, proposal: `I'll publish "${t.meta.name}", a sealed recipe implementing ${jt} with parts ${t.nodes.map((n) => n.part).join(' + ')}, backed by a ${Number(t.listing.bond ?? 0) / 1e6} USDC guarantee deposit.` });
    say(`bid ${amount} ${j.budget_token} on "${j.title}"`);
  }
  for (const j of await market.listJobs({ status: 'in_progress', tags: ['sealed-recipes'] })) {
    if (j.worker_agent_id !== me.agent_id || delivered.has(j.job_id)) continue;
    delivered.add(j.job_id);
    const jt = jobTypeOf(j)!;
    if (WRONG) { await market.submit(j.job_id, JSON.stringify({ recipe_id: WRONG })); say(`submitted ${WRONG} (deliberately wrong)`); continue; }
    const recipe = structuredClone(templates.get(jt)!);
    recipe.meta.creator = me.near_account_id; // published from the account that won the bid
    const { onchain } = await verifiedRunner(); // checks the runner's attestation before sealing to its key
    const r = await publish(recipe, catalog, onchain.enc_pk_hex);
    say(`awarded "${j.title}": published ${recipe.meta.ticker} sealed (tx ${r.tx}), submitting`);
    await market.submit(j.job_id, JSON.stringify({ recipe_id: recipe.meta.ticker }));
  }
}

const once = process.argv.includes('--once');
for (;;) {
  try { await tick(); } catch (e) { say(`error: ${(e as Error).message.slice(0, 200)}`); }
  if (once) break;
  await new Promise((r) => setTimeout(r, 1500));
}
