/**
 * NEP-413 off-chain message signing, as used by NEAR Intents (`signed_data.standard = "nep413"`).
 * The signed bytes are sha256(borsh(payload)) with payload = { tag: u32 = 2^31 + 413, message: string,
 * nonce: [u8; 32], recipient: string, callbackUrl: Option<string> }.
 */
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64 } from './seal.js';

export const NEP413_TAG = 2 ** 31 + 413;
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const str = (s: string) => { const b = utf8ToBytes(s); return concatBytes(u32(b.length), b); };

export interface Nep413Payload { message: string; nonce: string /* base64, 32 bytes */; recipient: string; callbackUrl?: string }
export interface SignedNep413 { standard: 'nep413'; payload: Nep413Payload; signature: string /* ed25519:<base58> */; public_key: string /* ed25519:<base58> */ }

export function nep413Hash(p: Nep413Payload): Uint8Array {
  const nonce = base64.dec(p.nonce);
  if (nonce.length !== 32) throw new Error('nep413 nonce must be 32 bytes');
  const cb = p.callbackUrl == null ? new Uint8Array([0]) : concatBytes(new Uint8Array([1]), str(p.callbackUrl));
  return sha256(concatBytes(u32(NEP413_TAG), str(p.message), nonce, str(p.recipient), cb));
}

export function signNep413(p: Nep413Payload, secretKey: Uint8Array): SignedNep413 {
  const sig = nacl.sign.detached(nep413Hash(p), secretKey);
  return { standard: 'nep413', payload: p, signature: 'ed25519:' + bs58.encode(sig), public_key: 'ed25519:' + bs58.encode(secretKey.slice(32)) };
}

export function verifyNep413(s: SignedNep413): boolean {
  try {
    return nacl.sign.detached.verify(nep413Hash(s.payload), bs58.decode(s.signature.replace(/^ed25519:/, '')), bs58.decode(s.public_key.replace(/^ed25519:/, '')));
  } catch { return false; }
}
