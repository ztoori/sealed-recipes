#!/usr/bin/env node
/**
 * Records the demo video + screenshots used in the X post and README.
 *   1. npm run demo   (in another terminal; restart it first so CLNP is not yet listed)
 *   2. node scripts/record-demo.mjs        → docs/media/demo.mp4 (needs ffmpeg) + docs/media/*.png
 * Needs Playwright with Chromium: `npx playwright install chromium` if you don't have it.
 */
import { createRequire } from 'node:module';
import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'docs/media');
const BASE = process.env.FRS_URL ?? 'http://127.0.0.1:8080';
let chromium;
try { ({ chromium } = await import('playwright')); } catch {
  try { const g = execSync('npm root -g').toString().trim(); ({ chromium } = createRequire(g + '/')('playwright')); } catch { console.error('Playwright not found: npm i -D playwright && npx playwright install chromium'); process.exit(1); }
}
mkdirSync(out, { recursive: true });
const tmp = resolve(out, '.video'); rmSync(tmp, { recursive: true, force: true });

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
await card('Fungible Recipes', 'Your workflow is the edge. Seal it, list it, and get paid every time it runs.<br/><span style="color:#f2c14e">Built at NEAR HACKATHON</span>');
await page.waitForTimeout(3500); await uncard();
await page.waitForTimeout(2500); await shot('01-exchange.png');
await page.getByRole('button', { name: 'Play the demo story' }).click();
const t0 = Date.now(); let shots = 0;
while (Date.now() - t0 < 120_000) {
  await page.waitForTimeout(500);
  if (shots === 0 && await page.locator('.waxseal.on').count()) { await page.waitForTimeout(700); await shot('02-sealed.png'); shots++; }
  if (shots === 1 && await page.locator('.wallet-modal').count()) { await shot('03-wallet-approval.png'); shots++; }
  if (shots === 2 && await page.getByText('report_run verified').count()) { await page.waitForTimeout(800); await shot('04-execution.png'); shots++; }
  if (shots === 3 && await page.locator('.sankey').count()) { await page.waitForTimeout(1500); await shot('05-settlement.png'); shots++; }
  if (await page.getByText('That was one complete run').count()) break;
}
await page.waitForTimeout(2000);
await page.getByRole('button', { name: 'Open CLNP' }).click(); await page.waitForTimeout(3500); await shot('06-exchange-clnp.png');
await page.selectOption('select[aria-label="Acting as account"]', 'chef.testnet');
await page.getByRole('button', { name: 'Wallet', exact: true }).click(); await page.waitForTimeout(2500); await shot('07-wallet-dividends.png');
await page.getByRole('button', { name: 'Trust & privacy', exact: true }).click(); await page.waitForTimeout(3500); await shot('08-trust.png');
await page.mouse.wheel(0, 500); await page.waitForTimeout(2500);
await card('Sealed recipes. Paid per run. Traded like stocks.', 'NEAR Intents for payment and confidential swaps · TEE runner with attestation · NEAR AI Cloud verified inference · one settlement pays everyone');
await page.waitForTimeout(4000);
await ctx.close(); await browser.close();

const webm = readdirSync(tmp).find((f) => f.endsWith('.webm'));
renameSync(resolve(tmp, webm), resolve(out, 'demo.webm')); rmSync(tmp, { recursive: true, force: true });
const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', resolve(out, 'demo.webm'), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', resolve(out, 'demo.mp4')], { stdio: 'inherit' });
if (ff.status === 0) rmSync(resolve(out, 'demo.webm'));
console.log('wrote', readdirSync(out).join(', '));
