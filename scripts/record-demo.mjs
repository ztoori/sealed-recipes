#!/usr/bin/env node
/**
 * Records the demo video + screenshots used in the X post and README.
 *   1. SRS_PRICE_PERIOD_S=20 npm run demo   (in another terminal; restart it first so CLNP is not yet listed)
 *   2. npm run pricing-demo                 (real paid runs, so the market-price shot has history to show)
 *   3. node scripts/record-demo.mjs        → docs/media/demo.mp4 (needs ffmpeg) + docs/media/*.png
 * Needs Playwright with Chromium: `npx playwright install chromium` if you don't have it.
 */
import { createRequire } from 'node:module';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'docs/media');
const BASE = process.env.SRS_URL ?? 'http://127.0.0.1:8080';
let chromium;
try { ({ chromium } = await import('playwright')); } catch {
  try { const g = execSync('npm root -g').toString().trim(); ({ chromium } = createRequire(g + '/')('playwright')); } catch { console.error('Playwright not found: npm i -D playwright && npx playwright install chromium'); process.exit(1); }
}
mkdirSync(out, { recursive: true });
// never delete: previous media is moved to archive/media-<timestamp>/
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const archive = resolve(root, 'archive', `media-${stamp}`);
const previous = readdirSync(out);
if (previous.length) { mkdirSync(archive, { recursive: true }); for (const f of previous) renameSync(resolve(out, f), resolve(archive, f)); console.log(`archived ${previous.length} previous media file(s) to ${archive}`); }
const tmp = resolve(out, '.video');

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, recordVideo: { dir: tmp, size: { width: 1440, height: 900 } } });
const page = await ctx.newPage();
const card = (title, sub) => page.evaluate(([t, s]) => {
  const d = document.createElement('div'); d.id = 'rec-card';
  d.style.cssText = 'position:fixed;inset:0;z-index:99;background:#15233f;color:#fff;display:grid;place-items:center;text-align:center;font-family:Archivo Variable,system-ui';
  d.innerHTML = `<div style="max-width:900px;padding:40px"><div style="font-family:Newsreader Variable,Georgia,serif;font-size:64px;line-height:1.05">${t}</div><div style="margin-top:22px;font-size:24px;color:#c9d3e6;line-height:1.4">${s}</div></div>`;
  document.body.appendChild(d);
}, [title, sub]);
const uncard = () => page.evaluate(() => document.getElementById('rec-card')?.remove());
const shot = (n) => page.screenshot({ path: resolve(out, n) });

await page.goto(BASE); await page.waitForTimeout(1200);
await card('Sealed Recipes', 'Private workflows for everyday crypto safety: they compete with signed quotes, and every builder gets paid.<br/><span style="color:#f2c14e">Built at NEAR HACKATHON</span>');
await page.waitForTimeout(3500); await uncard();
await page.waitForTimeout(2500); await shot('01-recipes.png');
await page.getByRole('button', { name: 'Play the demo story' }).click();
const t0 = Date.now(); let shots = 0;
while (Date.now() - t0 < 150_000) {
  await page.waitForTimeout(500);
  if (shots === 0 && await page.locator('.waxseal.on').count()) { await page.waitForTimeout(700); await shot('02-sealed.png'); shots++; }
  if (shots === 1 && await page.locator('#quote').count()) { await page.waitForTimeout(1200); await shot('03-quote.png'); shots++; }
  if (shots === 2 && await page.locator('.wallet-modal').count()) { await shot('04-wallet-approval.png'); shots++; }
  if (shots === 3 && await page.getByText('report_run verified').count()) { await page.waitForTimeout(800); await shot('05-execution.png'); shots++; }
  if (shots === 4 && await page.locator('.sankey').count()) { await page.waitForTimeout(1500); await shot('06-settlement.png'); shots++; }
  if (await page.getByText('That was one job, end to end').count()) break;
}
await page.waitForTimeout(2000);
await page.getByRole('button', { name: 'Open CLNP' }).click(); await page.waitForTimeout(3500); await shot('07-recipe-clnp.png');
await page.selectOption('select[aria-label="Acting as account"]', 'chef.testnet');
await page.getByRole('button', { name: 'Wallet', exact: true }).click(); await page.waitForTimeout(2500); await shot('08-wallet.png');
await page.getByRole('button', { name: 'Documentation', exact: true }).click(); await page.waitForTimeout(3500); await shot('09-trust.png');
await page.getByRole('tab', { name: 'Landscape' }).click(); await page.waitForTimeout(2500); await shot('11-landscape.png');
await page.getByRole('button', { name: 'Recipes', exact: true }).click(); await page.waitForTimeout(1200);
await page.fill('input[type=search]', 'contract'); await page.waitForTimeout(800);
await page.getByText('Contract check before you sign').first().click(); await page.waitForTimeout(2500); await shot('12-recipe-search.png');
await page.getByRole('button', { name: 'Compose', exact: true }).click(); await page.waitForTimeout(1200);
await page.getByText('Revoke risky app keys').first().click(); await page.waitForTimeout(800);
for (const n of ['Access Key Reader', 'Key Risk Rules', 'Key Revoker']) { await page.getByRole('button', { name: `Add ${n}` }).first().click(); await page.waitForTimeout(900); }
await shot('10-compose-recipe.png');
await page.getByRole('tab', { name: /Part/ }).click(); await page.waitForTimeout(800);
await page.getByText('AI Contract Risk').first().click(); await page.waitForTimeout(1800); await shot('13-compose-part.png');
await page.waitForTimeout(1500);
await card('Intents for workflows.', 'Ten recipes for common crypto problems, composed from public parts without code. Sealed recipes compete with signed quotes, backed by each creator’s guarantee deposit. No shares, no tokens: you pay per run. NEAR Intents for payment and confidential swaps, an attested TEE runner, NEAR AI Cloud private models, and one settlement that pays every builder.');
await page.waitForTimeout(4000);
await ctx.close(); await browser.close();

const webm = readdirSync(tmp).find((f) => f.endsWith('.webm'));
const raw = resolve(existsSync(archive) ? archive : (mkdirSync(archive, { recursive: true }), archive), 'demo-raw.webm');
renameSync(resolve(tmp, webm), raw); // raw recording kept in the archive folder
const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', resolve(out, 'demo.mp4')], { stdio: 'inherit' });
if (ff.status !== 0) console.warn('ffmpeg not available: raw video is at ' + raw);
console.log('wrote', readdirSync(out).join(', '));
