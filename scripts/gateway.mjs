#!/usr/bin/env node
/**
 * Public demo gateway:  npm run gateway
 *
 * Every visitor gets a private copy of the demo: their own contract mirror, runner, marketplace, part
 * reviews and sealed-recipe store. Demo accounts sign with keys anyone can derive (it is a demo wallet), so
 * on a shared server one visitor could act "as" any account and change what others see. Here nothing a
 * visitor does reaches anyone else: a forged signature, a published recipe or a played story stays in
 * their own sandbox, which is deleted when they leave.
 *
 *  - a sandbox is `scripts/demo.mjs --public` on its own ports, with its own data directory;
 *  - it is assigned on the first page view (cookie `srs_sb`), reaped after SANDBOX_IDLE_MIN without traffic;
 *  - SANDBOX_SPARE ready sandboxes are kept warm so a new visitor does not wait for boot and seeding;
 *  - at most SANDBOX_MAX run at once, and one address may create SANDBOX_PER_IP per 10 minutes.
 *
 * Env: GATEWAY_PORT (8080)  GATEWAY_HOST (127.0.0.1)  SANDBOX_MAX (4)  SANDBOX_SPARE (1)
 *      SANDBOX_IDLE_MIN (20)  SANDBOX_PER_IP (3)  SANDBOX_BASE_PORT (9100)
 *      GATEWAY_BUILD=0: never build web/dist here (read-only checkout; build it in the deploy step)
 */
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const PORT = Number(env.GATEWAY_PORT ?? 8080);
const HOST = env.GATEWAY_HOST ?? '127.0.0.1';
const MAX = Math.max(1, Number(env.SANDBOX_MAX ?? 4));
const SPARE = Math.min(MAX, Math.max(0, Number(env.SANDBOX_SPARE ?? 1)));
const IDLE_MS = Number(env.SANDBOX_IDLE_MIN ?? 20) * 60_000;
const PER_IP = Number(env.SANDBOX_PER_IP ?? 3);
const BASE = Number(env.SANDBOX_BASE_PORT ?? 9100);
const BOOT_MS = 120_000;
const node = process.execPath;
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

/** @typedef {{ id: string, slot: number, port: number, proc: import('node:child_process').ChildProcess, dir: string,
 *   ready: boolean, failed: boolean, whenReady: Promise<boolean>, claimed: boolean, lastSeen: number, open: number, stopping: boolean }} Sandbox */
/** @type {Map<string, Sandbox>} */
const sandboxes = new Map();
const usedSlots = new Set();
let bootFailures = 0;
let shuttingDown = false;
const freeSlot = () => { for (let i = 0; i < MAX; i++) if (!usedSlots.has(i)) return i; return -1; };

