/**
 * An autonomous buyer: an agent asks the recipes it shortlisted for quotes on one set of sealed inputs, compares
 * them against its policy, pays the winner, and checks what it got against what the runner signed. No human in the loop.
 *
 *   npm run agent                     against the local demo (`npm run demo` running): pays through the 1Click mock,
 *                                     approves the deposits its policy allows, checks delivery against the signed promise
 *   npm run agent -- --live           against the live marketplace on NEAR testnet (https://sealedrecipes.xyz):
 *                                     its own guest key, funded once by the testnet faucet, signs ft_transfer_call to the
 *                                     contract; real runner, real NEAR AI Cloud, real mainnet data (read-only)
 *
 *   npx tsx scripts/agent-buyer.ts [--live] [TICKER,TICKER,…] [policy-json] [--contract id] [--wallet id] [--target id] [--inputs json] [--account id]
 *
 * Live options (the recipes only read public mainnet data):
 *   --contract  the contract a contract recipe checks (default v2.ref-finance.near)
 *   --wallet    the account a wallet recipe audits (default social.near: a few tokens, one full-access key; the
 *               wallet parts have per-run time limits, so an account holding thousands of tokens cannot be quoted)
 *   --target    one account for every field (sets both of the above)
 *   --inputs    JSON for any other form field, e.g. '{"wallet":"aurora"}'
 *   --account   pay from a named testnet account (its near-cli key in ~/.near-credentials/testnet/) instead of the guest
 *   SRS_URL     another marketplace (default https://sealedrecipes.xyz); SRS_AGENT_KEY  where the guest key is kept
 *               (default .data/agent-guest.json, git-ignored, so later runs reuse the account the faucet funded)
 * Live spends testnet NEAR gas and test tUSDC only.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { open, hashObject, base64, USDC_NEAR, type SealedEnvelope } from '../core/src/index.js';

// ---- arguments: flags anywhere, then the optional shortlist and policy as before ----
const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--target', '--contract', '--wallet', '--inputs', '--account']);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const positional = argv.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(argv[i - 1]));
const LIVE = argv.includes('--live');
if (LIVE) process.env.SRS_URL ??= 'https://sealedrecipes.xyz'; // read by lib/client.ts when it loads, so set it first

const { api, BASE, freshImplicitAccount, verifiedRunner, requestQuotes, pickQuote, signedQuote } = await import('./lib/client.js');

type Policy = { requirePrivacy?: 'confidential'; maxRisk?: 'low' | 'medium' | 'high'; sort: 'net' | 'value' | 'price'; maxPriceUsd: number; maxApprovalUsd?: number };
type Field = { id: string; type: string; required?: boolean; default?: unknown; options?: string[] };
type Listing = { ticker: string; form: Field[] };

// the live recipes are read-only reports (privacy n/a, nothing to approve), so the live policy caps price and risk only
const DEFAULT_POLICY = LIVE
  ? '{"maxRisk":"medium","sort":"price","maxPriceUsd":0.25}'
  : '{"requirePrivacy":"confidential","maxRisk":"medium","sort":"net","maxPriceUsd":1,"maxApprovalUsd":100}';
const shortlist = (positional[0] ?? (LIVE ? '' : 'CLNP,SWPR')).split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
const policy = JSON.parse(positional[1] ?? DEFAULT_POLICY) as Policy;
const cap = BigInt(Math.round(policy.maxPriceUsd * 1e6));
const CONTRACT = opt('contract') ?? opt('target') ?? 'v2.ref-finance.near';
const WALLET = opt('wallet') ?? opt('target') ?? 'social.near';
const usd = (u: string | number | bigint) => '$' + (Number(u) / 1e6).toFixed(4);
const say = (s: string) => console.log(`[agent] ${s}`);
const root = fileURLToPath(new URL('..', import.meta.url));

say(`marketplace ${BASE}${LIVE ? ' (live, NEAR testnet)' : ' (demo)'}`);
const runner = await verifiedRunner();
const att = runner.attestation as { tee?: string; quote?: string };
say(`runner attestation verified against its on-chain keys: ${runner.checks.filter((c) => c.status === 'pass').length} checks passed (${runner.hardware ? 'hardware TEE' : att.tee === 'dstack-tdx' && att.quote ? 'Intel TDX quote bound to the runner keys' : 'no hardware quote'})`);

// ---- who pays ----
const me = LIVE ? await liveAccount() : { id: 'carol.testnet', secretKey: '' as `ed25519:${string}`, guest: false };
if (LIVE) say(`buying as ${me.guest ? 'guest ' : ''}${me.id}`);

// ---- one sealed request answers every shortlisted recipe's form: the union of the fields they ask for ----
const fresh = freshImplicitAccount();
const demoValues: Record<string, unknown> = { wallet: 'carol.testnet', threshold_usd: 30, target: USDC_NEAR, recipient: fresh.account };
const given: Record<string, unknown> = JSON.parse(opt('inputs') ?? '{}');
const valueFor = (f: Field) => given[f.id] ?? (LIVE ? (f.type === 'near.account' ? (/contract/i.test(f.id) ? CONTRACT : WALLET) : f.default ?? f.options?.[0]) : demoValues[f.id]);
const listed = await api<Listing[]>('/api/listings');
let listings = listed.filter((l) => !shortlist.length || shortlist.includes(l.ticker));
if (!listings.length) { say(`none of ${shortlist.join(', ') || 'the recipes'} is listed (listed: ${listed.map((l) => l.ticker).join(', ')})`); process.exit(0); }
for (const l of listings) { const miss = l.form.filter((f) => f.required && valueFor(f) == null); if (miss.length) say(`skipping ${l.ticker}: no value for ${miss.map((f) => f.id).join(', ')} (pass --inputs)`); }
listings = listings.filter((l) => l.form.every((f) => !f.required || valueFor(f) != null));
const inputs = Object.fromEntries([...new Map(listings.flatMap((l) => l.form.map((f) => [f.id, valueFor(f)] as const)))]);
say(`shortlist ${listings.map((l) => l.ticker).join(', ')}; sealed inputs: ${Object.entries(inputs).map(([k, v]) => LIVE ? `${k}=${v}` : k).join(', ')}`);

// the agent's budget travels with the request: recipes listed above it are not even asked to quote (demo), and the
// run msg carries it as max_price, so the contract refuses to charge more (live)
// live: one recipe at a time, so their dry runs don't queue behind each other at the runner's outbound limits
const job = await requestQuotes(listings.map((l) => l.ticker), inputs, runner.onchain, me.id, cap, { oneAtATime: LIVE });
const order: Record<string, number> = { low: 0, medium: 1, high: 2 };
const priceOf = (q: any) => BigInt(q.price ?? q.listing.price_per_run);
const why = (q: any) => !q.ok ? 'failed: ' + q.error : priceOf(q) > cap ? `over my price cap ${usd(cap)}` : policy.requirePrivacy && q.listing.privacy !== policy.requirePrivacy ? `privacy ${q.listing.privacy}, I require ${policy.requirePrivacy}` : policy.maxRisk && order[q.listing.risk] > order[policy.maxRisk] ? `risk ${q.listing.risk} above ${policy.maxRisk}` : '';
for (const q of job.quotes) {
  const w = why(q);
  say(`quote ${q.listing.ticker}: ${q.ok ? `price ${usd(priceOf(q))}, expects ${usd(q.expected)}, promises ${usd(q.promised)}, ${q.listing.privacy}, risk ${q.listing.risk}${q.track ? `, ${q.track.runs} runs on-chain` : ''}, signature verified` : ''}${w ? (q.ok ? ' → excluded: ' : '') + w : ''}`);
}
const pick = pickQuote(job.quotes.filter((q: any) => !why(q)), policy);
if (!pick) { say('no quote meets my policy; not buying'); process.exit(0); }
say(`policy (${policy.sort}) picks ${pick.listing.ticker} at ${usd(priceOf(pick))}`);

if (LIVE) await buyLive(pick); else await buyDemo(pick);

// ============================================================================================================

/** the server's event stream for a run, sealed events opened with the one-time reply key; stops at a final event */
async function follow(runId: string, token: string, onEvent: (e: any) => Promise<void> | void) {
  const FINAL = new Set(['completed', 'failed', 'payment_failed', 'run_not_pending', 'payment_timeout']);
  const res = await fetch(`${BASE}/api/runs/${runId}/events`, { headers: { 'x-run-token': token } });
  if (!res.ok || !res.body) throw new Error(`events for ${runId}: ${res.status}`);
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (let done = false; !done;) {
    const { value, done: end } = await reader.read(); if (end) break;
    buf += dec.decode(value, { stream: true });
    for (let i; (i = buf.indexOf('\n\n')) >= 0;) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      if (!chunk.startsWith('data: ')) continue;
      let e = JSON.parse(chunk.slice(6));
      if (e.type === 'sealed') e = { ...e, ...open(e.data.envelope as SealedEnvelope, job.reply.secretKey), sealed: true };
      await onEvent(e);
      if (FINAL.has(e.type)) { done = true; break; }
    }
  }
  await reader.cancel().catch(() => {});
}

