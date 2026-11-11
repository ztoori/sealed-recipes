#!/usr/bin/env node
/**
 * Public demo gateway:  npm run gateway
 *
 * Every visitor gets a private copy of the demo marketplace: their own contract mirror, market, part reviews and
 * sealed-recipe store. Demo accounts sign with keys anyone can derive (it is a demo wallet), so on a shared server
 * one visitor could act "as" any account and change what others see. Here nothing a visitor does reaches anyone
 * else: a forged signature, a published recipe or a played story stays in their own sandbox, deleted when they leave.
 *
 *  - one shared runner serves every sandbox (runner/src/main.ts shared mode: each request names its marketplace,
 *    runs are keyed per marketplace); a sandbox is just one marketplace process (server/src/main.ts) seeded once;
 *  - a sandbox is assigned on the first page view (cookie `srs_sb`) and removed after SANDBOX_IDLE_MIN without traffic;
 *  - SANDBOX_SPARE seeded sandboxes are kept warm so a new visitor does not wait;
 *  - at most SANDBOX_MAX run at once, and one address may create SANDBOX_PER_IP per 10 minutes.
 *
 * Traffic and performance: GET /gateway/metrics (from this machine only) returns request counts, latency
 * percentiles, sandbox counts and the memory and swap of every process; a summary line is logged every minute.
 *
 * Env: GATEWAY_PORT (8080)  GATEWAY_HOST (127.0.0.1)  SANDBOX_MAX (4)  SANDBOX_SPARE (1)  SANDBOX_IDLE_MIN (10)
 *      SANDBOX_PER_IP (3)  SANDBOX_BASE_PORT (9100; the shared runner uses the port below it)
 *      GATEWAY_BUILD=0: never build web/dist here (read-only checkout; build it in the deploy step)
 */
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { freemem, loadavg, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const PORT = Number(env.GATEWAY_PORT ?? 8080);
const HOST = env.GATEWAY_HOST ?? '127.0.0.1';
const MAX = Math.max(1, Number(env.SANDBOX_MAX ?? 4));
const SPARE = Math.min(MAX, Math.max(0, Number(env.SANDBOX_SPARE ?? 1)));
const IDLE_MS = Number(env.SANDBOX_IDLE_MIN ?? 10) * 60_000;
const PER_IP = Number(env.SANDBOX_PER_IP ?? 3);
const BASE = Number(env.SANDBOX_BASE_PORT ?? 9100);
const RUNNER_PORT = BASE - 1;
const BOOT_MS = 120_000;
const node = process.execPath;
const tsx = ['--import', 'tsx'];
const log = (...a) => console.log(new Date().toISOString(), '[gateway]', ...a);

// ---- build the web app once, so sandboxes never race to build it ----
const newest = (dir) => { let t = 0; for (const e of readdirSync(dir, { withFileTypes: true })) { const p = resolve(dir, e.name); t = Math.max(t, e.isDirectory() ? newest(p) : statSync(p).mtimeMs); } return t; };
const index = resolve(root, 'web/dist/index.html');
const built = existsSync(index) ? statSync(index).mtimeMs : 0;
const sources = Math.max(...['web/src', 'core/src', 'standard', 'seed'].map((d) => newest(resolve(root, d))), statSync(resolve(root, 'web/index.html')).mtimeMs);
if (sources > built && env.GATEWAY_BUILD === '0') {
  // hosted with a read-only checkout (deploy/srs-demo.service): the deploy step runs `npm run build`
  log(built ? 'WARNING web/dist is older than its sources; run `npm run build` in the checkout' : 'web/dist is missing; run `npm run build` in the checkout');
  if (!built) process.exit(1);
} else if (sources > built) {
  log('building the web app…');
  const b = spawnSync(node, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'web/vite.config.ts', '--logLevel', 'warn'], { cwd: root, stdio: 'inherit' });
  if (b.status) process.exit(b.status);
}

const childEnv = (extra) => {
  const e = { ...env, ...extra, SRS_PUBLIC: '1' };
  delete e.SRS_HOST; delete e.SRS_ALLOW_CRASH; // local only, never with dev endpoints
  return e;
};
const waitFor = async (url, ms, ok = (r) => r.ok) => {
  const t = Date.now();
  while (Date.now() - t < ms) { try { if (ok(await fetch(url, { signal: AbortSignal.timeout(3000) }))) return true; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 300)); }
  return false;
};
let shuttingDown = false;