function startSandbox() {
  const slot = freeSlot();
  if (slot < 0) return undefined;
  usedSlots.add(slot);
  const id = randomBytes(16).toString('hex');
  const port = BASE + slot * 2;
  const dir = mkdtempSync(join(tmpdir(), 'srs-sb-'));
  const childEnv = { ...env, PORT: String(port), RUNNER_PORT: String(port + 1), SRS_STORE_DIR: join(dir, 'store'), SRS_REVIEW_DIR: join(dir, 'reviews'),
    SRS_SANDBOX_DIR: dir, SRS_SKIP_BUILD: '1', CI: '1' };
  delete childEnv.SRS_HOST; delete childEnv.SRS_ALLOW_CRASH; // sandboxes listen on 127.0.0.1 only, never with dev endpoints
  const proc = spawn(node, ['scripts/demo.mjs', '--no-open', '--public'], { cwd: root, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `[sb${slot}]`;
  proc.stdout.on('data', (d) => { if (env.SANDBOX_VERBOSE) process.stdout.write(`${tag} ${d}`); });
  proc.stderr.on('data', (d) => process.stderr.write(`${tag} ${d}`));
  /** @type {Sandbox} */
  const sb = { id, slot, port, proc, dir, ready: false, failed: false, whenReady: Promise.resolve(false), claimed: false, lastSeen: Date.now(), open: 0, stopping: false };
  sb.whenReady = (async () => {
    const t = Date.now();
    while (Date.now() - t < BOOT_MS && !sb.stopping) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/listings`, { signal: AbortSignal.timeout(3000) });
        if (r.ok && (await r.json()).length > 0) { sb.ready = true; log(`${tag} ready on :${port} in ${((Date.now() - t) / 1000).toFixed(1)} s`); return true; }
      } catch { /* booting */ }
      await new Promise((ok) => setTimeout(ok, 500));
    }
    if (!sb.stopping) { sb.failed = true; log(`${tag} did not become ready; stopping it`); stopSandbox(sb); }
    return false;
  })();
  proc.on('exit', (code) => {
    sandboxes.delete(id); usedSlots.delete(slot);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (!sb.stopping) log(`${tag} exited unexpectedly (${code ?? 'signal'})`);
    // a sandbox that never became ready is failing to boot: back off instead of restarting in a tight loop
    if (!sb.ready && !sb.stopping) bootFailures++; else if (sb.ready) bootFailures = 0;
    setTimeout(topUpSpares, Math.min(5 * 60_000, 1000 * 2 ** Math.min(bootFailures, 9)));
  });
  sandboxes.set(id, sb);
  log(`${tag} starting on :${port}`);
  return sb;
}

function stopSandbox(sb) {
  if (sb.stopping) return;
  sb.stopping = true;
  // the whole process group: demo.mjs, its runner and its marketplace
  try { process.kill(-sb.proc.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(-sb.proc.pid, 'SIGKILL'); } catch { /* gone */ } }, 5000).unref();
}

const spares = () => [...sandboxes.values()].filter((s) => !s.claimed && !s.stopping && !s.failed);
function topUpSpares() { while (!shuttingDown && spares().length < SPARE && freeSlot() >= 0) startSandbox(); }

/** a sandbox for a new visitor: a warm spare, a new one, or the slot of the longest-idle visitor */
function assign() {
  const spare = spares().sort((a, b) => Number(b.ready) - Number(a.ready))[0];
  let sb = spare ?? startSandbox();
  if (!sb) {
    const idle = [...sandboxes.values()].filter((s) => s.claimed && s.open === 0 && Date.now() - s.lastSeen > 2 * 60_000).sort((a, b) => a.lastSeen - b.lastSeen)[0];
    if (!idle) return undefined;
    log(`[sb${idle.slot}] evicted to make room (idle ${Math.round((Date.now() - idle.lastSeen) / 1000)} s)`);
    stopSandbox(idle);
    return 'evicting';
  }
  sb.claimed = true; sb.lastSeen = Date.now();
  setTimeout(topUpSpares, 0);
  return sb;
}

// ---- reaper ----
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

// ---- pages ----
const page = (res, status, title, body, refresh) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...(refresh ? { refresh: String(refresh) } : {}) });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:18vh auto;padding:0 1.5rem;color:#222"><h1 style="font-size:1.4rem">${title}</h1>${body}</body>`);
};
const preparing = (res) => page(res, 200, 'Preparing your private demo…', '<p>Each visitor gets their own copy of the demo, so nothing you do affects anyone else. This takes about ten seconds; the page reloads by itself.</p>', 2);
const busy = (res) => page(res, 503, 'The demo is busy', '<p>All demo sandboxes are in use. Please try again in a few minutes.</p>', 30);

const cookieOf = (req) => /(?:^|;\s*)srs_sb=([0-9a-f]{32})/.exec(String(req.headers.cookie ?? ''))?.[1];
const isPage = (req) => req.method === 'GET' && String(req.headers.accept ?? '').includes('text/html');
const secure = (req) => req.headers['x-forwarded-proto'] === 'https' || String(req.headers['cf-visitor'] ?? '').includes('https');
const setCookie = (req, res, id) => res.setHeader('set-cookie', `srs_sb=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure(req) ? '; Secure' : ''}`);

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
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sandboxes: sandboxes.size, ready: [...sandboxes.values()].filter((s) => s.ready).length, visitors: [...sandboxes.values()].filter((s) => s.claimed).length, max: MAX }));
    return;
  }
  let sb = sandboxes.get(cookieOf(req) ?? '');
  if (sb && (sb.stopping || sb.failed)) sb = undefined;
  if (!sb) {
    if (!isPage(req)) {
      // API calls and assets need a sandbox: the app's assets are the same everywhere, so any ready one serves them
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

function shutdown() { shuttingDown = true; log('stopping all sandboxes'); for (const sb of sandboxes.values()) stopSandbox(sb); setTimeout(() => process.exit(0), 6000).unref(); server.close(); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

topUpSpares();
server.listen(PORT, HOST, () => log(`listening on http://${HOST}:${PORT} (max ${MAX} sandboxes, ${SPARE} spare, idle ${IDLE_MS / 60_000} min)`));
