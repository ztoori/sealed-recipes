/**
 * Market-driven pricing (contract v6), against a running demo (`npm run test:pricing` uses 15-second periods).
 *
 * SAFE (scam-airdrop audit) has a list price of $0.15 in a $0.12–$0.40 band and a target of 2 paid runs per period.
 * Real buyers ask an audit recipe for signed quotes and pay through NEAR Intents. The script checks that:
 *   - every quote is signed at the recipe's current list price;
 *   - a busy period (4 paid runs, twice the target) raises the price by exactly 12.5% when the period ends;
 *   - the next quotes lock the new price, and settlement still pays every party exactly the price charged;
 *   - a buyer's max price keeps a recipe that is now too dear from even being asked to quote;
 *   - idle periods pull the price back down, never below the floor.
 */
import { api, BASE, verifiedRunner, requestQuotes, signedQuote } from './lib/client.js';

const T = 'SAFE';
const BUYERS = ['bob.testnet', 'carol.testnet', 'dave.testnet', 'erin.testnet'];
const say = (s: string) => console.log(`[pricing] ${s}`);
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const usd = (u: bigint | string | number) => '$' + (Number(u) / 1e6).toFixed(4);
const checks: [string, boolean][] = [];
const check = (name: string, ok: boolean) => { checks.push([name, ok]); console.log(`[pricing] ${ok ? '✔' : '✘'} ${name}`); };

type Rec = { pricePerRun: number; pricing: { floor: number; ceiling: number; targetRuns: number; periodRuns: number; periodS: number; periodEndsMs: number } };
const rec = async () => (await api<{ record: Rec }>(`/api/recipe/${T}`)).record;
const units = (usdAmount: number) => BigInt(Math.round(usdAmount * 1e6));
const runner = await verifiedRunner();

/** one real paid run: ask for a quote, open it, pay through 1Click with it, wait for settlement */
async function buy(buyer: string) {
  // an audit is read-only, so any buyer can audit any wallet; the demo world has two funded wallets
  const job = await requestQuotes([T], { wallet: buyer === 'carol.testnet' || buyer === 'erin.testnet' ? 'carol.testnet' : 'bob.testnet' }, runner.onchain, buyer);
  const q = job.quotes.find((x) => x.recipe_id === T);
  if (!q?.ok) throw new Error(`no quote from ${T}: ${q?.error}`);
  const r = await api<{ run_id: string; run_token: string }>('/api/runs/quote', { recipe_id: T, buyer, pay_asset: 'nep141:wrap.near', refund_to: buyer, sealed_inputs: job.sealed_job, signed_quote: signedQuote(q) });
  await api(`/api/runs/${r.run_id}/pay?token=${r.run_token}`, {});
  const res = await fetch(`${BASE}/api/runs/${r.run_id}/events?token=${r.run_token}`);
  const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i; let end = false;
    while ((i = buf.indexOf('\n\n')) >= 0) { const e = JSON.parse(buf.slice(6, i)); buf = buf.slice(i + 2); if (e.type === 'completed' || e.type === 'failed' || e.type === 'payment_rejected') end = true; }
    if (end) break;
  }
  await reader.cancel();
  return { price: BigInt(q.price), run_id: r.run_id };
}
/** wait until just after the current pricing period ends (the keeper applies it within a second) */
async function nextPeriod() { const r = await rec(); await sleep(Math.max(0, r.pricing.periodEndsMs - Date.now()) + 1500); }

let r0 = await rec();
say(`${T}: list price ${usd(units(r0.pricePerRun))}, band ${usd(units(r0.pricing.floor))}–${usd(units(r0.pricing.ceiling))}, target ${r0.pricing.targetRuns} paid runs per ${r0.pricing.periodS}-second period`);
await nextPeriod(); // start the busy period from a clean boundary
r0 = await rec();
const p0 = units(r0.pricePerRun);

say(`busy period: ${BUYERS.length} buyers each pay for an audit (twice the target)`);
const bought = await Promise.all(BUYERS.map(buy));
check(`every quote was signed at the list price ${usd(p0)}`, bought.every((b) => b.price === p0));
const mid = await rec();
check(`the contract counted ${mid.pricing.periodRuns} paid runs in this period`, mid.pricing.periodRuns === BUYERS.length);

await nextPeriod();
const p1 = units((await rec()).pricePerRun);
const want = p0 + (p0 * 2n * 1n) / (8n * 2n) > units(r0.pricing.ceiling) ? units(r0.pricing.ceiling) : p0 + p0 / 8n;
check(`after the busy period the price rose 12.5%: ${usd(p0)} → ${usd(p1)}`, p1 === want);
const ev = (await api<{ events: { event: string; data: any[] }[] }>('/api/chain/events?last=400')).events.filter((e) => e.event === 'price_updated' && e.data[0].recipe_id === T).at(-1);
check(`price_updated on-chain: runs ${ev?.data[0].runs}, previous ${usd(ev?.data[0].previous ?? 0)}, price ${usd(ev?.data[0].price ?? 0)}`, ev?.data[0].runs === String(BUYERS.length) && BigInt(ev?.data[0].price ?? 0) === p1);

const again = await buy('bob.testnet');
check(`the next quote locks the new price ${usd(p1)}`, again.price === p1);
const settled = (await api<{ settlements: { run_id: string; price: string; reserve: string; payouts: { amount: string }[] }[] }>(`/api/recipe/${T}`)).settlements.find((s) => s.run_id === again.run_id);
const total = settled ? settled.payouts.reduce((a, p) => a + BigInt(p.amount), 0n) + BigInt(settled.reserve) : -1n;
check(`settlement at the market price pays out exactly ${usd(p1)} (payouts + reserve)`, total === p1 && BigInt(settled!.price) === p1);

const cap = p0; // a buyer who won't pay more than the old price
const capped = await requestQuotes([T], { wallet: 'carol.testnet' }, runner.onchain, 'carol.testnet', cap);
const cq = capped.quotes.find((x) => x.recipe_id === T);
check(`with max price ${usd(cap)}, ${T} at ${usd(p1)} is not asked to quote ("${cq?.error}")`, !!cq && !cq.ok && /above your max price/.test(cq.error ?? ''));

say('idle: nobody buys for two periods');
await nextPeriod(); await nextPeriod();
const p3 = units((await rec()).pricePerRun);
check(`idle periods pulled the price down: ${usd(p1)} → ${usd(p3)} (floor ${usd(units(r0.pricing.floor))})`, p3 < p1 && p3 >= units(r0.pricing.floor));

const bad = checks.filter(([, ok]) => !ok);
console.log(bad.length ? `\n✘ ${bad.length} pricing check(s) failed` : `\n✔ market pricing: ${checks.length} checks passed`);
process.exit(bad.length ? 1 : 0);
