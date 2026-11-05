import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../core/src/codehash.js';
/**
 * The 4-step demo story, headless. Requires `npm run demo` running (or use `npm run demo -- --story --exit`).
 *   1. creator composes "Clean up and protect", seals it to the attested runner, publishes it
 *   2. buyer posts a job with one short form; sealed recipes compete with signed, bonded quotes; the buyer picks one
 *      and pays per run through NEAR Intents (1Click EXACT_OUTPUT → ft_transfer_call to the contract)
 *   3. the sealed workflow sweeps dust and swaps it confidentially to a fresh address
 *   4. creator, every part author, runner and protocol are paid in one settlement; the creator's reserve tops up
 *      the recipe's guarantee deposit
 * Exits non-zero if any step fails.
 */
import { readFileSync } from 'node:fs';
import { api, BASE, freshImplicitAccount, publish, verifiedRunner, postJob, pickQuote, signedQuote } from './lib/client.js';
import nacl from 'tweetnacl';
import { bytesToHex } from '@noble/hashes/utils.js';
import { seal, open, validateRecipe, USDC_NEAR, type Catalog, type Recipe, type SealedEnvelope } from '../core/src/index.js';

const root = new URL('..', import.meta.url);
const catalog = loadCatalog(fileURLToPath(root));
const recipe = JSON.parse(readFileSync(new URL('seed/recipes/CLNP.json', root), 'utf8')) as Recipe;
const usd = (u: string | number) => '$' + (Number(u) / 1e6).toFixed(4);
const h = (s: string) => console.log(`\n\x1b[1m\x1b[38;5;48m${s}\x1b[0m`);

h('STEP 1 · creator chains parts into "Clean up and protect" and publishes it privately');
const v = validateRecipe(recipe, catalog);
console.log(`  FRS-1 validation: ${v.ok ? 'OK' : 'FAILED'} · ${v.order.length} parts · part fees ${usd(v.partFees.toString())}/run · capabilities: ${v.capabilities.join(', ')}`);
const runner = await verifiedRunner();
for (const c of runner.checks) console.log(`  ${c.status === 'pass' ? '✔' : c.status === 'skip' ? '○' : '✘'} ${c.label}${c.status === 'skip' ? ' — ' + c.detail : ''}`);
const listings = await api<{ ticker: string }[]>('/api/listings');
if (listings.some((l) => l.ticker === 'CLNP')) console.log('  CLNP already published — reusing it');
else {
  const p = await publish(recipe, catalog, runner.onchain.enc_pk_hex);
  console.log(`  sealed in the client to runner key ${runner.onchain.enc_pk_hex.slice(0, 12)}…; server received ciphertext only`);
  console.log(`  publish_recipe → tx ${p.tx} (block ${p.height}) · on-chain sealed_hash ${p.sealed_hash.slice(0, 20)}…`);
  console.log(`  ${usd(recipe.listing.bond ?? '0')} bond posted to back CLNP's quotes`);
}

h('STEP 2 · buyer posts a job, recipes compete with signed quotes, buyer picks one and pays through NEAR Intents');
const fresh = freshImplicitAccount();
const inputs = { wallet: 'bob.testnet', threshold_usd: 25, target: USDC_NEAR, recipient: fresh.account };
console.log('  job: "Clean up my wallet"', JSON.stringify({ ...inputs, recipient: fresh.account.slice(0, 12) + '… (fresh, generated client-side)' }));
const before = await api<{ wallet: { symbol: string; balance: string; decimals: number }[] }>('/api/account/bob.testnet');
const job = await postJob('job.wallet-cleanup@1.0.0', inputs, runner.onchain, 'bob.testnet');
for (const qt of job.quotes) if (!qt.ok) console.log(`  quote ${qt.listing.ticker.padEnd(5)} rejected: ${qt.error}`); else console.log(`  quote ${qt.listing.ticker.padEnd(5)} expects ${usd(qt.expected).padStart(9)}  promises ${usd(qt.promised).padStart(9)} (deposit covers ${usd(qt.cover ?? '0')})  price ${usd(qt.price)} (signed; band ${usd(qt.listing.price_floor)}–${usd(qt.listing.price_ceiling)})  ${qt.listing.privacy.padEnd(12)} risk ${qt.listing.risk}`);
const policy = { requirePrivacy: 'confidential' as const, maxRisk: 'medium' as const, sort: 'net' as const };
const chosen = pickQuote(job.quotes, policy);
if (!chosen) { console.error('✘ no quote satisfies the policy'); process.exit(1); }
console.log(`  every quote arrived sealed to the buyer's one-time key; runner signatures verified client-side (bound to bob.testnet, this job and these sealed inputs)`);
console.log(`  policy ${JSON.stringify(policy)} → ${chosen.listing.ticker} (signed by the runner; promise backed by the bond)`);
const reply = job.reply; // one-time key: everything the runner says about this run is sealed to it
const sealedInputs = job.sealed_job;
const q = await api<{ run_id: string; run_token: string; msg: string; quote: { quote: { amountInFormatted: string; depositAddress: string; amountOut: string } } }>('/api/runs/quote', {
  recipe_id: chosen.listing.ticker, buyer: 'bob.testnet', pay_asset: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', refund_to: '0xB0b0000000000000000000000000000000000001', sealed_inputs: sealedInputs,
  signed_quote: signedQuote(chosen),
});
console.log(`  1Click EXACT_OUTPUT quote: pay ${q.quote.quote.amountInFormatted} USDC (Arbitrum) → ${usd(q.quote.quote.amountOut)} USDC delivered to the contract`);
console.log(`  customRecipientMsg: ${q.msg}`);
await api(`/api/runs/${q.run_id}/pay?token=${q.run_token}`, {});