/** demo: pay through the 1Click mock, approve deposits within the approval cap, compare delivery with the promise */
async function buyDemo(q: any) {
  const r = await api<{ run_id: string; run_token: string }>('/api/runs/quote', { recipe_id: q.listing.ticker, buyer: me.id, pay_asset: 'nep141:wrap.near', refund_to: me.id, sealed_inputs: job.sealed_job, signed_quote: signedQuote(q) });
  await api(`/api/runs/${r.run_id}/pay`, {}, { 'x-run-token': r.run_token });
  let result: any; let settled: any;
  await follow(r.run_id, r.run_token, async (e) => {
    if (e.type === 'approval_required') {
      const total = e.data.summary.reduce((s: number, x: { usd: number }) => s + x.usd, 0);
      const ok = total <= (policy.maxApprovalUsd ?? 0);
      say(`wallet request: ${e.data.transactions.length} transfers worth $${total.toFixed(2)} → ${ok ? 'approve' : 'reject (over my limit)'}`);
      await api(`/api/runs/${r.run_id}/approve`, { approved: ok, transactions: ok ? e.data.transactions : [] }, { 'x-run-token': r.run_token });
    }
    if (e.type === 'result') result = e.data;
    if (e.type === 'srs_settlement') settled = e.data;
  });
  if (!result?.ok) { say('run failed and was refunded: ' + result?.error); process.exit(1); }
  say(`delivered ${usd(settled.delivered)} vs promised ${usd(q.promised)}; compensation ${usd(settled.compensation)}; done`);
}

