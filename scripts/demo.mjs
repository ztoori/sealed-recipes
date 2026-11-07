#!/usr/bin/env node
/**
 * One command, any OS:  npm run demo
 * Starts the sealed runner (:8787) and the marketplace (:8080), seeds the market,
 * builds the web app if needed, and prints the URL.
 *   --no-open   don't open a browser       --story   also run the 4-step story in the terminal
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(resolve(root, '.env'))) { try { process.loadEnvFile(resolve(root, '.env')); } catch {} }
const args = new Set(process.argv.slice(2));
const PORT = process.env.PORT ?? '8080';
const RPORT = process.env.RUNNER_PORT ?? '8787';
const base = `http://127.0.0.1:${PORT}`;
const node = process.execPath;
const tsx = ['--import', 'tsx'];
const children = [];
// the pricing test uses short periods so the market visibly moves within a minute
if (process.argv.includes('--pricing')) process.env.SRS_PRICE_PERIOD_S ??= '15';
const RUNNER_TOKEN = randomBytes(24).toString('hex'); // marketplace ↔ runner job channel

let stopping = false;
/** `restart`: supervise like a container restart policy (the runner can crash mid-run; runs resume from checkpoints) */
function start(name, script, env, restart = false) {
  const p = spawn(node, [...tsx, script], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.stdout.write(d));
  p.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  p.on('exit', (code) => {
    children.splice(children.indexOf(p), 1);
    if (stopping) return;
    if (restart) { console.log(`[demo] ${name} stopped (${code ?? 'signal'}); restarting it`); setTimeout(() => start(name, script, env, restart), 800); return; }
    if (code) { console.error(`[demo] ${name} exited with ${code}`); shutdown(1); }
  });
  children.push(p);
  return p;
}
function shutdown(code = 0) { stopping = true; for (const c of [...children]) c.kill(); process.exit(code); }
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function waitFor(url, ms = 30000) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { const r = await fetch(url); if (r.ok) return; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  throw new Error('timeout waiting for ' + url);
}

if (!existsSync(resolve(root, 'web/dist/index.html'))) {
  console.log('[demo] building web app (first run only)…');
  const b = spawnSync(node, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'web/vite.config.ts', '--logLevel', 'warn'], { cwd: root, stdio: 'inherit' });
  if (b.status) process.exit(b.status);
}

const rewrite = [
  `api.fastnear.com=${base}/mock/fastnear`,
  `rpc.mainnet.fastnear.com=${base}/mock/rpc`,
  `1click.chaindefuser.com=${base}/mock/1click`,
  `cloud-api.near.ai=${base}/mock/nearai`,
  `solver-relay-v2.chaindefuser.com=${base}/mock/solver-relay`,
].join(',');

start('runner', 'runner/src/main.ts', { RUNNER_PORT: RPORT, CHAIN_URL: `${base}/api/chain`, SRS_REWRITE: rewrite, RUNNER_TOKEN, TEE_MODE: process.env.TEE_MODE ?? 'local-dev', SRS_ALLOW_CRASH: '1' }, true);
await waitFor(`http://127.0.0.1:${RPORT}/health`);
start('server', 'server/src/main.ts', { PORT, RUNNER_URL: `http://127.0.0.1:${RPORT}`, RUNNER_TOKEN, SRS_ALLOW_CRASH: '1' });
await waitFor(`${base}/api/mode`);
const seed = spawnSync(node, [...tsx, 'scripts/seed.ts'], { cwd: root, stdio: 'inherit', env: { ...process.env, SRS_URL: base } });
if (seed.status) shutdown(seed.status);

console.log(`\n  Sealed Recipes is running →  ${base}\n  (local mode: offline mocks for FastNEAR / RPC / 1Click / NEAR AI Cloud; see README "What is real")\n  Ctrl+C to stop.\n`);

for (const [flag, script] of [['--crash-test', 'scripts/crash-test.ts'], ['--versions', 'scripts/versions-demo.ts'], ['--atomic', 'scripts/atomic-demo.ts'], ['--pricing', 'scripts/pricing-demo.ts']]) {
  if (!args.has(flag)) continue;
  // async (not spawnSync): the launcher must stay responsive to restart the runner while the script runs
  const status = await new Promise((done) => spawn(node, [...tsx, script], { cwd: root, stdio: 'inherit', env: { ...process.env, SRS_URL: base } }).on('exit', (c) => done(c ?? 1)));
  if (status) shutdown(status);
}
if (args.has('--story')) {
  const s = spawnSync(node, [...tsx, 'scripts/story-cli.ts'], { cwd: root, stdio: 'inherit', env: { ...process.env, SRS_URL: base } });
  if (args.has('--exit')) shutdown(s.status ?? 0);
}
if (args.has('--exit')) shutdown(0);
if (!args.has('--no-open') && !args.has('--exit') && !process.env.CI) {
  // WSL: open the page in the Windows browser (WSL2 forwards localhost to Windows by default)
  const wsl = process.platform === 'linux' && existsSync('/proc/version') && /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', base]] : process.platform === 'darwin' ? ['open', [base]]
    : wsl ? ['cmd.exe', ['/c', 'start', '', base]] : ['xdg-open', [base]];
  try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch {}
}