// ---- the shared runner ----
const RUNNER_TOKEN = randomBytes(24).toString('hex');
const runnerDir = mkdtempSync(join(tmpdir(), 'srs-runner-'));
// parts reach the mock services of the marketplace the job came from: {tenant} is that marketplace's address
const REWRITE = ['api.fastnear.com=/mock/fastnear', 'rpc.mainnet.fastnear.com=/mock/rpc', '1click.chaindefuser.com=/mock/1click', 'cloud-api.near.ai=/mock/nearai', 'solver-relay-v2.chaindefuser.com=/mock/solver-relay']
  .map((kv) => kv.replace('=', '={tenant}')).join(',');
const runner = { proc: undefined, restarts: 0, ready: false };
function startRunner() {
  runner.ready = false;
  const proc = spawn(node, [...tsx, 'runner/src/main.ts'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv({
    RUNNER_PORT: String(RUNNER_PORT), RUNNER_HOST: '127.0.0.1', RUNNER_TOKEN, TEE_MODE: env.TEE_MODE ?? 'local-dev',
    SRS_TENANT_PORTS: `${BASE}-${BASE + MAX - 1}`, SRS_REWRITE: REWRITE, SRS_SANDBOX_DIR: runnerDir }) });
  proc.stdout.on('data', (d) => { if (env.SANDBOX_VERBOSE) process.stdout.write(`[runner] ${d}`); });
  proc.stderr.on('data', (d) => process.stderr.write(`[runner] ${d}`));
  proc.on('exit', (code) => {
    if (shuttingDown) return;
    runner.restarts++;
    // marketplaces resume their runs from checkpoints once the runner is back (server/src/main.ts followRunner)
    log(`runner exited (${code ?? 'signal'}); restarting`);
    setTimeout(startRunner, Math.min(30_000, 1000 * runner.restarts));
  });
  runner.proc = proc;
  void waitFor(`http://127.0.0.1:${RUNNER_PORT}/health`, 60_000).then((ok) => { runner.ready = ok; if (ok) log(`shared runner ready on :${RUNNER_PORT}`); });
}

/** @typedef {{ id: string, slot: number, port: number, proc: import('node:child_process').ChildProcess, dir: string, ready: boolean,
 *   failed: boolean, whenReady: Promise<boolean>, claimed: boolean, lastSeen: number, open: number, stopping: boolean, bootMs?: number }} Sandbox */
/** @type {Map<string, Sandbox>} */
const sandboxes = new Map();
const usedSlots = new Set();
let bootFailures = 0;
const freeSlot = () => { for (let i = 0; i < MAX; i++) if (!usedSlots.has(i)) return i; return -1; };

function startSandbox() {
  const slot = freeSlot();
  if (slot < 0) return undefined;
  usedSlots.add(slot);
  const id = randomBytes(16).toString('hex');
  const port = BASE + slot;
  const base = `http://127.0.0.1:${port}`;
  const dir = mkdtempSync(join(tmpdir(), 'srs-sb-'));
  const proc = spawn(node, [...tsx, 'server/src/main.ts'], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv({
    PORT: String(port), RUNNER_URL: `http://127.0.0.1:${RUNNER_PORT}`, RUNNER_TOKEN, SRS_TENANT_URL: base,
    SRS_STORE_DIR: join(dir, 'store'), SRS_REVIEW_DIR: join(dir, 'reviews') }) });
  const tag = `[sb${slot}]`;
  proc.stdout.on('data', (d) => { if (env.SANDBOX_VERBOSE) process.stdout.write(`${tag} ${d}`); });
  proc.stderr.on('data', (d) => process.stderr.write(`${tag} ${d}`));
  /** @type {Sandbox} */
  const sb = { id, slot, port, proc, dir, ready: false, failed: false, whenReady: Promise.resolve(false), claimed: false, lastSeen: Date.now(), open: 0, stopping: false };
  sb.whenReady = (async () => {
    const t = Date.now();
    if (!runner.ready) await waitFor(`http://127.0.0.1:${RUNNER_PORT}/health`, BOOT_MS);
    const up = await waitFor(`${base}/api/mode`, BOOT_MS);
    // seed the nine sample recipes exactly as a creator's client would (scripts/seed.ts); a short-lived process
    const seeded = up && !sb.stopping && await new Promise((ok) => {
      const s = spawn(node, [...tsx, 'scripts/seed.ts'], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], env: childEnv({ SRS_URL: base }) });
      s.stderr.on('data', (d) => process.stderr.write(`${tag} [seed] ${d}`));
      s.on('exit', (c) => ok(c === 0));
    });
    if (seeded && !sb.stopping) { sb.ready = true; sb.bootMs = Date.now() - t; stats.boots.push(sb.bootMs); if (stats.boots.length > 200) stats.boots.shift(); log(`${tag} ready on :${port} in ${(sb.bootMs / 1000).toFixed(1)} s`); return true; }
    if (!sb.stopping) { sb.failed = true; log(`${tag} did not become ready; stopping it`); stopSandbox(sb); }
    return false;
  })();
  proc.on('exit', (code) => {
    sandboxes.delete(id); usedSlots.delete(slot);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (!sb.stopping) log(`${tag} exited unexpectedly (${code ?? 'signal'})`);
    // a sandbox that never became ready is failing to boot: back off instead of restarting in a tight loop
    if (!sb.ready && !sb.stopping) { bootFailures++; stats.bootFailures++; } else if (sb.ready) bootFailures = 0;
    setTimeout(topUpSpares, Math.min(5 * 60_000, 1000 * 2 ** Math.min(bootFailures, 9)));
  });
  sandboxes.set(id, sb);
  return sb;
}

