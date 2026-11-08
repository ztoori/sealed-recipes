/**
 * Durable-run crash test against a running demo (`npm run demo`, or `npm run test:durable` to start one).
 *
 * Runs TRCH ("Exit in two tranches": sell half now, wait, sell the rest) and kills the runner process twice:
 *   1. right after the first tranche's deposits were signed and submitted (mid-swap, while 1Click settles them);
 *   2. in the middle of the wait between tranches.
 * The launcher restarts the runner like a container restart policy would; the marketplace asks it to resume from
 * the last checkpoint it stored. The script then checks, from the chain and the wallet, that:
 *   - the run completed and settled once;
 *   - the buyer was asked to sign exactly twice (once per tranche), never again after a crash;
 *   - every token left the wallet exactly once per tranche (no double deposit);
 *   - each part's author was paid at its checkpoint, never twice, and billed + payouts + reserve == price;
 *   - the wait resumed with the time that was left, not from zero.
 */
import { open, type SealedEnvelope } from '../core/src/index.js';
import { api, BASE, freshImplicitAccount, verifiedRunner, requestQuotes, signedQuote } from './lib/client.js';

const BUYER = 'carol.testnet';
const say = (s: string) => console.log(`[durable] ${s}`);
const usd = (u: string | number | bigint) => '$' + (Number(u) / 1e6).toFixed(4);

const runner = await verifiedRunner();
const fresh = freshImplicitAccount();
const before = await api<{ wallet: { contract_id: string; symbol: string; balance: string }[] }>(`/api/account/${BUYER}`);
const job = await requestQuotes(['TRCH'], { wallet: BUYER, recipient: fresh.account }, runner.onchain, BUYER);
const q = job.quotes.find((x) => x.ok);
if (!q) { say('TRCH did not quote: ' + JSON.stringify(job.quotes.map((x) => x.error))); process.exit(1); }
say(`TRCH quoted: expects ${usd(q.expected)}, promises ${usd(q.promised)} (bond covers ${usd(q.cover)}), settle mode: per checkpoint`);
const r = await api<{ run_id: string; run_token: string }>('/api/runs/quote', { recipe_id: 'TRCH', buyer: BUYER, pay_asset: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', refund_to: '0xC0c0000000000000000000000000000000000001', sealed_inputs: job.sealed_job, signed_quote: signedQuote(q) });
await api(`/api/runs/${r.run_id}/pay?token=${r.run_token}`, {});
say(`paid run ${r.run_id}; watching it`);

const crash = async (why: string) => { say(`💥 killing the runner process (${why})`); await api('/api/dev/crash-runner', {}); };
let approvals = 0, crashes = 0, waitLeft: number | null = null, final: any;
const mid = new Map<string, number>();
const t0 = Date.now();
const res = await fetch(`${BASE}/api/runs/${r.run_id}/events?token=${r.run_token}`);
const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = '';
for (let done = false; !done;) {
  const { value, done: end } = await reader.read(); if (end) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    let e = JSON.parse(buf.slice(6, i)); buf = buf.slice(i + 2);
    if (e.type === 'sealed') e = { ...e, ...open<{ type: string; data: any }>(e.data.envelope as SealedEnvelope, job.reply.secretKey) };
    const t = `${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(6);
    switch (e.type) {
      case 'part_start': say(`${t} ▶ ${e.data.name}${e.data.resumed ? ' (resumed mid-part)' : ''}`); break;
      case 'checkpoint': {
        const n = (mid.get(e.data.mid_part ?? '') ?? 0) + 1; mid.set(e.data.mid_part ?? '', n);
        say(`${t}   checkpoint #${e.data.local_seq} stored (${e.data.mid_part ? `inside ${e.data.mid_part}` : `${e.data.completed_parts} parts done`})`);
        // in the clear, checkpoints name only the step (SRS-1 §5.3): in TRCH's execution order s4 is the first tranche, s5 the wait
        if (e.data.mid_part === 's4' && n === 2 && crashes === 0) { crashes++; await crash('first tranche deposits submitted, swaps still settling'); }
        if (e.data.mid_part === 's5' && n === 1 && crashes === 1) { crashes++; setTimeout(() => void crash('6 s into the 20 s wait'), 6000); }
        break;
      }
      case 'run_checkpoint': say(`${t}   on-chain checkpoint seq ${e.data.seq}: paid ${e.data.payouts.map((p: any) => `${p.role.slice(5).split('@')[0]} ${usd(p.amount)}`).join(', ') || 'heartbeat'} (billed so far ${usd(e.data.billed)})`); break;
      case 'approval_required': {
        approvals++;
        say(`${t}   🔐 buyer asked to sign ${e.data.transactions.length} deposit(s) (request #${approvals})`);
        await api(`/api/runs/${r.run_id}/approve?token=${r.run_token}`, { approved: true, transactions: e.data.transactions });
        break;
      }
      case 'runner_lost': say(`${t}   marketplace lost the runner; last stored checkpoint #${e.data.checkpoint}`); break;
      case 'resume_requested': say(`${t}   runner is back; asked it to resume (attempt ${e.data.attempt})`); break;
      case 'resuming': say(`${t}   runner verified and opened checkpoint #${e.data.local_seq}: ${e.data.completed_parts} parts done${e.data.mid_part ? `, inside ${e.data.mid_part}` : ''}`); break;
      case 'part_log': if (/resum|already approved|wait/.test(e.data.msg)) { say(`${t}     ${e.data.msg}`); const m = /(\d+) s of the wait left/.exec(e.data.msg); if (m) waitLeft = Number(m[1]); } break;
      case 'srs_settlement': say(`${t}   settled: ${e.data.payouts.length} payees in the final receipt, delivered ${usd(e.data.delivered)}`); break;
      case 'completed': case 'failed': final = e; done = true; break;
    }
    if (done) break;
  }
}

