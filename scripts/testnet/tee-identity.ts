/**
 * The identity of the runner running in a TDX CVM, read from its attestation and checked before it is registered:
 * the TDX quote must pass Intel DCAP verification (dcap-qvl), its REPORTDATA must bind the runner's keys to a fresh
 * nonce, and the code hash must be the audited release in AUDITED_CODEHASH. Prints the add_runner arguments.
 *   RUNNER_URL=https://<app-id>-8787.<node>.phala.network node --import tsx scripts/testnet/tee-identity.ts
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getCollateralAndVerify } from '@phala/dcap-qvl';
import { verifyRunnerAttestation, type RunnerAttestation } from '../../core/src/attestation.js';

const url = process.env.RUNNER_URL;
if (!url) { console.error('set RUNNER_URL to the CVM\'s public URL for port 8787'); process.exit(2); }
const audited = readFileSync(new URL('../../AUDITED_CODEHASH', import.meta.url), 'utf8').trim();
const nonce = randomBytes(32).toString('hex');
const a = (await fetch(`${url}/attestation?nonce=${nonce}`).then((r) => r.json())) as RunnerAttestation;
if (a.tee !== 'dstack-tdx' || !a.quote) { console.error(`no hardware quote (tee: ${a.tee}): is TEE_MODE=dstack set in the compose?`); process.exit(1); }
const dcap = await getCollateralAndVerify(Buffer.from(a.quote.replace(/^0x/, ''), 'hex'));
const upToDate = ['UpToDate', 'SWHardeningNeeded'].includes(String(dcap.status));
const v = verifyRunnerAttestation(a, { nonce, codehash: audited, dcapVerified: upToDate });
for (const c of v.checks) console.error(`${c.status.padEnd(4)}  ${c.label}`);
console.error(`Intel DCAP: TCB status ${dcap.status}; compose_hash ${a.compose_hash}`);
if (!v.hardware) { console.error('not registering: the attestation is not hardware-verified with the audited code hash'); process.exit(1); }
console.log(JSON.stringify({ signing_pk: a.signing_pk, enc_pk_hex: a.enc_pk_hex, codehash: a.codehash, compose_hash: a.compose_hash }));