function stopSandbox(sb) {
  if (sb.stopping) return;
  sb.stopping = true;
  try { process.kill(-sb.proc.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(-sb.proc.pid, 'SIGKILL'); } catch { /* gone */ } }, 5000).unref();
}

const spares = () => [...sandboxes.values()].filter((s) => !s.claimed && !s.stopping && !s.failed);
function topUpSpares() { while (!shuttingDown && spares().length < SPARE && freeSlot() >= 0) startSandbox(); }

/** a sandbox for a new visitor: a warm spare, a new one, or the slot of the longest-idle visitor */
function assign() {
  const spare = spares().sort((a, b) => Number(b.ready) - Number(a.ready))[0];
  const sb = spare ?? startSandbox();
  if (!sb) {
    const idle = [...sandboxes.values()].filter((s) => s.claimed && s.open === 0 && Date.now() - s.lastSeen > 2 * 60_000).sort((a, b) => a.lastSeen - b.lastSeen)[0];
    if (!idle) return undefined;
    log(`[sb${idle.slot}] evicted to make room (idle ${Math.round((Date.now() - idle.lastSeen) / 1000)} s)`);
    stats.evictions++;
    stopSandbox(idle);
    return 'evicting';
  }
  sb.claimed = true; sb.lastSeen = Date.now();
  stats.sessions++;
  setTimeout(topUpSpares, 0);
  return sb;
}

setInterval(() => {
  for (const sb of sandboxes.values()) if (sb.claimed && sb.open === 0 && Date.now() - sb.lastSeen > IDLE_MS) { log(`[sb${sb.slot}] idle, removing`); stopSandbox(sb); }
}, 30_000).unref();

// ---- per-address creation limit ----
const created = new Map();
const clientIp = (req) => String(req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress ?? 'unknown');
function mayCreate(ip) {
  const now = Date.now();
  const recent = (created.get(ip) ?? []).filter((t) => now - t < 10 * 60_000);
  if (recent.length >= PER_IP) { created.set(ip, recent); return false; }
  created.set(ip, [...recent, now]);
  return true;
}
setInterval(() => { const now = Date.now(); for (const [ip, ts] of created) if (ts.every((t) => now - t > 10 * 60_000)) created.delete(ip); }, 60_000).unref();