/** live: fund if needed, sign ft_transfer_call with the agent's key, follow the run, check the signed report */
async function buyLive(q: any) {
  const mode = await api<{ contract_id: string; rpc_url: string; payment_token: string; faucet: boolean }>('/api/mode');
  await ensureFunds(priceOf(q), mode.faucet);

  const ticket = await api<{ run_id: string; run_token: string; pay: { contract: string; method: string; args: object; deposit_yocto: string; gas_tgas: number } }>('/api/runs/prepare',
    { recipe_id: q.listing.ticker, buyer: me.id, sealed_inputs: job.sealed_job, signed_quote: signedQuote(q), max_price: cap.toString() });
  const keep = join(root, '.data', 'agent-runs.json'); // the run token resumes a run that stops (POST /api/runs/:id/resume)
  const kept = existsSync(keep) ? JSON.parse(readFileSync(keep, 'utf8')) : [];
  writeFileSync(keep, JSON.stringify([{ run_id: ticket.run_id, token: ticket.run_token, recipe_id: q.listing.ticker, buyer: me.id, at: new Date().toISOString() }, ...kept].slice(0, 50), null, 1), { mode: 0o600 });

  const { Account, JsonRpcProvider } = await import('near-api-js');
  const acct = new Account(me.id, new JsonRpcProvider({ url: mode.rpc_url }), me.secretKey);
  const out = await acct.callFunctionRaw({ contractId: ticket.pay.contract, methodName: ticket.pay.method, args: ticket.pay.args, deposit: BigInt(ticket.pay.deposit_yocto), gas: BigInt(ticket.pay.gas_tgas) * 10n ** 12n, waitUntil: 'EXECUTED_OPTIMISTIC' }) as unknown as { transaction: { hash: string }; receipts_outcome: { outcome: { status: unknown } }[] };
  const payTx = out.transaction.hash;
  const failure = out.receipts_outcome.map((o) => o.outcome.status as Record<string, unknown>).find((s) => s && 'Failure' in s);
  if (failure) { say(`payment failed: ${explorer(payTx)} ${JSON.stringify(failure.Failure)}`); process.exit(1); }
  say(`paid ${usd(priceOf(q))} tUSDC with ft_transfer_call: ${explorer(payTx)}`);
  say(`run ${ticket.run_id} (token saved in .data/agent-runs.json)`);
  await api(`/api/runs/${ticket.run_id}/paid`, { tx_hash: payTx }, { 'x-run-token': ticket.run_token });

  let result: any; let signed: { message: string; signature: string } | undefined; let completed: any; let last = '';
  await follow(ticket.run_id, ticket.run_token, (e) => {
    if (e.type === 'result') { result = e.data; return; }
    if (e.type === 'failure_detail') { say(`why it failed (sealed to me): ${e.data.error}`); return; }
    if (e.type === 'signed') signed = e.data;
    if (e.type === 'completed') completed = e.data;
    if (e.sealed || e.type === last && !e.data?.url) return; // per-part progress repeats; show each step once
    last = e.type;
    const link = e.data?.url ?? (e.data?.tx ? explorer(e.data.tx) : '');
    say(`  ${String(e.source).padEnd(6)} ${e.type}${link ? '  ' + link : ''}${e.data?.error ? '  ' + e.data.error : ''}`);
  });

  if (!completed?.ok || !result?.ok) { say(`run did not complete${result?.error ? ': ' + result.error : ''}; a failed run is refunded on-chain. Resume: POST ${BASE}/api/runs/${ticket.run_id}/resume with header x-run-token (token in .data/agent-runs.json)`); process.exit(1); }

  // the check: the runner signed (contract, run, recipe, outcome, output_hash, delivered, parts) with its on-chain key,
  // and the contract settled on that report; the salt came only to this agent, so only it can tie the output to the hash
  const checks: [string, boolean][] = [];
  const parts = signed?.message.split('|') ?? [];
  const [, contractId, runId, recipeId, outcome, outputHash, delivered] = parts;
  let sigOk = false;
  try { sigOk = !!signed && nacl.sign.detached.verify(new TextEncoder().encode(signed.message), base64.dec(signed.signature), bs58.decode(runner.onchain.signing_pk.replace(/^ed25519:/, ''))); } catch { sigOk = false; }
  checks.push(['report signed by the runner key registered on-chain', sigOk]);
  checks.push(['report is for this contract, run and recipe', contractId === mode.contract_id && runId === ticket.run_id && recipeId === q.listing.ticker && outcome === 'ok']);
  checks.push(['sealed result matches the signed output_hash', outputHash === hashObject({ run_id: ticket.run_id, salt: result.salt, output: result.output }) && outputHash === completed.output_hash]);
  // the server reads final blocks, a few seconds behind the settlement: wait for the run to leave Pending
  let run: { status: string } | null = null;
  for (let i = 0; i < 15 && (!run || run.status === 'Pending'); i++) {
    if (i) await new Promise((ok) => setTimeout(ok, 2000));
    run = await api<{ status: string }>(`/api/chain/runs/${ticket.run_id}`).catch(() => null);
  }
  checks.push([`run is ${run?.status ?? 'unknown'} on-chain`, !!run && run.status !== 'Pending']);
  for (const [label, ok] of checks) say(`  ${ok ? '✔' : '✘'} ${label}`);

  const promised = BigInt(q.promised ?? 0);
  say(promised > 0n
    ? `delivered ${usd(delivered)} vs promised ${usd(promised)}; ${BigInt(delivered) >= promised ? 'promise kept' : `shortfall ${usd(promised - BigInt(delivered))}, compensated from the guarantee deposit up to ${usd(q.cover)}`}`
    : `${q.listing.ticker} returns a report (no value promised): delivery is the result itself`);
  const out1 = result.output ?? {};
  if (out1.title || out1.summary) say(`result: ${[out1.title, out1.summary].filter(Boolean).join(' — ')}`);
  else console.log(JSON.stringify(out1, null, 1).slice(0, 1200));
  if (completed.settlement?.url) say(`settlement: ${completed.settlement.url}`);
  const bad = checks.filter(([, ok]) => !ok).length;
  say(bad ? `${bad} check(s) failed` : 'done');
  process.exit(bad ? 1 : 0);
}

