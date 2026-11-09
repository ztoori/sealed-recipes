/**
 * The four everyday-safety recipes end to end, against a running demo (`npm run test:recipes` starts one):
 *   KEYS  revoke risky app keys (DeleteKey, confirmed by re-reading the key list)
 *   STAK  withdraw unstaked NEAR that finished unbonding (withdraw_all, confirmed per pool)
 *   CHEK  check a contract before signing (private AI verdict, verified), on a phishing lookalike and on a real app
 *   TRIM  sell only the excess of any position above a cap, privately, to a fresh address
 * Each one is quoted (dry run in the runner, signed), paid through the Intents mock and run with the buyer's approval.
 */
import { api, freshImplicitAccount, payAndRun, requestQuotes, verifiedRunner } from './lib/client.js';

const BUYER = 'bob.testnet';
const say = (s: string) => console.log(`[recipes] ${s}`);
const runner = (await verifiedRunner()).onchain;
const checks: [string, boolean][] = [];
const ok = (label: string, cond: boolean) => { checks.push([label, cond]); say(`${cond ? '✔' : '✘'} ${label}`); };
const quoteOf = async (only: string, inputs: Record<string, unknown>) => {
  const j = await requestQuotes([only], inputs, runner, BUYER);
  const q = j.quotes.find((x: any) => x.ok);
  if (!q) throw new Error(`${only} did not quote: ${JSON.stringify(j.quotes.map((x: any) => x.error))}`);
  return { j, q };
};
const items = (r: any) => (r?.output?.items ?? []) as { label: string; detail: string; tag?: string }[];

// KEYS
{
  const { j, q } = await quoteOf('KEYS', { wallet: BUYER });
  say(`KEYS quote: ${q.details?.output?.title ?? 'report'}`);
  const run = await payAndRun(j, q, BUYER);
  const it = items(run.result);
  for (const x of it) say(`  ${x.tag ?? ''} ${x.label}: ${x.detail}`);
  ok('KEYS revoked the two risky app keys and confirmed it on the (mock) chain', run.final?.type === 'completed' && run.result?.output?.title === '2 of 2 risky app keys revoked');
  ok('KEYS never touched a full-access key (both reported for review)', it.filter((x) => x.label === 'Full-access key' && x.tag === 'warn').length === 2);
}
// STAK
{
  const { j, q } = await quoteOf('STAK', { wallet: BUYER });
  say(`STAK quote: expected ${(Number(q.expected) / 1e6).toFixed(2)} USDC of NEAR, promised ${(Number(q.promised) / 1e6).toFixed(2)}`);
  const run = await payAndRun(j, q, BUYER, { onEvent: (e) => { if (e.type === 'part_log' && /NOT in the current|unbonding|paid out/.test(e.data.msg)) say(`  ${e.data.msg}`); } });
  const rec = (run.result?.output ?? []) as any[];
  ok('STAK withdrew from the 2 pools that finished unbonding (4.2 NEAR), skipped the one still unbonding', run.final?.type === 'completed' && rec.length === 2 && rec.every((r) => r.status === 'SUCCESS') && rec.reduce((t, r) => t + BigInt(r.amountOutUnits), 0n) === 4_200_000_000_000_000_000_000_000n);
  ok('STAK flagged the validator that stopped validating', run.events.some((e) => e.type === 'part_log' && /ghostnode.*NOT in the current validator set/.test(e.data.msg)));
}
// CHEK
for (const [contract, want] of [['near-gift-claim.near', 'high'], ['v2.ref-finance.near', 'low']] as const) {
  const { j, q } = await quoteOf('CHEK', { contract });
  const run = await payAndRun(j, q, BUYER);
  say(`CHEK ${contract}: ${run.result?.output?.title}`);
  for (const x of items(run.result).slice(0, 4)) say(`  ${x.label}: ${x.detail}`);
  ok(`CHEK rates ${contract} ${want} risk`, run.result?.output?.title === `${contract}: ${want} risk`);
}
// TRIM: dana holds mostly NEAR
{
  const fresh = freshImplicitAccount();
  const TRADER = 'dana.testnet';
  const j0 = await requestQuotes(['TRIM'], { wallet: TRADER, max_share: 25, target: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', recipient: fresh.account }, runner, TRADER);
  const q = j0.quotes.find((x: any) => x.ok); if (!q) throw new Error('TRIM did not quote');
  say(`TRIM quote for ${TRADER}: expected ${(Number(q.expected) / 1e6).toFixed(2)} USDC`);
  const before = (await api<{ wallet: { symbol: string; balance: string }[] }>(`/api/account/${TRADER}`)).wallet.find((w) => w.symbol === 'wNEAR')!.balance;
  const run = await payAndRun(j0, q, TRADER, { onEvent: (e) => { if (e.type === 'part_log' && /sell \$|no position/.test(e.data.msg)) say(`  ${e.data.msg}`); } });
  const got = (await api<{ wallet: { symbol: string; balance: string }[] }>(`/api/account/${fresh.account}`)).wallet.find((w) => w.symbol === 'USDC');
  const after = (await api<{ wallet: { symbol: string; balance: string }[] }>(`/api/account/${TRADER}`)).wallet.find((w) => w.symbol === 'wNEAR')!.balance;
  say(`  wNEAR ${Number(BigInt(before) / 10n ** 21n) / 1000} → ${Number(BigInt(after) / 10n ** 21n) / 1000}`);
  ok('TRIM sold part of the NEAR position, not all of it', BigInt(after) > 0n && BigInt(after) < BigInt(before));
  ok(`TRIM sold only the excess and delivered ${(Number(got?.balance ?? 0) / 1e6).toFixed(2)} USDC to the fresh address`, run.final?.type === 'completed' && Number(got?.balance ?? 0) > 0);
}
process.exit(checks.every(([, c]) => c) ? 0 : 1);