// ---- traffic and performance ----
const stats = { started: Date.now(), requests: 0, sessions: 0, busy: 0, evictions: 0, bootFailures: 0, boots: [], recent: [] };
const RECENT_MAX = 200_000;
const klass = (req) => req.url.startsWith('/api/') ? 'api' : req.url.startsWith('/runner/') ? 'runner' : req.url.startsWith('/assets/') ? 'asset' : isPage(req) ? 'page' : 'other';
function record(req, res, t0) {
  res.on('finish', () => {
    stats.requests++;
    // event streams stay open for a whole run: count them, but keep them out of the latency figures
    const stream = String(res.getHeader('content-type') ?? '').includes('text/event-stream');
    stats.recent.push({ t: Date.now(), c: stream ? 'stream' : klass(req), s: res.statusCode, ms: Date.now() - t0 });
    if (stats.recent.length > RECENT_MAX) stats.recent.splice(0, stats.recent.length - RECENT_MAX);
  });
}
const pct = (xs, p) => xs.length ? xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : null;
function windowStats(ms) {
  const since = Date.now() - ms;
  const rows = stats.recent.filter((r) => r.t >= since);
  const by = {};
  for (const r of rows) (by[r.c] ??= []).push(r);
  const out = { requests: rows.length, per_second: +(rows.length / (ms / 1000)).toFixed(2), errors_5xx: rows.filter((r) => r.s >= 500).length, busy_503: rows.filter((r) => r.s === 503).length, by_class: {} };
  for (const [c, rs] of Object.entries(by)) {
    const lat = rs.map((r) => r.ms).sort((a, b) => a - b);
    out.by_class[c] = { count: rs.length, p50_ms: pct(lat, 50), p95_ms: pct(lat, 95), p99_ms: pct(lat, 99), max_ms: lat.at(-1) };
  }
  return out;
}
const procMem = (pid) => {
  try {
    const s = readFileSync(`/proc/${pid}/status`, 'utf8');
    const kb = (k) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(s)?.[1] ?? 0);
    return { rss_mb: +(kb('VmRSS') / 1024).toFixed(1), swap_mb: +(kb('VmSwap') / 1024).toFixed(1) };
  } catch { return { rss_mb: null, swap_mb: null }; }
};
const meminfo = () => {
  try {
    const s = readFileSync('/proc/meminfo', 'utf8');
    const mb = (k) => Math.round(Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(s)?.[1] ?? 0) / 1024);
    return { total_mb: mb('MemTotal'), available_mb: mb('MemAvailable'), swap_total_mb: mb('SwapTotal'), swap_free_mb: mb('SwapFree') };
  } catch { return { total_mb: Math.round(totalmem() / 2 ** 20), available_mb: Math.round(freemem() / 2 ** 20) }; }
};
function metrics() {
  const sbs = [...sandboxes.values()];
  const procs = { gateway: procMem(process.pid), runner: runner.proc ? procMem(runner.proc.pid) : null, sandboxes: sbs.map((s) => ({ slot: s.slot, claimed: s.claimed, ready: s.ready, open_requests: s.open, idle_s: Math.round((Date.now() - s.lastSeen) / 1000), boot_s: s.bootMs ? +(s.bootMs / 1000).toFixed(1) : null, ...procMem(s.proc.pid) })) };
  const sbRss = procs.sandboxes.map((s) => s.rss_mb ?? 0);
  const boots = [...stats.boots].sort((a, b) => a - b);
  return {
    uptime_s: Math.round((Date.now() - stats.started) / 1000),
    limits: { max: MAX, spare: SPARE, idle_min: IDLE_MS / 60_000, per_ip_per_10min: PER_IP },
    sandboxes: { running: sbs.length, ready: sbs.filter((s) => s.ready).length, visitors: sbs.filter((s) => s.claimed).length, spare: spares().length },
    totals: { requests: stats.requests, sessions: stats.sessions, busy_pages: stats.busy, evictions: stats.evictions, boot_failures: stats.bootFailures, runner_restarts: runner.restarts },
    boot_s: { p50: boots.length ? +(pct(boots, 50) / 1000).toFixed(1) : null, p95: boots.length ? +(pct(boots, 95) / 1000).toFixed(1) : null },
    traffic: { last_1m: windowStats(60_000), last_5m: windowStats(5 * 60_000), last_15m: windowStats(15 * 60_000) },
    memory: { system: meminfo(), load_avg: loadavg().map((x) => +x.toFixed(2)), per_sandbox_rss_mb_avg: sbRss.length ? +(sbRss.reduce((a, b) => a + b, 0) / sbRss.length).toFixed(1) : null, processes: procs },
  };
}
setInterval(() => {
  const m = metrics(), w = m.traffic.last_1m, api = w.by_class.api;
  log(`1m: ${w.requests} req, ${w.errors_5xx} 5xx, ${w.busy_503} busy; api p95 ${api?.p95_ms ?? '-'} ms; visitors ${m.sandboxes.visitors}/${MAX}; mem avail ${m.memory.system.available_mb} MB, swap used ${(m.memory.system.swap_total_mb ?? 0) - (m.memory.system.swap_free_mb ?? 0)} MB; load ${m.memory.load_avg[0]}`);
}, 60_000).unref();

