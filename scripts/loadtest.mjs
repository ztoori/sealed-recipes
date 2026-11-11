#!/usr/bin/env node
/**
 * Load test for the public demo gateway:  npm run loadtest -- [options]
 *
 * Simulates many visitors at once, each in their own sandbox, and reports what they experienced plus the
 * gateway's own metrics (memory, swap, latency) when run on the same machine.
 *
 *   --url http://127.0.0.1:8080   gateway address (a public https URL works too; see the per-IP note below)
 *   --visitors 20                 visitors at once
 *   --ramp 10                     seconds over which visitors arrive
 *   --duration 60                 seconds each browsing visitor stays (browse mode)
 *   --mode browse|story           browse: page + the API calls the app makes, with think time (cheap, scales far)
 *                                 story: each visitor plays the full CLI story in their sandbox (compose, seal,
 *                                 publish, quote, pay, run, settle): the heaviest realistic load
 *
 * Locally each visitor sends its own cf-connecting-ip, so the per-address sandbox limit (SANDBOX_PER_IP) counts them
 * separately. Through Cloudflare the real address is used: from one machine you can create only SANDBOX_PER_IP
 * sandboxes per 10 minutes unless you raise it while testing.
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const URL_ = arg('url', 'http://127.0.0.1:8080').replace(/\/$/, '');
const VISITORS = Number(arg('visitors', 20));
const RAMP_S = Number(arg('ramp', 10));
const DURATION_S = Number(arg('duration', 60));
const MODE = arg('mode', 'browse');
const local = /^http:\/\/(127\.0\.0\.1|localhost)/.test(URL_);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const lat = {}; const errors = {}; const outcomes = { ready: 0, busy: 0, failed: 0 };
const readyMs = []; const storyMs = []; let storyOk = 0, storyFail = 0;
const note = (name, ms, ok, why) => { (lat[name] ??= []).push(ms); if (!ok) { errors[name] = (errors[name] ?? 0) + 1; if (why && !errors[`${name}: ${why}`]) errors[`${name}: ${why}`] = 1; } };

async function timed(name, url, init) {
  const t = Date.now();
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    const body = await r.text();
    note(name, Date.now() - t, r.ok, r.ok ? undefined : String(r.status));
    return { r, body };
  } catch (e) { note(name, Date.now() - t, false, e.name); return { r: undefined, body: '' }; }
}

/** arrive like a browser: first page view gets the cookie, then reload until the sandbox is ready */
async function arrive(i) {
  const ip = `10.77.${Math.floor(i / 250)}.${(i % 250) + 1}`;
  const base = { accept: 'text/html', ...(local ? { 'cf-connecting-ip': ip } : {}) };
  const t = Date.now();
  let cookie;
  for (let k = 0; k < 90; k++) {
    const { r, body } = await timed('page', `${URL_}/`, { headers: { ...base, ...(cookie ? { cookie } : {}) } });
    if (!r) { await sleep(1000); continue; }
    if (r.status === 503) { outcomes.busy++; return undefined; }
    const set = r.headers.get('set-cookie');
    if (set) cookie = /srs_sb=[0-9a-f]+/.exec(set)?.[0];
    if (!body.includes('Preparing your private demo')) { readyMs.push(Date.now() - t); outcomes.ready++; return { cookie, ip, html: body }; }
    await sleep(1000);
  }
  outcomes.failed++;
  return undefined;
}

const API_CALLS = ['/api/mode', '/api/listings', '/api/recipes/summary', '/api/catalog', '/api/tokens', '/api/runs', '/api/chain/config', '/api/chain/events?last=20'];
async function browse(i) {
  const v = await arrive(i);
  if (!v) return;
  const headers = { cookie: v.cookie, ...(local ? { 'cf-connecting-ip': v.ip } : {}) };
  const asset = /src="(\/assets\/[^"]+\.js)"/.exec(v.html)?.[1];
  if (asset) await timed('asset', `${URL_}${asset}`, { headers });
  const end = Date.now() + DURATION_S * 1000;
  while (Date.now() < end) {
    // one "screen": the calls the app makes, a few in parallel like a browser, then think time
    const batch = [...API_CALLS].sort(() => Math.random() - 0.5).slice(0, 3);
    await Promise.all(batch.map((p) => timed(p.split('?')[0], `${URL_}${p}`, { headers })));
    await sleep(1000 + Math.random() * 2000);
  }
}

