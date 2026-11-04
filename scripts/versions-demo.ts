/**
 * Versioned recipes with notice, against a running demo (`npm run demo`, or `npm run test:versions`).
 *
 * The creator of SWPR ships version 2 (tighter slippage). It is announced on-chain and takes effect only after the
 * notice period (FRS_UPDATE_DELAY_S, 30 s in the demo; 24 h suggested on mainnet), so buyers and shareholders see
 * it coming. The script checks that:
 *   - an announcement can be cancelled, and a new one scheduled;
 *   - during the notice period, quotes and runs use version 1;
 *   - after it, the keeper activates version 2 (`recipe_updated`, version counter 2);
 *   - a quote signed for version 1 is now rejected, and the buyer is refunded in full;
 *   - a run paid during the notice period keeps version 1 even when it only finishes after version 2 is live:
 *     the script holds the wallet approval until version 2 activates, kills the runner, and the resumed run
 *     fetches version 1 from the vault and completes with it;
 *   - fresh quotes are signed for version 2.
 */
import { readFileSync } from 'node:fs';
import { open, seal, sealedHash, USDC_NEAR, type Recipe, type SealedEnvelope } from '../core/src/index.js';
import { api, BASE, freshImplicitAccount, verifiedRunner, postJob, signedQuote } from './lib/client.js';

const BUYER = 'carol.testnet';
const T = 'SWPR';
const say = (s: string) => console.log(`[versions] ${s}`);
const short = (h: string) => h.slice(0, 12) + '…';
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

const runner = await verifiedRunner();
const v1 = (await api<{ current: string; version: number }>(`/api/vault/${T}/versions`));
say(`${T} is at version ${v1.version} (${short(v1.current)})`);

const recipe = JSON.parse(readFileSync(new URL(`../seed/recipes/${T}.json`, import.meta.url), 'utf8')) as Recipe;
const swap = recipe.nodes.find((n) => n.part.startsWith('intents.'))!;
swap.params = { ...swap.params, slippage_bps: 80 };
const sealed = seal(recipe, runner.onchain.enc_pk_hex, 'recipe');
const creator = recipe.meta.creator;

const first = await api<any>(`/api/recipes/${T}/update`, { signer: creator, sealed: seal({ ...recipe, meta: { ...recipe.meta, description: 'draft' } }, runner.onchain.enc_pk_hex, 'recipe') });
say(`announced a draft as version ${first.version}; cancelling it`);
await api(`/api/recipes/${T}/cancel-update`, { signer: creator });
const sched = await api<any>(`/api/recipes/${T}/update`, { signer: creator, sealed });
const waitS = Math.ceil((Number(BigInt(sched.effective_ns) / 1_000_000n) - Date.now()) / 1000);
say(`announced version ${sched.version} (${short(sched.sealed_hash)}): takes effect in ${waitS} s (recipe_update_scheduled, tx ${short(sched.tx)})`);

// during the notice period: quote + run use version 1
const job = () => postJob('job.wallet-cleanup@1.0.0', { wallet: BUYER, threshold_usd: 30, target: USDC_NEAR, recipient: freshImplicitAccount().account }, runner.onchain, BUYER, T);
const pay = async (j: Awaited<ReturnType<typeof job>>, q: any) => {
  const r = await api<{ run_id: string; run_token: string }>('/api/runs/quote', { recipe_id: T, buyer: BUYER, pay_asset: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', refund_to: '0xC0c0000000000000000000000000000000000001', sealed_inputs: j.sealed_job, signed_quote: signedQuote(q) });
  await api(`/api/runs/${r.run_id}/pay?token=${r.run_token}`, {});
  return r;
};
const follow = async (r: { run_id: string; run_token: string }, reply?: { secretKey: Uint8Array }, onApproval?: (n: number, txs: unknown[]) => Promise<boolean | null>) => {
  const res = await fetch(`${BASE}/api/runs/${r.run_id}/events?token=${r.run_token}`);
  const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = ''; let approvals = 0;
  for (;;) {
    const { value, done } = await reader.read(); if (done) return null;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      let e = JSON.parse(buf.slice(6, i)); buf = buf.slice(i + 2);
      if (e.type === 'sealed' && reply) e = { ...e, ...open<{ type: string; data: any }>(e.data.envelope as SealedEnvelope, reply.secretKey) };
      if (e.type === 'approval_required') {
        const ok = onApproval ? await onApproval(++approvals, e.data.transactions) : false;
        if (ok !== null) await api(`/api/runs/${r.run_id}/approve?token=${r.run_token}`, { approved: ok, transactions: ok ? e.data.transactions : [] });
      }
      if (['completed', 'failed', 'payment_rejected', 'run_refunded'].includes(e.type)) { await reader.cancel(); return e; }
    }
  }
};
const early = await job();
const qEarly = early.quotes.find((x) => x.ok)!;
say(`quote during the notice period is signed for ${short(qEarly.sealed_hash)} (version 1)`);
const keep = await job();
const runEarly = await pay(keep, keep.quotes.find((x) => x.ok)!);
say(`paid run ${runEarly.run_id} during the notice period; holding its wallet approval until version 2 is live`);
const earlyEnd = await follow(runEarly, keep.reply, async (n) => {
  if (n > 1) { say('the resumed run (executing version 1) asks for the same deposits again; approving now'); return true; }
  for (;;) { const v = await api<{ version: number }>(`/api/vault/${T}/versions`); if (v.version === 2) break; await sleep(1000); }
  say('version 2 is live; killing the runner so the run must reload its recipe from the vault');
  await api('/api/dev/crash-runner', {});
  return null; // not answered: the resumed runner asks again
});
const chainEarly = await api<any>(`/api/chain/runs/${runEarly.run_id}`);
say(`run ${runEarly.run_id}: ${chainEarly.status}, executed version ${short(chainEarly.sealed_hash)} after version 2 took effect`);
const v2 = await api<{ current: string; version: number; stored: string[] }>(`/api/vault/${T}/versions`);
say(`keeper activated version ${v2.version} (${short(v2.current)}); vault keeps ${v2.stored.length} versions`);

const stale = await pay(early, qEarly);
const rejected = await follow(stale);
say(`paying with the version-1 quote: ${rejected?.type} (${rejected?.data?.error})`);

const fresh = await job();
const q2 = fresh.quotes.find((x) => x.ok)!;
say(`fresh quote is signed for ${short(q2.sealed_hash)}`);

const checks: [string, boolean][] = [
  ['the update took effect only after the notice period, as version 2', v2.version === v1.version + 1 && v2.current === sealedHash(sealed)],
  ['the quote and the run during the notice period used version 1', qEarly.sealed_hash === v1.current && chainEarly.sealed_hash === v1.current],
  ['that run finished after version 2 went live, resumed from the vault\'s version 1, and settled', earlyEnd?.type === 'completed' && earlyEnd.data.ok && chainEarly.status === 'Settled' && v2.stored.includes(v1.current)],
  ['a quote for version 1 is rejected after activation, buyer refunded', rejected?.type === 'payment_rejected' && /outdated recipe version/.test(rejected.data.error)],
  ['new quotes are for version 2', q2.sealed_hash === v2.current],
];
for (const [label, ok] of checks) say(`${ok ? '✔' : '✘'} ${label}`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
