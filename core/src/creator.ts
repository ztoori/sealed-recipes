/**
 * Creator-recoverable copies of sealed recipes.
 *
 * A published recipe is sealed to the runner, so the marketplace cannot read it, and neither can the creator.
 * To let creators reopen and edit any published version from any device, the client also seals a copy to a
 * key only the creator can re-derive: X25519 secret = sha256("frs-creator-key-v1" || signature), where the
 * signature is the creator's wallet signing a fixed message (NEP-413 signMessage). Ed25519 signatures are
 * deterministic, so the same wallet key re-derives the same key anywhere; nothing is stored in the browser.
 * (A wallet with several access keys yields one creator key per signing key; use the same key to publish.)
 */
import nacl from 'tweetnacl';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

export const creatorKeyMessage = (account: string) => `Fungible Recipes creator key v1 for ${account}. Signing this does not move funds.`;

export function creatorKeyFromSignature(signature: Uint8Array): { publicKeyHex: string; secretKey: Uint8Array } {
  const kp = nacl.box.keyPair.fromSecretKey(sha256(concatBytes(utf8ToBytes('frs-creator-key-v1'), signature)));
  return { publicKeyHex: bytesToHex(kp.publicKey), secretKey: kp.secretKey };
}

/** Local demo only: the demo wallet's ed25519 key, derived from the account name (no real wallet here). */
export const demoWalletKey = (account: string) => nacl.sign.keyPair.fromSeed(sha256(utf8ToBytes(`frs-demo-wallet|${account}`)));

/** Local demo only: the demo wallet signs a message with that key. */
export function demoWalletSign(account: string, message: string): Uint8Array {
  return nacl.sign.detached(utf8ToBytes(message), demoWalletKey(account).secretKey);
}