async function story(i) {
  const v = await arrive(i);
  if (!v) return;
  const t = Date.now();
  const code = await new Promise((ok) => {
    const p = spawn(process.execPath, ['--import', 'tsx', 'scripts/story-cli.ts'], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, SRS_URL: URL_, SRS_COOKIE: v.cookie, ...(local ? { SRS_CLIENT_IP: v.ip } : {}) } });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (c) => { if (c) { const why = err.trim().split('\n').find((l) => /Error|→/.test(l)) ?? `exit ${c}`; errors[`story: ${why.slice(0, 120)}`] = (errors[`story: ${why.slice(0, 120)}`] ?? 0) + 1; } ok(c ?? 1); });
  });
  storyMs.push(Date.now() - t);
  code === 0 ? storyOk++ : storyFail++;
}

const gatewayMetrics = async () => {
  if (!local) return undefined;
  try { return await (await fetch(`${URL_}/gateway/metrics`)).json(); } catch { return undefined; }
};
const p = (xs, q) => { if (!xs.length) return '-'; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((q / 100) * s.length))]; };
let peak = { rss: 0, visitors: 0, availMin: Infinity, swapMax: 0 };
async function sample() {
  const m = await gatewayMetrics();
  if (!m) return;
  const procs = m.memory.processes;
  const rss = (procs.gateway.rss_mb ?? 0) + (procs.runner?.rss_mb ?? 0) + procs.sandboxes.reduce((a, s) => a + (s.rss_mb ?? 0), 0);
  peak = { rss: Math.max(peak.rss, rss), visitors: Math.max(peak.visitors, m.sandboxes.visitors), availMin: Math.min(peak.availMin, m.memory.system.available_mb),
    swapMax: Math.max(peak.swapMax, (m.memory.system.swap_total_mb ?? 0) - (m.memory.system.swap_free_mb ?? 0)), perSandbox: m.memory.per_sandbox_rss_mb_avg, runner: procs.runner?.rss_mb };
}

console.log(`[loadtest] ${VISITORS} visitors, ${MODE} mode, ramp ${RAMP_S} s${MODE === 'browse' ? `, ${DURATION_S} s each` : ''}, against ${URL_}`);
const before = await gatewayMetrics();
if (before) console.log(`[loadtest] before: ${before.sandboxes.running} sandboxes, ${before.memory.system.available_mb} MB available`);
const sampler = setInterval(() => void sample(), 2000);
const t0 = Date.now();
await Promise.all(Array.from({ length: VISITORS }, async (_, i) => {
  await sleep((RAMP_S * 1000 * i) / Math.max(1, VISITORS));
  await (MODE === 'story' ? story(i) : browse(i));
}));
clearInterval(sampler);
await sample();
const after = await gatewayMetrics();

console.log(`\n[loadtest] done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
console.log(`visitors: ${outcomes.ready} got a sandbox, ${outcomes.busy} saw "busy", ${outcomes.failed} timed out waiting`);
console.log(`time to a ready sandbox: p50 ${p(readyMs, 50)} ms, p95 ${p(readyMs, 95)} ms, max ${p(readyMs, 100)} ms`);
if (MODE === 'story') console.log(`stories: ${storyOk} passed, ${storyFail} failed; duration p50 ${(Number(p(storyMs, 50)) / 1000).toFixed(1)} s, p95 ${(Number(p(storyMs, 95)) / 1000).toFixed(1)} s`);
console.log('\nrequest latency (ms)            count    p50    p95    p99  errors');
for (const [k, xs] of Object.entries(lat).sort()) console.log(`  ${k.padEnd(28)} ${String(xs.length).padStart(6)} ${String(p(xs, 50)).padStart(6)} ${String(p(xs, 95)).padStart(6)} ${String(p(xs, 99)).padStart(6)} ${String(errors[k] ?? 0).padStart(7)}`);
const detail = Object.entries(errors).filter(([k]) => k.includes(':'));
if (detail.length) { console.log('\nerrors:'); for (const [k, n] of detail) console.log(`  ${n} × ${k}`); }
if (after) {
  console.log(`\nserver (peak during the test): ${peak.visitors} visitors at once; node processes ${peak.rss.toFixed(0)} MB RSS; ` +
    `per sandbox ≈ ${peak.perSandbox} MB, shared runner ${peak.runner} MB; lowest available memory ${peak.availMin} MB; swap used up to ${peak.swapMax} MB`);
  console.log(`gateway totals: ${after.totals.sessions} sessions, ${after.totals.busy_pages} busy pages, ${after.totals.evictions} evictions, ${after.totals.boot_failures} boot failures, runner restarts ${after.totals.runner_restarts}; sandbox boot p50 ${after.boot_s.p50} s, p95 ${after.boot_s.p95} s`);
}
