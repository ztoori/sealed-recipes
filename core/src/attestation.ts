/**
 * Runner attestation (FRS-1 §Sealed execution).
 *
 * A runner proves "these keys live inside this code inside a TEE" by putting
 *   report_data = sha256(canonical{ codehash, enc_pk_hex, nonce, signing_pk })
 * into the hardware quote. Clients verify the quote, then seal recipes to enc_pk_hex
 * and accept run reports signed by signing_pk.
 *
 *  tee = "dstack-tdx": quote comes from the dstack guest agent (Phala / NEAR Shade Agent
 *        stack, Intel TDX). We parse the TDX v4 quote and check report_data and the
 *        compose hash; full Intel signature-chain verification is delegated to dcap-qvl
 *        (or https://proof.t16z.com) and reported as its own check.
 *  tee = "local-dev":  no hardware. Everything else is identical so the flow is honest
 *        about exactly which guarantee is missing.
 */
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { canonicalJson, sha256Hex } from './canonical.js';
import { base64 } from './seal.js';
import type { Check } from './nearai.js';

export interface RunnerAttestation {
  v: 'frs-attest-v1';
  tee: 'local-dev' | 'dstack-tdx';
  runner_id: string;
  signing_pk: string; // ed25519:<base58>
  enc_pk_hex: string;
  codehash: string; // sha256 over runner source bundle (see runner/src/codehash.ts)
  compose_hash: string; // sha256 of the deployed docker-compose (mr_config in dstack)
  nonce: string;
  report_data: string;
  quote: string | null; // hex TDX quote
  issued_at: string;
  self_sig: string; // ed25519(report_data) by signing key, proves possession
}

export function reportData(a: Pick<RunnerAttestation, 'codehash' | 'enc_pk_hex' | 'nonce' | 'signing_pk'>): string {
  return sha256Hex(canonicalJson({ codehash: a.codehash, enc_pk_hex: a.enc_pk_hex, nonce: a.nonce, signing_pk: a.signing_pk }));
}

/** TDX quote v4: 48-byte header + TD report body; REPORTDATA is 64 bytes at body offset 520. */
export function tdxReportDataFromQuote(quoteHex: string): string {
  const q = hexToBytes(quoteHex.replace(/^0x/, ''));
  if (q.length < 48 + 584) throw new Error('quote too short');
  const version = q[0] | (q[1] << 8);
  if (version !== 4 && version !== 5) throw new Error(`unsupported quote version ${version}`);
  return Array.from(q.slice(568, 632), (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface Expected { nonce: string; signing_pk?: string; enc_pk_hex?: string; codehash?: string; compose_hash?: string }

export function verifyRunnerAttestation(a: RunnerAttestation, exp: Expected): { ok: boolean; hardware: boolean; checks: Check[] } {
  const checks: Check[] = [];
  const add = (id: string, label: string, pass: boolean | null, detail: string) => checks.push({ id, label, status: pass === null ? 'skip' : pass ? 'pass' : 'fail', detail });

  add('nonce', 'Fresh nonce echoed (anti-replay)', a.nonce === exp.nonce, a.nonce);
  const rd = reportData(a);
  add('report_data', 'report_data = sha256(codehash, enc key, nonce, signing key)', rd === a.report_data, rd);
  let sigOk = false;
  try { sigOk = nacl.sign.detached.verify(utf8ToBytes(a.report_data), base64.dec(a.self_sig), bs58.decode(a.signing_pk.replace(/^ed25519:/, ''))); } catch { sigOk = false; }
  add('possession', 'Runner proves possession of its signing key', sigOk, a.signing_pk);
  if (exp.signing_pk) add('onchain.signing', 'Signing key matches runner registered on-chain', a.signing_pk === exp.signing_pk, exp.signing_pk);
  if (exp.enc_pk_hex) add('onchain.enc', 'Encryption key matches runner registered on-chain', a.enc_pk_hex === exp.enc_pk_hex, exp.enc_pk_hex);
  if (exp.codehash) add('codehash', 'Runner code hash matches the audited release', a.codehash === exp.codehash, a.codehash);

  let hardware = false;
  if (a.tee === 'dstack-tdx' && a.quote) {
    let qrd = '';
    try { qrd = tdxReportDataFromQuote(a.quote); } catch (e) { qrd = 'parse error: ' + (e as Error).message; }
    add('tdx.report_data', 'TDX quote REPORTDATA carries our report_data', qrd.startsWith(a.report_data), qrd);
    if (exp.compose_hash) add('tdx.compose', 'Compose hash matches expected deployment (mr_config)', a.compose_hash === exp.compose_hash, a.compose_hash);
    add('tdx.chain', 'Intel signature chain (dcap-qvl / proof.t16z.com)', null, 'run `npx tsx scripts/verify-quote.ts` or paste the quote at https://proof.t16z.com');
    hardware = checks.every((c) => c.status !== 'fail');
  } else {
    add('tdx.quote', 'Hardware TDX quote', null, 'local-dev runner: no hardware quote. Deploy runner/ to a TDX CVM (dstack) to enable.');
  }
  return { ok: checks.every((c) => c.status !== 'fail'), hardware, checks };
}
