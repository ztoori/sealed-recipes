/**
 * An autonomous buyer: an agent posts a job, compares the competing quotes against its policy, pays the winner
 * through NEAR Intents, approves the deposits its policy allows, and checks delivery against the signed promise.
 * No human in the loop. Requires `npm run demo` running.
 *   npx tsx scripts/agent-buyer.ts [job-type] [policy-json]
 */
import { open, USDC_NEAR, type SealedEnvelope } from '../core/src/index.js';
import { api, BASE, freshImplicitAccount, verifiedRunner, postJob, pickQuote, signedQuote } from './lib/client.js';

const jobType = process.argv[2] ?? 'job.wallet-cleanup@1.0.0';
const policy = JSON.parse(process.argv[3] ?? '{"requirePrivacy":"confidential","maxRisk":"medium","sort":"net","maxPriceUsd":1,"maxApprovalUsd":100}');
const usd = (u: string | number) => '$' + (Number(u) / 1e6).toFixed(4);

const runner = await verifiedRunner();
const fresh = freshImplicitAccount();
const all: Record<string, unknown> = { wallet: 'carol.testnet', threshold_usd: 30, target: USDC_NEAR, recipient: fresh.account };
const jt = (await api<{ id: string; inputs: Record<string, unknown> }[]>('/api/jobs')).find((j) => j.id === jobType);
if (!jt) throw new Error('unknown job type ' + jobType);
const inputs = Object.fromEntries(Object.keys(jt.inputs).map((k) => [k, all[k]]));
// the agent's budget travels with the job: recipes listed above it are not even asked to quote
const job = await postJob(jobType, inputs, runner.onchain, 'carol.testnet', undefined, BigInt(Math.round(policy.maxPriceUsd * 1e6)));
if (job.open_demand) { console.log(`[agent] no recipe implements ${jobType} yet: recorded as open demand`); process.exit(0); }
for (const q of job.quotes) console.log(`[agent] quote ${q.listing.ticker}: ${q.ok ? `expects ${usd(q.expected)}, promises ${usd(q.promised)}, price ${usd(q.price ?? q.listing.price_per_run)}, ${q.listing.privacy}, risk ${q.listing.risk}` : 'failed: ' + q.error}`);
const pick = pickQuote(job.quotes.filter((q) => Number(q.price ?? q.listing.price_per_run) <= policy.maxPriceUsd * 1e6), policy);
if (!pick) { console.log('[agent] no quote meets my policy; not buying'); process.exit(0); }
console.log(`[agent] policy picks ${pick.listing.ticker}`);
const r = await api<{ run_id: string; run_token: string }>('/api/runs/quote', { recipe_id: pick.listing.ticker, buyer: 'carol.testnet', pay_asset: 'nep141:wrap.near', refund_to: 'carol.testnet', sealed_inputs: job.sealed_job, signed_quote: signedQuote(pick) });
await api(`/api/runs/${r.run_id}/pay?token=${r.run_token}`, {});
const res = await fetch(`${BASE}/api/runs/${r.run_id}/events?token=${r.run_token}`);
const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = ''; let result: any; let settled: any;
for (let done = false; !done;) {
  const { value, done: end } = await reader.read(); if (end) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    let e = JSON.parse(buf.slice(6, i)); buf = buf.slice(i + 2);
    if (e.type === 'sealed') { const inner = open<{ type: string; data: any }>(e.data.envelope as SealedEnvelope, job.reply.secretKey); e = { ...e, ...inner }; }
    if (e.type === 'approval_required') {
      const total = e.data.summary.reduce((s: number, x: { usd: number }) => s + x.usd, 0);
      const ok = total <= policy.maxApprovalUsd;
      console.log(`[agent] wallet request: ${e.data.transactions.length} transfers worth $${total.toFixed(2)} → ${ok ? 'approve' : 'reject (over my limit)'}`);
      await api(`/api/runs/${r.run_id}/approve?token=${r.run_token}`, { approved: ok, transactions: ok ? e.data.transactions : [] });
    }
    if (e.type === 'result') result = e.data;
    if (e.type === 'srs_settlement') settled = e.data;
    if (e.type === 'completed' || e.type === 'failed') { done = true; break; }
  }
}
await reader.cancel();
if (!result?.ok) { console.log('[agent] run failed and was refunded:', result?.error); process.exit(1); }
console.log(`[agent] delivered ${usd(settled.delivered)} vs promised ${usd(pick.promised)}; compensation ${usd(settled.compensation)}; done`);