function explorer(tx: string) { return `https://testnet.nearblocks.io/txns/${tx}`; }

/** the agent's own testnet identity: a named near-cli account, or a guest key kept between runs */
async function liveAccount(): Promise<{ id: string; secretKey: `ed25519:${string}`; guest: boolean }> {
  const named = opt('account');
  if (named) {
    const k = JSON.parse(readFileSync(join(homedir(), '.near-credentials', 'testnet', `${named}.json`), 'utf8')) as { private_key: `ed25519:${string}` };
    return { id: named, secretKey: k.private_key, guest: false };
  }
  const file = process.env.SRS_AGENT_KEY ?? join(root, '.data', 'agent-guest.json');
  if (existsSync(file)) {
    const k = JSON.parse(readFileSync(file, 'utf8')) as { account_id: string; private_key: `ed25519:${string}` };
    return { id: k.account_id, secretKey: k.private_key, guest: true };
  }
  // a NEAR implicit account: its id is the public key in hex; it exists once the faucet sends it NEAR
  const kp = nacl.sign.keyPair();
  const id = Buffer.from(kp.publicKey).toString('hex');
  const body = { account_id: id, public_key: 'ed25519:' + bs58.encode(kp.publicKey), private_key: `ed25519:${bs58.encode(kp.secretKey)}` as const, network: 'testnet', note: 'Sealed Recipes agent buyer guest key (NEAR testnet only, test tokens). near-cli compatible.' };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(body, null, 2), { mode: 0o600 });
  say(`made a guest key for the agent: ${file}`);
  return { id, secretKey: body.private_key, guest: true };
}

