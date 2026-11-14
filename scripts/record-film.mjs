#!/usr/bin/env node
/**
 * Turns the guided demo film (web/src/components/DemoFilm.tsx) into an MP4, picture and sound.
 *
 *   npm run build                     (the film is recorded from web/dist)
 *   npm run record:film               → docs/media/demo.mp4      the full film, as on sealedrecipes.xyz/#/demo
 *   npm run record:x                  → docs/media/demo-x.mp4    the shorter cut for an X post (under 140 s)
 *
 * The film is drawn in code, so it is not screen-captured in real time: this script steps it frame by frame
 * (the page's `demo-film-seek` event), takes a screenshot of each frame and pipes them to ffmpeg. The result is
 * the same on a slow machine as on a fast one. The sound is laid under it from the same screenplay: each narration
 * clip at its line's time (web/public/assets/film/, made by scripts/film-voice.ts) and the effects, which the page
 * renders offline with the instruments it plays live (demo-film/audio.ts, renderEffects).
 *
 * Options: --cut full|x   --out FILE   --fps 30   --width 1280 (height follows, 16:9)   --stills 3,12.5,40 (PNG
 * frames at those film seconds into docs/media/stills/, no video)   --no-audio
 *
 * Needs ffmpeg, and Playwright with Chromium (`npx playwright install chromium`), or an installed Chrome:
 * SRS_CHROME=/usr/bin/google-chrome. Nothing here needs the network, a server or a key: prices and names in the
 * recording are the film's built-in sample (DemoFilm.tsx, FALLBACK), not a live read.
 */
import { createRequire } from 'node:module';
import { execSync, spawn, spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, process.env.SRS_DIST ?? 'web/dist');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const cut = arg('--cut', 'full');
const fps = Number(arg('--fps', 30));
const width = Number(arg('--width', 1280)), height = Math.round((width * 9) / 16 / 2) * 2;
const out = resolve(root, arg('--out', cut === 'x' ? 'docs/media/demo-x.mp4' : 'docs/media/demo.mp4'));
const stills = arg('--stills');
const withAudio = !process.argv.includes('--no-audio');

if (!existsSync(join(dist, 'live.html'))) { console.error('web/dist is missing: run `npm run build` first'); process.exit(1); }
if (spawnSync('ffmpeg', ['-version']).status !== 0) { console.error('ffmpeg is required (sudo apt install ffmpeg)'); process.exit(1); }
let chromium;
try { ({ chromium } = await import('playwright')); } catch {
  try { const g = execSync('npm root -g').toString().trim(); ({ chromium } = createRequire(g + '/')('playwright')); } catch { console.error('Playwright not found: npm i -D playwright && npx playwright install chromium'); process.exit(1); }
}

// the built site, served from this process; anything else (the API) answers 404, so the film uses its sample data
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = normalize(join(dist, path === '/' ? 'live.html' : path));
  if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}'); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }); createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch(process.env.SRS_CHROME ? { executablePath: process.env.SRS_CHROME } : {});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
await page.goto(`${base}/?record=1&cut=${cut}#/demo`);
await page.waitForFunction(() => !!window.__demoFilm);
await page.evaluate(() => document.fonts.ready);
const film = await page.evaluate(() => { const f = window.__demoFilm; return { end: f.end, rate: f.rate, beats: f.beats }; });
const seconds = film.end / film.rate;

/** show the film at `t` film seconds: the picture is a function of the clock; CSS animations follow the same clock */
const show = (t) => page.evaluate(async ([t, real]) => {
  window.dispatchEvent(new CustomEvent('demo-film-seek', { detail: t }));
  for (const a of document.getAnimations()) if (a instanceof CSSAnimation) { a.pause(); a.currentTime = real * 1000; }
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}, [t, t / film.rate]);

if (stills) {
  const dir = resolve(root, 'docs/media/stills'); mkdirSync(dir, { recursive: true });
  for (const t of stills.split(',').map(Number)) { await show(t); await page.screenshot({ path: join(dir, `${cut}-${String(t).padStart(5, '0')}.png`) }); }
  console.log(`stills in ${dir}`); await browser.close(); server.close(); process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), 'film-'));
// ---- sound: narration clips at their lines' times (played at the film's rate, as on the page), over the effects
const inputs = [], filters = [], mix = [];
if (withAudio) {
  const voice = await page.evaluate(() => window.__demoFilm.voice());
  const fx = await page.evaluate((s) => window.__demoFilm.effects(s), seconds + 0.5);
  writeFileSync(join(tmp, 'fx.wav'), Buffer.from(fx, 'base64'));
  inputs.push('-i', join(tmp, 'fx.wav')); filters.push('[1:a]volume=0.55[fx]'); mix.push('[fx]');
  let n = 2;
  for (const b of film.beats) {
    const f = voice.clips[b.id]; if (!f) continue;
    const file = join(dist, 'assets/film', f);
    const len = Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).stdout.toString().trim());
    const next = film.beats[film.beats.indexOf(b) + 1]?.at ?? film.end;
    if (b.at + len > next) console.warn(`${b.id} is still being spoken when the next line starts (${len.toFixed(2)} s in a ${(next - b.at).toFixed(1)} s beat): shorten it, or move the next line`);
    inputs.push('-i', file);
    filters.push(`[${n}:a]atempo=${film.rate},adelay=${Math.round((b.at / film.rate) * 1000)}:all=1[v${n}]`); mix.push(`[v${n}]`); n++;
  }
  filters.push(`${mix.join('')}amix=inputs=${mix.length}:normalize=0,alimiter=limit=0.95,apad=whole_dur=${seconds.toFixed(3)},pan=stereo|c0=c0|c1=c0[a]`);
}

// ---- picture: one screenshot per frame, piped to ffmpeg
mkdirSync(dirname(out), { recursive: true });
const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', 'pipe:0', ...inputs,
  ...(withAudio ? ['-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[a]', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100'] : []),
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(fps), '-t', seconds.toFixed(3), '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
const done = new Promise((r) => ff.on('close', r));
const frames = Math.ceil(seconds * fps);
const t0 = Date.now();
for (let i = 0; i < frames; i++) {
  await show(Math.min(film.end, (i / fps) * film.rate));
  const jpg = await page.screenshot({ type: 'jpeg', quality: 95 });
  if (!ff.stdin.write(jpg)) await new Promise((r) => ff.stdin.once('drain', r));
  if (i % (fps * 10) === 0) process.stdout.write(`\r${cut}: ${Math.round((i / frames) * 100)}%  (${Math.round((Date.now() - t0) / 1000)} s)   `);
}
ff.stdin.end();
const code = await done;
await browser.close(); server.close(); rmSync(tmp, { recursive: true, force: true });
if (code !== 0) { console.error('\nffmpeg failed'); process.exit(1); }
const mb = (statSync(out).size / 1e6).toFixed(1);
console.log(`\n${out}: ${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}, ${width}×${height} at ${fps} fps, ${mb} MB${cut === 'x' ? (seconds <= 140 ? ' (within X’s 140 s limit)' : ' ← LONGER than X’s 140 s limit') : ''}`);

