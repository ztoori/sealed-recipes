/**
 * Sealing: a recipe (or a buyer's inputs) is encrypted on the client to the TEE
 * runner's attested X25519 key. Only code inside the enclave holds the secret key.
 * The marketplace stores the envelope; the chain stores sha256(envelope).
 *
 * Construction: NaCl box (X25519 + XSalsa20-Poly1305) with an ephemeral sender key,
 * i.e. an anonymous "sealed box". Runs unchanged in the browser and in Node.
 */
import nacl from 'tweetnacl';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { canonicalJson, sha256Hex } from './canonical.js';

export interface SealedEnvelope {
  v: 'frs-seal-v1';
  alg: 'x25519-xsalsa20poly1305';
  purpose: 'recipe' | 'inputs' | 'output';
  to: string; // runner X25519 public key (hex)
  epk: string; // ephemeral public key (hex)
  nonce: string; // base64
  ct: string; // base64
}

const b64 = {
  enc(u8: Uint8Array): string {
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  },
  dec(s: string): Uint8Array {
    const bin = atob(s);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  },
};
export const base64 = b64;

export function seal(payload: unknown, runnerEncPkHex: string, purpose: SealedEnvelope['purpose']): SealedEnvelope {
  const to = hexToBytes(runnerEncPkHex);
  if (to.length !== 32) throw new Error('runner encryption key must be 32 bytes');
  const eph = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  // random salt so the plaintext commitment cannot be brute-forced from guesses
  const salt = bytesToHex(nacl.randomBytes(16));
  const msg = utf8ToBytes(canonicalJson({ salt, payload }));
  const ct = nacl.box(msg, nonce, to, eph.secretKey);
  eph.secretKey.fill(0);
  return { v: 'frs-seal-v1', alg: 'x25519-xsalsa20poly1305', purpose, to: runnerEncPkHex, epk: bytesToHex(eph.publicKey), nonce: b64.enc(nonce), ct: b64.enc(ct) };
}

/** Only callable where the runner's secret key lives (inside the TEE). */
export function open<T = unknown>(env: SealedEnvelope, runnerEncSecretKey: Uint8Array): T {
  if (env.v !== 'frs-seal-v1') throw new Error('unsupported envelope version');
  const pt = nacl.box.open(b64.dec(env.ct), b64.dec(env.nonce), hexToBytes(env.epk), runnerEncSecretKey);
  if (!pt) throw new Error('decryption failed: envelope was not sealed to this enclave or was tampered with');
  return (JSON.parse(new TextDecoder().decode(pt)) as { payload: T }).payload;
}

export function sealedHash(env: SealedEnvelope): string {
  return sha256Hex(canonicalJson(env));
}
