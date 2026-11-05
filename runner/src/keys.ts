/**
 * Runner key material.
 *  local-dev: random keys persisted in .data/runner-dev-keys.json (git-ignored). No TEE.
 *  dstack:    keys derived inside the TDX CVM by the dstack guest agent (getKey). They are
 *             deterministic per app identity and never leave the enclave; quotes come
 *             from getQuote(report_data). Works with the dstack simulator for testing
 *             (DSTACK_SIMULATOR_ENDPOINT) and with Phala Cloud / NEAR Shade Agent CVMs.
 */
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

export interface RunnerKeys {
  tee: 'local-dev' | 'dstack-tdx';
  sign: nacl.SignKeyPair;
  box: nacl.BoxKeyPair;
  signingPk: string;
  encPkHex: string;
  quote: (reportDataHex: string) => Promise<string | null>;
  composeHash: string;
}

export async function loadKeys(mode: string, devKeyFile: string, composeHash: string): Promise<RunnerKeys> {
  if (mode === 'dstack') {
    // Imported lazily: the SDK is only installed inside the runner container (runner/package.json).
    const { DstackClient } = (await import('@phala/dstack-sdk' as string)) as { DstackClient: new () => { getKey(p: string, purpose?: string): Promise<{ key: Uint8Array }>; getQuote(rd: Uint8Array): Promise<{ quote: string }>; info(): Promise<{ compose_hash?: string }> } };
    const c = new DstackClient();
    const sk = await c.getKey('sealed-recipes/runner/sign', 'ed25519-seed');
    const ek = await c.getKey('sealed-recipes/runner/enc', 'x25519-seed');
    const info = await c.info();
    const sign = nacl.sign.keyPair.fromSeed(sha256(sk.key));
    const box = nacl.box.keyPair.fromSecretKey(sha256(ek.key));
    return {
      tee: 'dstack-tdx', sign, box, signingPk: 'ed25519:' + bs58.encode(sign.publicKey), encPkHex: bytesToHex(box.publicKey),
      quote: async (rd) => (await c.getQuote(hexToBytes(rd))).quote,
      composeHash: info.compose_hash ?? composeHash,
    };
  }
  let stored: { sign_seed: string; box_sk: string } | undefined;
  if (existsSync(devKeyFile)) stored = JSON.parse(readFileSync(devKeyFile, 'utf8'));
  if (!stored) {
    stored = { sign_seed: bytesToHex(nacl.randomBytes(32)), box_sk: bytesToHex(nacl.randomBytes(32)) };
    mkdirSync(dirname(devKeyFile), { recursive: true });
    writeFileSync(devKeyFile, JSON.stringify(stored, null, 2));
  }
  const sign = nacl.sign.keyPair.fromSeed(hexToBytes(stored.sign_seed));
  const box = nacl.box.keyPair.fromSecretKey(hexToBytes(stored.box_sk));
  return { tee: 'local-dev', sign, box, signingPk: 'ed25519:' + bs58.encode(sign.publicKey), encPkHex: bytesToHex(box.publicKey), quote: async () => null, composeHash };
}
