/**
 * Adversarial check against a running demo (`npm run demo`): can a buyer drain a recipe's bond?
 *
 * The attack: get a bonded quote while the wallet is full, empty the wallet, then pay with the quote. If the
 * runner simply executed, it would deliver almost nothing and the contract would pay the shortfall from the bond.
 *
 * What happens instead: right before executing, the runner re-prices the job inside the TEE. The fresh promise is
 * far below the quoted one, so it signs an `abort` report: the buyer gets the run price back, the cover returns
 * to the bond, and the recipe's `aborted` counter goes up (aborts are not counted as failures).
 *   npm run attack:drain
 */
import { open, USDC_NEAR, type SealedEnvelope } from '../core/src/index.js';
import { api, BASE, freshImplicitAccount, verifiedRunner, postJob, signedQuote } from './lib/client.js';

const BUYER = 'carol.testnet';
const usd = (u: string | number | bigint) => '$' + (Number(u) / 1e6).toFixed(4);
const say = (s: string) => console.log(`[attack] ${s}`);

const runner = await verifiedRunner();
const fresh = freshImplicitAccount();
const job = await postJob('job.wallet-cleanup@1.0.0', { wallet: BUYER, threshold_usd: 30, target: USDC_NEAR, recipient: fresh.account }, runner.onchain, BUYER);
const q = job.quotes.find((x) => x.ok && Number(x.cover) > 0);
const T = q?.listing.ticker as string;
if (!q) { say('no quote: ' + JSON.stringify(job.quotes.map((x) => x.error))); process.exit(1); }
say(`1. bonded ${T} quote while the wallet is full: promise ${usd(q.promised)}, bond covers ${usd(q.cover)}`);

const before = await api<{ onchain: { bond_available: string; bond_locked: string; aborted: string; compensated_total: string } }>(`/api/recipe/${T}`);
const wallet = await api<{ wallet: { contract_id: string; symbol: string; balance: string }[] }>(`/api/account/${BUYER}`);
let moved = 0;
for (const t of wallet.wallet) if (BigInt(t.balance) > 0n) { await api('/api/world/transfer', { from: BUYER, token: t.contract_id, to: 'carol-stash.testnet', amount: t.balance }); moved++; }
say(`2. emptied ${BUYER}: moved ${moved} tokens to another account of hers`);

const r = await api<{ run_id: string; run_token: string; msg: string }>('/api/runs/quote', { recipe_id: T, buyer: BUYER, pay_asset: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', refund_to: '0xC0c0000000000000000000000000000000000001', sealed_inputs: job.sealed_job, signed_quote: signedQuote(q) });
const balBefore = BigInt((await api<{ balance: string }>(`/api/account/${BUYER}`)).balance);
await api(`/api/runs/${r.run_id}/pay?token=${r.run_token}`, {});
say('3. paid with the old quote; watching the run');

const res = await fetch(`${BASE}/api/runs/${r.run_id}/events?token=${r.run_token}`);
const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = ''; let final: any;
for (let done = false; !done;) {
  const { value, done: end } = await reader.read(); if (end) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    let e = JSON.parse(buf.slice(6, i)); buf = buf.slice(i + 2);
    if (e.type === 'sealed') { e = { ...e, ...open<{ type: string; data: any }>(e.data.envelope as SealedEnvelope, job.reply.secretKey) }; }
    if (e.type === 'rechecked') say(`   runner re-priced the job before executing: ${e.data.ok ? 'quote holds' : 'below 98% of the quote'}`);
    if (e.type === 'recheck') say(`   fresh promise ${usd(e.data.fresh_promised)} vs quoted ${usd(e.data.quoted_promised)}`);
    if (e.type === 'signed') say(`   signed: ${e.data.message.split('|').slice(0, 5).join('|')}|…`);
    if (e.type === 'part_start') say(`   ✘ a part started executing: ${e.data.name}`);
    if (e.type === 'completed' || e.type === 'failed') { final = e; done = true; break; }
  }
}

const after = await api<{ onchain: { bond_available: string; bond_locked: string; aborted: string; compensated_total: string } }>(`/api/recipe/${T}`);
const balAfter = BigInt((await api<{ balance: string }>(`/api/account/${BUYER}`)).balance);
const checks = [
  ['run ended as abort', final?.data?.outcome === 'abort'],
  ['bond_available unchanged', after.onchain.bond_available === before.onchain.bond_available],
  ['nothing left locked', after.onchain.bond_locked === before.onchain.bond_locked],
  ['no compensation paid', after.onchain.compensated_total === before.onchain.compensated_total],
  ['aborted counter +1', BigInt(after.onchain.aborted) === BigInt(before.onchain.aborted) + 1n],
  [`run price refunded to ${BUYER} (${usd(balAfter - balBefore)})`, balAfter > balBefore],
] as const;
for (const [label, ok] of checks) say(`${ok ? '✔' : '✘'} ${label}`);
for (const t of wallet.wallet) if (BigInt(t.balance) > 0n) await api('/api/world/transfer', { from: 'carol-stash.testnet', token: t.contract_id, to: BUYER, amount: t.balance });
say('restored the wallet');
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
