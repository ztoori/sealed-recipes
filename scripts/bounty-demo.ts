/**
 * Builder bounties end to end, against a running demo (`npm run test:bounty` starts one, with the offline Agent Market
 * mock and two demo builder agents: @dropsmith, honest, and @swapsmith, who bids lower and delivers someone else's
 * recipe).
 *
 *   1. bob asks for "claim my airdrops to a fresh address": no recipe serves it, so it shows up as open demand.
 *   2. The marketplace posts a bounty for that job type on Agent Market. Both builders bid.
 *   3. The cheaper bid (@swapsmith) is awarded. Its delivery fails verification: rejected, dispute opened, no payout.
 *   4. The bounty is reposted and @dropsmith is awarded. It publishes AIRD sealed from its own account; every check
 *      passes, the delivery is accepted, and Agent Market releases the escrow to it.
 *   5. bob asks again: AIRD quotes, runs, and his airdrops land on a fresh address.
 */
import { open, type SealedEnvelope } from '../core/src/index.js';
import { api, BASE, freshImplicitAccount, verifiedRunner, postJob, signedQuote } from './lib/client.js';

const BUYER = 'bob.testnet';
const JOB = 'job.airdrop-claim@1.0.0';
const say = (s: string) => console.log(`[bounty] ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type B = { id: string; status: string; bids: { bid_id: string; handle: string; amount: string }[]; checks?: { name: string; ok: boolean; detail: string }[]; transactions: { type: string; to: string; amount: string }[]; log: { msg: string }[]; recipe_id?: string };
const bounty = async (id: string) => (await api<{ bounties: B[] }>('/api/bounties')).bounties.find((b) => b.id === id)!;
async function until(id: string, ok: (b: B) => boolean, what: string, ms = 60_000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(500)) { const b = await bounty(id); if (ok(b)) return b; }
  throw new Error(`timed out waiting for ${what}`);
}

for (let i = 0; !(await api<{ ready: boolean }>('/api/bounties')).ready; i++) { if (i > 60) throw new Error('Agent Market not connected'); await sleep(500); }
const runner = await verifiedRunner();

// 1. open demand
const ask = await postJob(JOB, { wallet: BUYER, recipient: freshImplicitAccount().account }, runner.onchain, BUYER);
say(`bob asks for "${JOB}": ${ask.quotes.length} quotes, open demand = ${!!(ask as any).open_demand}`);

// 2–3. bounty, two bids, award the cheaper one
const b1 = await api<B>('/api/bounties', { job_type: JOB, budget: '250', by: 'bounty-demo' });
say(`bounty posted on Agent Market (${b1.id}): 250 USDC`);
const withBids = await until(b1.id, (b) => b.bids.length >= 2, 'two bids');
for (const x of withBids.bids) say(`  bid from @${x.handle}: ${x.amount} USDC`);
const cheap = [...withBids.bids].sort((a, b) => Number(a.amount) - Number(b.amount))[0];
await api(`/api/bounties/${b1.id}/award`, { bid_id: cheap.bid_id });
say(`awarded the cheaper bid, @${cheap.handle}`);
const r1 = await until(b1.id, (b) => ['accepted', 'rejected'].includes(b.status), 'verification of delivery 1');
for (const c of r1.checks ?? []) say(`  ${c.ok ? '✔' : '✘'} ${c.name}: ${c.detail}`);
say(`  → ${r1.status}`);

// 4. repost, award the honest builder
const b2 = await api<B>('/api/bounties', { job_type: JOB, budget: '250', by: 'bounty-demo' });
const bids2 = await until(b2.id, (b) => b.bids.some((x) => x.handle === 'dropsmith'), 'a bid from @dropsmith');
const honest = bids2.bids.find((x) => x.handle === 'dropsmith')!;
await api(`/api/bounties/${b2.id}/award`, { bid_id: honest.bid_id });
say(`reposted (${b2.id}) and awarded @dropsmith at ${honest.amount} USDC`);
const r2 = await until(b2.id, (b) => ['accepted', 'rejected'].includes(b.status), 'verification of delivery 2', 120_000);
for (const c of r2.checks ?? []) say(`  ${c.ok ? '✔' : '✘'} ${c.name}: ${c.detail}`);
say(`  → ${r2.status}; Agent Market transactions: ${r2.transactions.map((t) => `${t.type} ${t.amount} → ${t.to}`).join(' | ')}`);

// 5. the demand is now served
const fresh = freshImplicitAccount();
const job = await postJob(JOB, { wallet: BUYER, recipient: fresh.account }, runner.onchain, BUYER);
const q = job.quotes.find((x) => x.ok);
say(`bob asks again: ${job.quotes.length} quote(s)${q ? `, ${q.recipe_id} promises ${q.promised} base units` : ''}`);
let final: any;
const claimed: Record<string, string> = {};
if (q) {
  const r = await api<{ run_id: string; run_token: string }>('/api/runs/quote', { recipe_id: q.recipe_id, buyer: BUYER, pay_asset: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', refund_to: '0xB0b0000000000000000000000000000000000001', sealed_inputs: job.sealed_job, signed_quote: signedQuote(q) });
  await api(`/api/runs/${r.run_id}/pay?token=${r.run_token}`, {});
  const res = await fetch(`${BASE}/api/runs/${r.run_id}/events?token=${r.run_token}`);
  const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = '';
  for (let done = false; !done;) {
    const { value, done: end } = await reader.read(); if (end) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      let e = JSON.parse(buf.slice(6, i)); buf = buf.slice(i + 2);
      if (e.type === 'sealed') e = { ...e, ...open<{ type: string; data: any }>(e.data.envelope as SealedEnvelope, job.reply.secretKey) };
      if (e.type === 'approval_required') {
        say(`  wallet: approve ${e.data.transactions.length} claim transaction(s)`);
        await api(`/api/runs/${r.run_id}/approve?token=${r.run_token}`, { approved: true, transactions: e.data.transactions, sign_message: e.data.sign_message });
      }
      if (e.type === 'completed' || e.type === 'failed') { final = e; done = true; break; }
    }
  }
  const w = (await api<{ wallet: { contract_id: string; symbol: string; balance: string }[] }>(`/api/account/${fresh.account}`)).wallet;
  for (const x of w) if (BigInt(x.balance) > 0n) claimed[x.symbol || x.contract_id] = x.balance;
  say(`  run ${final?.type}; fresh address now holds ${Object.entries(claimed).map(([k, v]) => `${Number(BigInt(v) / 10n ** 15n) / 1000} ${k}`).join(', ') || 'nothing'}`);
}

const reward = (b: B, who: string) => b.transactions.some((t) => t.type === 'agent reward' && t.to.startsWith(who));
const checks: [string, boolean][] = [
  ['no recipe served the job at first: open demand', ask.quotes.length === 0],
  ['both builders bid on the bounty', withBids.bids.length >= 2],
  ['the wrong delivery was rejected and paid nothing', r1.status === 'rejected' && !reward(r1, cheap.handle) && (r1.checks ?? []).some((c) => !c.ok)],
  ['the honest delivery passed every check and was accepted', r2.status === 'accepted' && (r2.checks ?? []).length >= 6 && r2.checks!.every((c) => c.ok)],
  ['Agent Market released the escrow to @dropsmith', reward(r2, 'dropsmith')],
  [`the demand is served: ${q?.recipe_id ?? 'no'} recipe quotes`, q?.recipe_id === r2.recipe_id],
  ['the run claimed the airdrops to the fresh address', final?.type === 'completed' && Object.keys(claimed).length >= 2],
];
for (const [label, ok] of checks) say(`${ok ? '✔' : '✘'} ${label}`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
