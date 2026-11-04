/**
 * All-or-nothing swaps through the NEAR Intents Verifier, against a running demo (`npm run demo`, or
 * `npm run test:atomic` to start one). Uses ATOM ("Exit, all or nothing").
 *
 * Run 1: the solver backs out of one of the swaps at execution time (local demo hook). The Verifier rejects the
 *        whole bundle: no swap happens, nothing reaches the fresh address, the deposits sit in the buyer's own
 *        intents.near balance, the run fails with a signed report and the run price is refunded.
 * Run 2: same wallet contents (now held in the Verifier plus whatever is left), solver back: every swap and the
 *        withdrawal settle in ONE execute_intents transaction.
 */
import { open, USDC_NEAR, type SealedEnvelope } from '../core/src/index.js';
import { api, BASE, freshImplicitAccount, verifiedRunner, postJob, signedQuote } from './lib/client.js';

const BUYER = 'carol.testnet';
const say = (s: string) => console.log(`[atomic] ${s}`);
const usdc = USDC_NEAR.replace(/^nep141:/, '');

async function runOnce(label: string, breakAsset?: string, breakSymbol?: string) {
  const runner = await verifiedRunner();
  const fresh = freshImplicitAccount();
  const job = await postJob('job.wallet-exit@1.0.0', { wallet: BUYER, recipient: fresh.account }, runner.onchain, BUYER, 'ATOM');
  const q = job.quotes.find((x) => x.ok);
  if (!q) throw new Error('ATOM did not quote: ' + JSON.stringify(job.quotes.map((x) => x.error)));
  say(`${label}: ATOM quotes ${(Number(q.promised) / 1e6).toFixed(4)} USDC (solver quotes are firm amounts)`);
  if (breakAsset) { await api('/api/dev/solver-fail', { asset: breakAsset }); say(`${label}: the solver will back out of the ${breakSymbol} leg at execution`); }
  const r = await api<{ run_id: string; run_token: string }>('/api/runs/quote', { recipe_id: 'ATOM', buyer: BUYER, pay_asset: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', refund_to: '0xC0c0000000000000000000000000000000000001', sealed_inputs: job.sealed_job, signed_quote: signedQuote(q) });
  await api(`/api/runs/${r.run_id}/pay?token=${r.run_token}`, {});
  const res = await fetch(`${BASE}/api/runs/${r.run_id}/events?token=${r.run_token}`);
  const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = ''; let final: any; let swapsLogged: string[] = [];
  for (let done = false; !done;) {
    const { value, done: end } = await reader.read(); if (end) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      let e = JSON.parse(buf.slice(6, i)); buf = buf.slice(i + 2);
      if (e.type === 'sealed') e = { ...e, ...open<{ type: string; data: any }>(e.data.envelope as SealedEnvelope, job.reply.secretKey) };
      if (e.type === 'approval_required') {
        say(`${label}:   wallet: ${e.data.transactions.length} deposits into intents.near + sign one bundle (${e.data.sign_summary})`);
        await api(`/api/runs/${r.run_id}/approve?token=${r.run_token}`, { approved: true, transactions: e.data.transactions, sign_message: e.data.sign_message });
      }
      if (e.type === 'part_log' && /bundle|settled|published/.test(e.data.msg)) { say(`${label}:   ${e.data.msg}`); swapsLogged.push(e.data.msg); }
      if (e.type === 'completed' || e.type === 'failed') { final = e; done = true; break; }
    }
  }
  if (breakAsset) await api('/api/dev/solver-fail', { asset: breakAsset, on: false });
  const chain = await api<any>(`/api/chain/runs/${r.run_id}`);
  const freshBal = (await api<{ wallet: { contract_id: string; balance: string }[] }>(`/api/portfolio/${fresh.account}`)).wallet.find((w) => w.contract_id === usdc)?.balance ?? '0';
  return { final, chain, freshBal, logs: swapsLogged };
}

const before = await api<{ wallet: { contract_id: string; symbol: string; balance: string }[] }>(`/api/portfolio/${BUYER}`);
const breakable = before.wallet.find((w) => BigInt(w.balance) > 0n && w.symbol !== 'USDC' && /AURORA|REF|USDT/.test(w.symbol));
if (!breakable) throw new Error('fixture wallet has no AURORA/REF/USDT');
const one = await runOnce('run 1', `nep141:${breakable.contract_id}`, breakable.symbol);
const verifierAfter1 = await api<{ balances: Record<string, string>; log: { summary: string }[] }>(`/api/intents/verifier/${BUYER}`);
const back = await api<{ withdrawn: number }>('/api/dev/verifier-withdraw', { account: BUYER });
say(`between runs: the buyer withdraws ${back.withdrawn} untouched deposit(s) from intents.near back to the wallet`);
const two = await runOnce('run 2');
const verifierAfter2 = await api<{ balances: Record<string, string>; log: { summary: string }[] }>(`/api/intents/verifier/${BUYER}`);

const held1 = Object.values(verifierAfter1.balances).filter((v) => BigInt(v) > 0n).length;
const checks: [string, boolean][] = [
  ['run 1 failed as a whole and was refunded (signed fail report)', one.final?.type === 'failed' || (one.final?.data?.ok === false) || one.chain.status === 'Refunded'],
  ['run 1 moved nothing to the fresh address: no partial swap', one.freshBal === '0'],
  [`run 1 deposits are still the buyer's own, in intents.near (${held1} tokens)`, held1 > 0],
  ['run 2 settled every swap and the payout in ONE execute_intents', two.chain.status === 'Settled' && two.logs.some((l) => /settled atomically in one execute_intents/.test(l))],
  [`run 2 delivered ${(Number(two.freshBal) / 1e6).toFixed(4)} USDC to the fresh address`, BigInt(two.freshBal) > 0n],
];
for (const [label, ok] of checks) say(`${ok ? '✔' : '✘'} ${label}`);
say('verifier log: ' + verifierAfter2.log.slice(-2).map((l) => l.summary).join(' | '));
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
