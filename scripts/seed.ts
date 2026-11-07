import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../core/src/codehash.js';
/**
 * Seeds the local marketplace with nine published recipes (SWPR, EXIT, SAFE, TRCH, ATOM, KEYS, STAK, CHEK, TRIM) exactly the way
 * a creator's client would: verify the runner attestation, seal in the client, publish
 * only the public listing + ciphertext. CLNP is deliberately NOT seeded: the demo story
 * (and you, in the Composer) build and publish it live.
 */
import { readFileSync } from 'node:fs';
import { api, publish, verifiedRunner } from './lib/client.js';
import type { Catalog, Recipe } from '../core/src/index.js';

const root = new URL('..', import.meta.url);
const catalog = loadCatalog(fileURLToPath(root));
const load = (t: string) => JSON.parse(readFileSync(new URL(`seed/recipes/${t}.json`, root), 'utf8')) as Recipe;

const { onchain, checks } = await verifiedRunner();
console.log(`[seed] runner attestation: ${checks.filter((c) => c.status === 'pass').length} checks passed, ${checks.filter((c) => c.status === 'skip').length} skipped (no hardware in local-dev)`);

const SEEDED = ['SWPR', 'EXIT', 'SAFE', 'TRCH', 'ATOM', 'KEYS', 'STAK', 'CHEK', 'TRIM'];
const listings = await api<{ ticker: string }[]>('/api/listings');
for (const t of SEEDED) {
  if (listings.some((l) => l.ticker === t)) continue;
  const r = await publish(load(t), catalog, onchain.enc_pk_hex);
  console.log(`[seed] published ${t}  sealed_hash ${r.sealed_hash.slice(0, 16)}…  tx ${r.tx}`);
}
console.log('[seed] done');
