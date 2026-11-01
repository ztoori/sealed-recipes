/**
 * Seeds the local market with three published recipes (SWPR, EXIT, SAFE) exactly the way
 * a creator's client would: verify the runner attestation, seal in the client, publish
 * only the public listing + ciphertext. CLNP is deliberately NOT seeded: the demo story
 * (and you, in the Composer) build and publish it live.
 */
import { readFileSync } from 'node:fs';
import { api, publish, verifiedRunner } from './lib/client.js';
import type { Catalog, Recipe } from '../core/src/index.js';

const root = new URL('..', import.meta.url);
const catalog = JSON.parse(readFileSync(new URL('standard/blocks.json', root), 'utf8')) as Catalog;
const load = (t: string) => JSON.parse(readFileSync(new URL(`seed/recipes/${t}.json`, root), 'utf8')) as Recipe;

const { onchain, checks } = await verifiedRunner();
console.log(`[seed] runner attestation: ${checks.filter((c) => c.status === 'pass').length} checks passed, ${checks.filter((c) => c.status === 'skip').length} skipped (no hardware in local-dev)`);

const IPO: Record<string, { price: number; float_pct: number }> = { SWPR: { price: 0.012, float_pct: 20 }, EXIT: { price: 0.21, float_pct: 15 }, SAFE: { price: 0.03, float_pct: 25 } };
const listings = await api<{ ticker: string }[]>('/api/listings');
for (const t of Object.keys(IPO)) {
  if (listings.some((l) => l.ticker === t)) continue;
  const r = await publish(load(t), catalog, onchain.enc_pk_hex, IPO[t]);
  console.log(`[seed] published ${t}  sealed_hash ${r.sealed_hash.slice(0, 16)}…  tx ${r.tx}`);
  // sim traders join the opening auction automatically (server, local mode)
}
console.log('[seed] done');
