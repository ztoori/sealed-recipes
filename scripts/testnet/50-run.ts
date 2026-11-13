/**
 * A real paid run on testnet, end to end:  node --import tsx scripts/testnet/50-run.ts [--recipe CHEK] [--target wrap.near]
 *
 *  1. publishes the recipe if it isn't on the contract yet: sealed here to the registered runner, publish_recipe
 *     signed with the creator's key, then the ciphertext handed to the live marketplace (which checks the on-chain hash);
 *  2. mints a little tUSDC to the buyer from the faucet account;
 *  3. gets a quote: inputs sealed here to the runner, the quote sealed back and its runner signature verified here;
 *  4. pays: ft_transfer_call(tUSDC → contract, price, msg) signed with the buyer's key;
 *  5. follows the run until the runner's signed report is settled on-chain, and prints the result (opened with the
 *     one-time key) and explorer links.
 *
 * Keys: near-cli files in ~/.near-credentials/testnet/ (CREATOR, BUYER, FAUCET). Marketplace: SRS_URL (http://127.0.0.1:8081).
 * Target: a public mainnet account the recipe reads (default wrap.near). Spends testnet NEAR gas and test tUSDC only.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Account, JsonRpcProvider } from 'near-api-js';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const NETWORK = process.env.NETWORK ?? 'testnet';
const ROOT_ACCOUNT = process.env.ROOT_ACCOUNT ?? 'sealedrecipes.testnet';
const CREATOR = process.env.CREATOR ?? ROOT_ACCOUNT;
const BUYER = process.env.BUYER ?? ROOT_ACCOUNT;
const FAUCET = process.env.FAUCET ?? `faucet.${ROOT_ACCOUNT}`;
const RPC = process.env.NEAR_RPC_URL ?? 'https://rpc.testnet.fastnear.com';
process.env.SRS_URL ??= 'http://127.0.0.1:8081';
const SEED = arg('recipe', 'CHEK');
/** publish a seed recipe under another ticker (a published recipe's parts are fixed; a new part version needs a new listing) */
const RECIPE = arg('ticker', SEED);
const TARGET = arg('target', 'wrap.near');
const explorer = (tx: string) => `https://testnet.nearblocks.io/txns/${tx}`;
const usd = (u: string | bigint) => `${(Number(u) / 1e6).toFixed(4)} tUSDC`;

const root = fileURLToPath(new URL('../..', import.meta.url));
const { api, verifiedRunner, requestQuotes, signedQuote, creatorCopy } = await import('../lib/client.js');
const { seal, open, sealedHash, publicListing, validateRecipe } = await import('../../core/src/index.js');
const { loadCatalog } = await import('../../core/src/codehash.js');
const catalog = loadCatalog(root);

const provider = new JsonRpcProvider({ url: RPC });
const accountOf = (id: string) => {
  const k = JSON.parse(readFileSync(join(homedir(), '.near-credentials', NETWORK, `${id}.json`), 'utf8')) as { private_key: string };
  return new Account(id, provider, k.private_key as `ed25519:${string}`);
};
const call = async (who: Account, contractId: string, methodName: string, args: object, depositYocto = 0n, tgas = 100) => {
  const r = await who.callFunctionRaw({ contractId, methodName, args, deposit: depositYocto, gas: BigInt(tgas) * 10n ** 12n, waitUntil: 'EXECUTED_OPTIMISTIC' }) as unknown as { transaction: { hash: string }; receipts_outcome: { outcome: { status: unknown; logs: string[] } }[] };
  const failed = r.receipts_outcome.map((o) => o.outcome.status as Record<string, unknown>).find((s) => s && 'Failure' in s);
  if (failed) throw new Error(`${methodName} failed (${explorer(r.transaction.hash)}): ${JSON.stringify(failed.Failure)}`);
  return r.transaction.hash;
};
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);

const mode = await api<{ mode: string; contract_id: string; payment_token: string; runner_id: string }>('/api/mode');
console.log(`marketplace ${process.env.SRS_URL}: ${mode.contract_id} on ${mode.mode}, payment token ${mode.payment_token}, runner ${mode.runner_id}`);
const runner = await verifiedRunner();
console.log(`runner attestation: ${runner.checks.filter((c) => c.status === 'pass').length} checks passed (${runner.hardware ? 'hardware TEE, Intel chain verified' : runner.attestation.tee === 'dstack-tdx' && runner.attestation.quote ? 'Intel TDX quote bound to the runner keys; Intel chain checked at registration' : 'local-dev: no hardware quote'})`);