const chainRun = await api<any>(`/api/chain/runs/${r.run_id}`);
const recipeParts = (await api<{ parts: string[] }>('/api/chain/recipes/TRCH')).parts;
const settle = (await api<{ events: any[] }>('/api/chain/events?last=400')).events.filter((x) => x.event === 'srs_settlement' && x.data[0].run_id === r.run_id);
const ckpts = (await api<{ events: any[] }>('/api/chain/events?last=400')).events.filter((x) => x.event === 'run_checkpoint' && x.data[0].run_id === r.run_id);
const paidParts = [...ckpts.flatMap((x) => x.data[0].payouts.map((p: any) => p.role)), ...settle.flatMap((x) => x.data[0].payouts.filter((p: any) => p.role.startsWith('part:')).map((p: any) => p.role))];
const total = BigInt(chainRun.billed) + settle.reduce((s, x) => s + x.data[0].payouts.reduce((a: bigint, p: any) => a + BigInt(p.amount), 0n) + BigInt(x.data[0].reserve), 0n);
const after = await api<{ wallet: { contract_id: string; balance: string }[] }>(`/api/account/${BUYER}`);
const moved = before.wallet.map((b) => ({ ...b, delta: BigInt(b.balance) - BigInt(after.wallet.find((a) => a.contract_id === b.contract_id)?.balance ?? '0') })).filter((x) => x.delta > 0n);
const exactlyTwoHalves = moved.every((m) => m.delta === 2n * (BigInt(m.balance) / 2n));

const checks: [string, boolean][] = [
  ['the runner was killed twice and the run still completed', crashes === 2 && final?.type === 'completed' && final.data.ok],
  ['settled exactly once on-chain', chainRun.status === 'Settled' && settle.length === 1],
  ['buyer signed exactly twice (once per tranche), never again after a crash', approvals === 2],
  [`every swapped token left the wallet exactly once per tranche (${moved.length} tokens)`, moved.length > 0 && exactlyTwoHalves],
  ['every part paid exactly once across checkpoints and the final receipt', JSON.stringify(paidParts.map((p) => p.slice(5)).sort()) === JSON.stringify([...recipeParts].sort())],
  [`billed at checkpoints + final payouts + reserve == price (${usd(total)})`, total === BigInt(chainRun.amount)],
  [`the wait resumed with the time left (${waitLeft ?? '?'} s of 20), not from zero`, waitLeft !== null && waitLeft < 20],
];
for (const [label, ok] of checks) say(`${ok ? '✔' : '✘'} ${label}`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
