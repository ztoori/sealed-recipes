/** Owner action: pin the audited runner release. Writes AUDITED_CODEHASH, which the marketplace registers on-chain. */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeCodehash } from '../core/src/codehash.js';
const root = fileURLToPath(new URL('..', import.meta.url));
const { codehash, files } = computeCodehash(root);
writeFileSync(new URL('../AUDITED_CODEHASH', import.meta.url), codehash + '\n');
console.log(`pinned ${codehash} over ${files.length} files`);