// 1. publish
// Sealing is randomized, so the exact sealed copy the contract commits to is saved here before publishing: if the
// hand-over to the marketplace fails, a rerun hands over the same copy. A recipe that is on-chain without a copy
// anywhere is re-sealed and its new version announced (update_sealed), applied after the notice period, handed over.
step(`1. ${RECIPE}: published on the contract?`);
const saveDir = join(homedir(), '.srs-publish');
mkdirSync(saveDir, { recursive: true, mode: 0o700 });
const savedPath = (h: string) => join(saveDir, `${RECIPE}-${h}.json`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const handOver = async (saved: { listing: unknown; sealed: unknown; creator_copy: unknown }, tx?: string) => {
  for (let i = 0; ; i++) {
    try { await api('/api/publish', { ...saved, tx }); return; }
    catch (e) { if (i >= 12 || !/not published|does not match/.test((e as Error).message)) throw e; await sleep(5000); }
  }
};
const fresh = () => {
  const recipe = JSON.parse(readFileSync(join(root, 'seed/recipes', `${SEED}.json`), 'utf8'));
  recipe.meta.creator = CREATOR;
  recipe.meta.ticker = RECIPE;
  const v = validateRecipe(recipe, catalog);
  if (!v.ok) throw new Error('invalid recipe: ' + JSON.stringify(v.diagnostics));
  const sealed = seal(recipe, runner.onchain.enc_pk_hex, 'recipe');
  const saved = { listing: publicListing(recipe, catalog), sealed, creator_copy: creatorCopy(recipe) };
  writeFileSync(savedPath(sealedHash(sealed)), JSON.stringify(saved), { mode: 0o600 });
  return { recipe, saved, hash: sealedHash(sealed) };
};
type OnchainRecipe = { sealed_hash: string; pending_sealed_hash?: string; update_effective_ns?: string };
const onchain = await api<OnchainRecipe>(`/api/chain/recipes/${RECIPE}`).catch(() => null);
const listed = (await api<{ ticker: string }[]>('/api/listings')).some((l) => l.ticker === RECIPE);
if (onchain && listed) console.log(`   yes (sealed_hash ${onchain.sealed_hash.slice(0, 16)}…)`);
else if (!onchain) {
  const { recipe, saved, hash } = fresh();
  const listing = saved.listing as { ticker: string; name: string; parts: string[]; price_per_run: string; reserve_bps?: number; pricing?: unknown };
  const tx = await call(accountOf(CREATOR), mode.contract_id, 'publish_recipe', {
    id: listing.ticker, name: listing.name, sealed_hash: hash, runner_id: mode.runner_id, parts: listing.parts,
    price_per_run: listing.price_per_run, reserve_bps: listing.reserve_bps ?? 0, pricing: listing.pricing ?? null, settle_mode: recipe.listing.settle_mode ?? 'final',
  }, 100_000_000_000_000_000_000_000n /* 0.1 NEAR for storage; the rest is refunded */);
  console.log(`   publish_recipe by ${CREATOR}: ${explorer(tx)}`);
  await handOver(saved, tx);
  console.log('   sealed recipe handed to the marketplace (it checked the on-chain hash; it never saw the plaintext)');
} else if (existsSync(savedPath(onchain.sealed_hash))) {
  await handOver(JSON.parse(readFileSync(savedPath(onchain.sealed_hash), 'utf8')));
  console.log('   on-chain already; handed the saved sealed copy to the marketplace');
} else {
  console.log('   on-chain, but no sealed copy matches it here: announcing a re-sealed version (update_sealed)');
  const { saved, hash } = fresh();
  const tx = await call(accountOf(CREATOR), mode.contract_id, 'update_sealed', { id: RECIPE, sealed_hash: hash });
  console.log(`   update_sealed: ${explorer(tx)}`);
  for (;;) {
    const r = await api<OnchainRecipe>(`/api/chain/recipes/${RECIPE}`);
    if (r.sealed_hash === hash) break;
    const wait = Math.max(0, Number(BigInt(r.update_effective_ns ?? '0') / 1_000_000n) - Date.now());
    if (wait > 0) { console.log(`   notice period: ${Math.ceil(wait / 1000)} s`); await sleep(wait + 2000); continue; }
    try { const t = await call(accountOf(CREATOR), mode.contract_id, 'apply_update', { id: RECIPE }); console.log(`   apply_update: ${explorer(t)}`); }
    catch (e) { if (!/update not due/.test((e as Error).message)) throw e; /* already applied, or the block clock is a little behind */ }
    await sleep(3000);
  }
  await handOver(saved, tx);
  console.log('   new sealed version handed to the marketplace');
}

// 2. tUSDC for the buyer
step(`2. tUSDC for the buyer ${BUYER}`);
const bal = BigInt(await provider.callFunction({ contractId: mode.payment_token, method: 'ft_balance_of', args: { account_id: BUYER } }) as string);
if (bal < 2_000_000n) {
  const tx = await call(accountOf(FAUCET), mode.payment_token, 'mint', { account_id: BUYER, amount: '5000000' }, 12_500_000_000_000_000_000n);
  console.log(`   faucet minted 5 tUSDC: ${explorer(tx)}`);
} else console.log(`   balance ${usd(bal)}`);

// 3. quote
step(`3. sealed quote from ${RECIPE} on target ${TARGET} (a public mainnet account)`);
const form = JSON.parse(readFileSync(join(root, 'seed/recipes', `${SEED}.json`), 'utf8')).form as { id: string; type: string }[];
const inputs = Object.fromEntries(form.filter((f) => f.type === 'near.account').map((f) => [f.id, TARGET]));
const job = await requestQuotes([RECIPE], inputs, runner.onchain, BUYER);
const q = job.quotes[0];
if (!q.ok) throw new Error(`no quote: ${q.error}`);
console.log(`   price ${usd(q.price)}, signed by the runner and verified here; inputs stayed sealed`);

// 4. pay
step('4. pay: ft_transfer_call(tUSDC → contract) signed by the buyer');
const ticket = await api<{ run_id: string; run_token: string; pay: { contract: string; method: string; args: object; deposit_yocto: string; gas_tgas: number } }>('/api/runs/prepare', { recipe_id: RECIPE, buyer: BUYER, sealed_inputs: job.sealed_job, signed_quote: signedQuote(q) });
const payTx = await call(accountOf(BUYER), ticket.pay.contract, ticket.pay.method, ticket.pay.args, BigInt(ticket.pay.deposit_yocto), ticket.pay.gas_tgas);
console.log(`   paid: ${explorer(payTx)}`);
console.log(`   run ${ticket.run_id}, ticket token ${ticket.run_token} (keep it to resume: POST /api/runs/${ticket.run_id}/resume?token=…)`);
await api(`/api/runs/${ticket.run_id}/paid?token=${ticket.run_token}`, { tx_hash: payTx });

// 5. follow
step(`5. run ${ticket.run_id}`);
const res = await fetch(`${process.env.SRS_URL}/api/runs/${ticket.run_id}/events?token=${ticket.run_token}`);
const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = ''; let result: unknown; let ok = false;
for (let done = false; !done;) {
  const { value, done: end } = await reader.read(); if (end) break;
  buf += dec.decode(value, { stream: true });
  for (let i; (i = buf.indexOf('\n\n')) >= 0;) {
    let e = JSON.parse(buf.slice(6, i)); buf = buf.slice(i + 2);
    if (e.type === 'sealed') {
      e = { ...e, ...open<{ type: string; data: unknown }>(e.data.envelope, job.reply.secretKey) };
      if (e.type === 'result') result = e.data;
      if (e.type === 'failure_detail') console.log(`   (sealed to you) why it failed: ${(e.data as { error: string }).error}`);
      continue;
    }
    const d = e.data ?? {};
    console.log(`   ${e.source.padEnd(6)} ${e.type}${d.url ? `  ${d.url}` : ''}${d.error ? `  ${d.error}` : ''}`);
    if (e.type === 'completed') { ok = !!d.ok; done = true; break; }
    if (['failed', 'payment_failed', 'run_not_pending', 'payment_timeout'].includes(e.type)) { done = true; break; }
  }
}
await reader.cancel().catch(() => {});
step(ok ? '✔ run settled on-chain' : '✘ run did not complete');
if (result) console.log(JSON.stringify(result, null, 1).slice(0, 2000));
await sleep(4000); // the track record is read from final blocks, a few seconds behind the settlement
const r = await api<{ runs: string; revenue: string }>(`/api/chain/recipes/${RECIPE}`);
console.log(`\n${RECIPE} on-chain track record: ${r.runs} run(s), revenue ${usd(r.revenue)}`);
process.exit(ok ? 0 : 1);
