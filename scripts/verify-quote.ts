/**
 * Full Intel DCAP verification of a dstack runner's TDX quote (needs network for PCCS collateral).
 *   RUNNER_URL=https://your-cvm:8787 npx tsx scripts/verify-quote.ts
 * In local-dev mode there is no quote; the script says so and exits 2.
 */
import { randomBytes } from 'node:crypto';
import { getCollateralAndVerify } from '@phala/dcap-qvl';
import { tdxReportDataFromQuote, verifyRunnerAttestation, type RunnerAttestation } from '../core/src/attestation.js';

const RUNNER = process.env.RUNNER_URL ?? 'http://127.0.0.1:8787';
const nonce = randomBytes(32).toString('hex');
const a = (await fetch(`${RUNNER}/attestation?nonce=${nonce}`).then((r) => r.json())) as RunnerAttestation;
const v = verifyRunnerAttestation(a, { nonce });
for (const c of v.checks) console.log(`${c.status.padEnd(4)}  ${c.label}`);
if (!a.quote) { console.log('\nno hardware quote: this runner is in local-dev mode (TEE_MODE=dstack inside a TDX CVM produces one)'); process.exit(2); }
const quote = Buffer.from(a.quote.replace(/^0x/, ''), 'hex');
const res = await getCollateralAndVerify(quote);
console.log(`\nIntel DCAP verification: TCB status ${res.status}${res.advisory_ids?.length ? ' advisories ' + res.advisory_ids.join(',') : ''}`);
const rd = tdxReportDataFromQuote(a.quote);
console.log(`REPORTDATA binds runner keys + nonce: ${rd.startsWith(a.report_data) ? 'yes' : 'NO'}`);
process.exit(rd.startsWith(a.report_data) && v.ok ? 0 : 1);