// ---- pages ----
const page = (res, status, title, body, refresh) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...(refresh ? { refresh: String(refresh) } : {}) });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:18vh auto;padding:0 1.5rem;color:#222"><h1 style="font-size:1.4rem">${title}</h1>${body}</body>`);
};
const preparing = (res) => page(res, 200, 'Preparing your private demo…', '<p>Each visitor gets their own copy of the demo, so nothing you do affects anyone else. This takes a few seconds; the page reloads by itself.</p>', 2);
const busy = (res) => { stats.busy++; page(res, 503, 'The demo is busy', '<p>All demo sandboxes are in use. Please try again in a few minutes.</p>', 30); };

const cookieOf = (req) => /(?:^|;\s*)srs_sb=([0-9a-f]{32})/.exec(String(req.headers.cookie ?? ''))?.[1];
const isPage = (req) => req.method === 'GET' && String(req.headers.accept ?? '').includes('text/html');
const secure = (req) => req.headers['x-forwarded-proto'] === 'https' || String(req.headers['cf-visitor'] ?? '').includes('https');
const setCookie = (req, res, id) => res.setHeader('set-cookie', `srs_sb=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure(req) ? '; Secure' : ''}`);
const local = (req) => !req.headers['cf-connecting-ip'] && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');

function proxy(req, res, sb) {
  sb.open++; sb.lastSeen = Date.now();
  let done = false;
  const finish = () => { if (!done) { done = true; sb.open--; sb.lastSeen = Date.now(); } };
  res.on('close', finish);
  const headers = { ...req.headers, host: `127.0.0.1:${sb.port}`, 'x-forwarded-for': clientIp(req) };
  delete headers.cookie; // the sandbox cookie is the gateway's; the app sets no cookies of its own
  const up = http.request({ host: '127.0.0.1', port: sb.port, method: req.method, path: req.url, headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', (e) => { if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: `sandbox unavailable: ${e.message}` })); } else res.destroy(); });
  req.pipe(up);
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, runner: runner.ready, sandboxes: sandboxes.size, ready: [...sandboxes.values()].filter((s) => s.ready).length, visitors: [...sandboxes.values()].filter((s) => s.claimed).length, max: MAX }));
    return;
  }
  if (req.url === '/gateway/metrics') {
    if (!local(req)) { res.writeHead(404).end(); return; } // only from this machine, never through the tunnel
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(metrics(), null, 1));
    return;
  }
  record(req, res, t0);
  let sb = sandboxes.get(cookieOf(req) ?? '');
  if (sb && (sb.stopping || sb.failed)) sb = undefined;
  if (!sb) {
    if (!isPage(req)) {
      // the app's static files are the same in every sandbox, so any ready one serves them
      const any = [...sandboxes.values()].find((s) => s.ready && !s.stopping);
      if (!req.url.startsWith('/api') && !req.url.startsWith('/runner') && !req.url.startsWith('/mock') && any) { proxy(req, res, any); return; }
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'your demo session ended; reload the page to start a new one' }));
      return;
    }
    if (!mayCreate(clientIp(req))) { busy(res); return; }
    const got = assign();
    if (!got) { busy(res); return; }
    if (got === 'evicting') { preparing(res); return; }
    sb = got;
    setCookie(req, res, sb.id);
  }
  sb.lastSeen = Date.now();
  if (!sb.ready) {
    if (isPage(req)) { preparing(res); return; }
    const ok = await Promise.race([sb.whenReady, new Promise((r) => setTimeout(() => r(false), 60_000))]);
    if (!ok) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'your demo is still starting; try again' })); return; }
  }
  proxy(req, res, sb);
});
server.keepAliveTimeout = 65_000;

function shutdown() {
  shuttingDown = true;
  log('stopping');
  for (const sb of sandboxes.values()) stopSandbox(sb);
  try { runner.proc?.kill('SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { rmSync(runnerDir, { recursive: true, force: true }); } catch { /* ignore */ } process.exit(0); }, 6000).unref();
  server.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startRunner();
topUpSpares();
server.listen(PORT, HOST, () => log(`listening on http://${HOST}:${PORT} (max ${MAX} sandboxes, ${SPARE} spare, idle ${IDLE_MS / 60_000} min, shared runner :${RUNNER_PORT})`));