h('STEP 3 · the sealed workflow sweeps dust and swaps privately to a fresh address');
const res = await fetch(`${BASE}/api/runs/${q.run_id}/events?token=${q.run_token}`);
let result: any;
const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = ''; let done = false; let final: any;
const t0 = Date.now();
while (!done) {
  const { value, done: end } = await reader.read(); if (end) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    let e = JSON.parse(buf.slice(6, i)); buf = buf.slice(i + 2);
    if (e.type === 'sealed') { const inner = open<{ type: string; data: any }>(e.data.envelope as SealedEnvelope, reply.secretKey); e = { ...e, type: inner.type, data: inner.data, sealed: true }; }
    if (e.type === 'result') { result = e.data; continue; }
    const tag = `  [${((Date.now() - t0) / 1000).toFixed(1)}s ${e.source}]`;
    if (e.type === 'status') console.log(`${tag} 1Click payment ${e.data.status}`);
    else if (e.type === 'run_requested') console.log(`${tag} ft_on_transfer → run escrowed on-chain (tx ${e.data.tx})`);
    else if (e.type === 'verified') for (const c of e.data.checks) console.log(`${tag} ${c.ok ? '✔' : '✘'} ${c.label}`);
    else if (e.type === 'rechecked') console.log(`${tag} re-priced the job right before executing: ${e.data.ok ? 'quote still holds' : 'wallet changed, aborting with a refund'}`);
    else if (e.type === 'recheck') console.log(`${tag}     fresh promise ${usd(e.data.fresh_promised)} vs quoted ${usd(e.data.quoted_promised)} (needs ≥ 98%)`);
    else if (e.type === 'decrypted') console.log(`${tag} ${e.data.note}`);
    else if (e.type === 'part_start') console.log(`${tag} ▶ ${e.data.name} (by ${e.data.author}, fee ${usd(e.data.fee)})`);
    else if (e.type === 'part_log') console.log(`${tag}     ${e.data.msg}`);
    else if (e.type === 'approval_required') { console.log(`${tag} 🔐 wallet: "${e.data.title}" — ${e.data.transactions.length} ft_transfer(s); approving`); await api(`/api/runs/${q.run_id}/approve?token=${q.run_token}`, { approved: true, transactions: e.data.transactions }); }
    else if (e.type === 'signed') console.log(`${tag} runner signed report: ${e.data.message.slice(0, 90)}…`);
    else if (e.type === 'frs_settlement') console.log(`${tag} report_run verified on-chain (tx ${e.data.tx})`);
    else if (e.type === 'completed' || e.type === 'failed') { final = e; done = true; break; }
  }
}
await reader.cancel();
if (final?.type !== 'completed' || !final.data.ok) { console.error('\n✘ run failed:', JSON.stringify(final?.data), JSON.stringify(result)); process.exit(1); }
console.log('  (part logs, the wallet request and the result above were sealed to the buyer\'s reply key; the marketplace relayed ciphertext)');
const receipts = result.output as { symbol: string; amountIn: string; amountOut: string; status: string }[];
for (const r of receipts) console.log(`  ✔ ${r.symbol.padEnd(12)} ${r.amountIn.padStart(14)} → ${Number(r.amountOut).toFixed(4)} USDC  ${r.status} (confidential)`);
const after = await api<{ wallet: { symbol: string; balance: string; contract_id: string }[] }>(`/api/account/${fresh.account}`);
console.log(`  fresh address ${fresh.account.slice(0, 12)}… now holds: ${after.wallet.map((w) => `${(Number(w.balance) / 1e6).toFixed(4)} ${w.symbol}`).join(', ')}`);
const bob = await api<{ wallet: { symbol: string; balance: string }[] }>('/api/account/bob.testnet');
console.log(`  bob.testnet tokens: ${before.wallet.length} → ${bob.wallet.filter((w) => w.balance !== '0').length} (scam airdrops untouched, USDC + wNEAR kept)`);

h('STEP 4 · creator and each part author are paid in the same settlement');
const s = final.data.settlement as { payouts: { account_id: string; role: string; amount: string }[]; tx: string; height: number };
for (const p of s.payouts) console.log(`  ${usd(p.amount).padStart(10)}  ${p.account_id.padEnd(24)} ${p.role}`);
const m = await api<{ settlements: { reserve: string; price: string; payouts: { amount: string }[] }[]; record: { deposit: { available: number } } }>(`/api/recipe/${chosen.listing.ticker}`);
console.log(`  ${usd(m.settlements[0].reserve).padStart(10)}  CLNP guarantee deposit     creator's reserve, held as collateral for future quotes`);
const paidOut = m.settlements[0].payouts.reduce((a, p) => a + BigInt(p.amount), 0n) + BigInt(m.settlements[0].reserve);
if (paidOut !== BigInt(m.settlements[0].price)) { console.error(`✘ payouts + reserve ${paidOut} != price ${m.settlements[0].price}`); process.exit(1); }
console.log(`  payouts + reserve == price (${usd(m.settlements[0].price)}): every unit accounted for`);
console.log(`  one receipt: tx ${s.tx} at block ${s.height}`);
const st = m.settlements[0] as unknown as { delivered: string; compensation: string };
console.log(`  delivered ${usd(st.delivered)} vs promised ${usd(chosen.promised)} → compensation from the guarantee deposit ${usd(st.compensation)}`);
if (BigInt(st.delivered) < BigInt(chosen.promised) && st.compensation === '0') { console.error('✘ shortfall not compensated'); process.exit(1); }

console.log('\n✔ story complete');
