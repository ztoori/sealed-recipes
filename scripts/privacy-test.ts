/**
 * Privacy check:  npm run test:privacy
 *
 * A buyer's inputs (for example, the account they want audited) are sealed in their client to the runner. They must
 * never show up anywhere outside sealed data: not in our process output, not in anything the marketplace stores or
 * serves in the clear, not in the run's public events, not on-chain. This starts its own runner and marketplace with
 * their output captured, uses made-up "canary" account names as inputs (a quote, a quote that fails on the input,
 * a paid run), then searches everything that leaves the sealed boundary for the canaries. It also checks the other
 * side: the buyer, with their one-time key, does get the details.
 *
 * Out of scope here: the local mocks of FastNEAR, NEAR RPC and 1Click. They stand in for those providers, which
 * necessarily see the account a part looks up, as with any block explorer.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PRIVACY_PORT ?? 18700), RPORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;
process.env.SRS_URL = BASE;
const dir = mkdtempSync(join(tmpdir(), 'srs-privacy-'));
const TOKEN = randomBytes(24).toString('hex');
const tag = randomBytes(5).toString('hex');
const CANARY = `canary-${tag}.near`;            // a valid account name nobody has
// passes the form's pattern but not the part's account check, whose error message quotes the value back
const CANARY_BAD = `canary-${tag}..near`;
const needles = [`canary-${tag}`];

// ---- start the runner and the marketplace with their output captured ----
const logs: string[] = [];
const procs: ChildProcess[] = [];
const start = (name: string, script: string, env: Record<string, string>) => {
  const p = spawn(process.execPath, ['--import', 'tsx', script], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  p.stdout!.on('data', (d) => logs.push(`[${name}] ${d}`));
  p.stderr!.on('data', (d) => logs.push(`[${name}:err] ${d}`));
  procs.push(p);
  return p;
};
const stop = () => { for (const p of procs) p.kill(); };
process.on('exit', () => { stop(); rmSync(dir, { recursive: true, force: true }); });
const waitFor = async (url: string) => { for (let i = 0; i < 120; i++) { try { if ((await fetch(url)).ok) return; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 250)); } throw new Error('timeout ' + url); };
const rewrite = ['api.fastnear.com=/mock/fastnear', 'rpc.mainnet.fastnear.com=/mock/rpc', '1click.chaindefuser.com=/mock/1click', 'cloud-api.near.ai=/mock/nearai', 'solver-relay-v2.chaindefuser.com=/mock/solver-relay'].map((kv) => kv.replace('=', `=${BASE}`)).join(',');
start('runner', 'runner/src/main.ts', { RUNNER_PORT: String(RPORT), CHAIN_URL: `${BASE}/api/chain`, SRS_REWRITE: rewrite, RUNNER_TOKEN: TOKEN, TEE_MODE: 'local-dev', SRS_SANDBOX_DIR: dir });
await waitFor(`http://127.0.0.1:${RPORT}/health`);
start('server', 'server/src/main.ts', { PORT: String(PORT), RUNNER_URL: `http://127.0.0.1:${RPORT}`, RUNNER_TOKEN: TOKEN, SRS_STORE_DIR: join(dir, 'store'), SRS_REVIEW_DIR: join(dir, 'reviews') });
await waitFor(`${BASE}/api/mode`);
const seed = start('seed', 'scripts/seed.ts', { SRS_URL: BASE });
await new Promise((ok) => seed.on('exit', ok));

// ---- record everything the client receives in the clear ----
const received: string[] = [];
const plain = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const r = await plain(input, init);
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(BASE) && !String(r.headers.get('content-type')).includes('event-stream')) received.push(`${url}\n${await r.clone().text()}`);
  return r;
}) as typeof fetch;
const { api, verifiedRunner, requestQuotes } = await import('./lib/client.js');
const { open } = await import('../core/src/index.js');

const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`${ok ? '✔' : '✘'} ${what}`); if (!ok) failures.push(what); };
const runner = await verifiedRunner();
const BUYER = 'bob.testnet';

// 1. a quote on the canary account
const q1 = await requestQuotes(['CHEK'], { contract: CANARY }, runner.onchain, BUYER);
const quote = q1.quotes[0];
check(quote.ok, `quote on the canary account succeeded (${quote.error ?? 'signed'})`);

// 2. a quote that fails on the input itself: the error message would contain it
const q2 = await requestQuotes(['CHEK'], { contract: CANARY_BAD }, runner.onchain, BUYER);
const bad = q2.quotes[0];
check(!bad.ok, 'quote on an invalid account failed');
check(String(bad.error).includes(CANARY_BAD), `the buyer, with their one-time key, can read why it failed: "${bad.error}"`);

// 3. a paid run on the canary account; read the run's event stream raw (what the marketplace relays)
const pay = await api<{ run_id: string; run_token: string }>('/api/runs/quote', { recipe_id: 'CHEK', buyer: BUYER, pay_asset: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', refund_to: '0xB0b0000000000000000000000000000000000001', sealed_inputs: q1.sealed_job, signed_quote: undefined });
await api(`/api/runs/${pay.run_id}/pay?token=${pay.run_token}`, {});
const raw: string[] = [];
let opened = '';
{
  const res = await plain(`${BASE}/api/runs/${pay.run_id}/events?token=${pay.run_token}`);
  const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = ''; let done = false;
  const deadline = Date.now() + 60_000;
  while (!done && Date.now() < deadline) {
    const { value, done: end } = await reader.read(); if (end) break;
    buf += dec.decode(value, { stream: true });
    for (let i; (i = buf.indexOf('\n\n')) >= 0;) {
      const line = buf.slice(6, i); buf = buf.slice(i + 2);
      raw.push(line);
      const e = JSON.parse(line);
      if (e.type === 'sealed') opened += JSON.stringify(open(e.data.envelope, q1.reply.secretKey));
      if (e.type === 'completed' || e.type === 'failed') done = true;
    }
  }
  await reader.cancel().catch(() => {});
}
check(raw.some((l) => /"type":"completed"/.test(l)), 'the paid run completed');
check(needles.some((n) => opened.toLowerCase().includes(n)), 'the buyer, with their one-time key, sees the account in the sealed result');

// ---- now search everything outside the sealed boundary ----
await new Promise((r) => setTimeout(r, 500)); // let the processes flush their output
const chain = JSON.stringify(await api('/api/chain/events?since=0'));
const public_ = [await api('/api/runs'), await api('/api/listings'), await api('/api/recipes/summary'), await api('/api/intents/log')].map((x) => JSON.stringify(x)).join('\n');
const files: string[] = [];
const walk = (p: string) => { for (const e of readdirSync(p)) { const f = join(p, e); if (statSync(f).isDirectory()) walk(f); else files.push(`${f}\n${readFileSync(f, 'latin1')}`); } };
walk(join(dir, 'store')); try { walk(join(dir, 'reviews')); } catch { /* none */ }
const places: [string, string][] = [
  ['runner and marketplace output (stdout, stderr)', logs.join('')],
  ['responses the client received in the clear (quotes, errors, run setup)', received.join('\n')],
  ['the run event stream the marketplace relays', raw.join('\n')],
  ['on-chain events (contract mirror)', chain],
  ['public marketplace endpoints (runs, listings, track records, intents log)', public_],
  ['files the marketplace stores (vault, checkpoints, reviews)', files.join('\n')],
];
for (const [where, text] of places) {
  const low = text.toLowerCase();
  const hit = needles.find((n) => low.includes(n));
  check(!hit, `no canary in ${where}${hit ? `: found "${hit}" near …${low.slice(Math.max(0, low.indexOf(hit) - 80), low.indexOf(hit) + 40)}…` : ''}`);
}

stop();
if (failures.length) { console.error(`\n✘ privacy check failed: ${failures.length} problem(s)`); process.exit(1); }
console.log('\n✔ privacy check passed: the canary accounts appear only inside data sealed to the buyer');
process.exit(0);
