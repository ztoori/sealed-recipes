// Prints the runner identity to register with add_runner: signing key, encryption key and code hash.
// Creates the local-dev keys at RUNNER_KEYS_PATH on first use (the live runner service uses the same file).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKeys } from '../../runner/src/keys.js';
import { sha256Hex } from '../../core/src/canonical.js';
const root = fileURLToPath(new URL('../..', import.meta.url));
const path = process.env.RUNNER_KEYS_PATH;
if (!path) { console.error('set RUNNER_KEYS_PATH (the runner key file)'); process.exit(2); }
const composeHash = sha256Hex(readFileSync(resolve(root, 'runner/docker-compose.yml'), 'utf8').replace(/\r\n/g, '\n'));
const keys = await loadKeys('local-dev', path, composeHash);
const codehash = readFileSync(resolve(root, 'AUDITED_CODEHASH'), 'utf8').trim();
console.log(JSON.stringify({ signing_pk: keys.signingPk, enc_pk_hex: keys.encPkHex, codehash }));
