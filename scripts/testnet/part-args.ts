// One JSON line of register_part arguments per catalog part (used by scripts/testnet/30-parts.sh).
import { hashObject } from '../../core/src/canonical.js';
import { loadCatalog } from '../../core/src/codehash.js';
import { fileURLToPath } from 'node:url';
const catalog = loadCatalog(fileURLToPath(new URL('../..', import.meta.url)));
for (const b of catalog.parts) console.log(JSON.stringify({ id: b.id, version: b.id.split('@')[1], fee_per_call: String(b.fee_per_call), manifest_hash: hashObject(b) }));