/** enough tUSDC for the price (and an account that exists, for gas): ask the faucet once, then wait for the tokens */
async function ensureFunds(price: bigint, faucetOn: boolean) {
  type Bal = { exists: boolean; near_yocto: string; tusdc: string };
  const bal = () => api<Bal>(`/api/account/${me.id}/balance`);
  let b = await bal();
  if (b.exists && BigInt(b.tusdc) >= price) { say(`balance ${usd(b.tusdc)} tUSDC`); return; }
  if (!me.guest || !faucetOn) { say(`${me.id} has ${usd(b.tusdc)} tUSDC, needs ${usd(price)}${me.guest ? '; the faucet is off on this server' : ''}`); process.exit(1); }
  say(`asking the testnet faucet to fund ${me.id}`);
  try {
    const f = await api<{ txs?: string[] }>('/api/faucet', { account_id: me.id });
    for (const t of f.txs ?? []) say(`  faucet: ${t}`);
  } catch (e) {
    const m = (e as Error).message;
    if (/already funded/.test(m)) { say(`the faucet funds a guest once and this one has spent its tokens: delete ${process.env.SRS_AGENT_KEY ?? '.data/agent-guest.json'} for a new guest, or pass --account`); process.exit(1); }
    throw e;
  }
  for (let i = 0; i < 30; i++) {
    b = await bal();
    if (b.exists && BigInt(b.tusdc) >= price) { say(`balance ${usd(b.tusdc)} tUSDC`); return; }
    await new Promise((ok) => setTimeout(ok, 2000));
  }
  say('the faucet tokens have not arrived yet; run again in a minute'); process.exit(1);
}
