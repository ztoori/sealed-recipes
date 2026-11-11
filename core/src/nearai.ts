/**
 * NEAR AI Cloud client: OpenAI-compatible private inference + TEE verification.
 * Follows https://docs.near.ai/cloud/verification (model attestation, chat signatures).
 *
 * Verification implemented here (pure, offline-testable):
 *  - request/response hashing exactly as sent/received
 *  - EIP-191 ECDSA signature recovery, compared to the attested signing_address
 *  - nonce freshness + signing_address binding inside TDX report_data
 *  - NVIDIA NRAS JWT claim checks (decoding; JWT signature check needs NVIDIA's JWKS online)
 * Hardware-quote verification (Intel TDX via dcap-qvl) must be done by dcap-qvl or
 * https://proof.t16z.com — we surface that as an explicit, separate check.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { sha256Hex } from './canonical.js';
import { outboundFetch } from './outbound.js';

export const NEAR_AI_BASE = 'https://cloud-api.near.ai';

export function eip191Hash(text: string): Uint8Array {
  const msg = utf8ToBytes(text);
  const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${msg.length}`);
  const all = new Uint8Array(prefix.length + msg.length);
  all.set(prefix); all.set(msg, prefix.length);
  return keccak_256(all);
}

export function addressFromPublicKey(pub: Uint8Array): string {
  const uncompressed = secp256k1.Point.fromBytes(pub).toBytes(false); // 65 bytes, 0x04 prefix
  return '0x' + bytesToHex(keccak_256(uncompressed.slice(1)).slice(-20));
}

/** Recover the Ethereum-style address that signed `text` (personal_sign / EIP-191). */
export function recoverSigner(text: string, signatureHex: string): string {
  const sig = hexToBytes(signatureHex.replace(/^0x/, ''));
  if (sig.length !== 65) throw new Error('expected 65-byte r||s||v signature');
  let v = sig[64];
  if (v >= 27) v -= 27;
  const rec = new Uint8Array(65);
  rec[0] = v; rec.set(sig.slice(0, 64), 1);
  const pub = secp256k1.recoverPublicKey(rec, eip191Hash(text), { prehash: false });
  return addressFromPublicKey(pub);
}

/** Sign like a NEAR AI TEE does (used by the local enclave simulator and tests). */
export function signEip191(text: string, secretKey: Uint8Array): string {
  const rec = secp256k1.sign(eip191Hash(text), secretKey, { prehash: false, format: 'recovered' });
  const out = new Uint8Array(65);
  out.set(rec.slice(1), 0); out[64] = rec[0] + 27;
  return '0x' + bytesToHex(out);
}

export interface ChatSignature { text: string; signature: string; signing_address: string; signing_algo: string; signature_kind?: 'provider_tee' | 'gateway' }

export interface ChatVerification {
  requestHash: string;
  responseHash: string;
  signedTextMatches: boolean;
  recovered: string;
  signerMatchesAttestation: boolean;
  ok: boolean;
}

export function verifyChat(requestBody: string, responseBody: string, sig: ChatSignature, attestedAddress: string): ChatVerification {
  const requestHash = sha256Hex(requestBody);
  const responseHash = sha256Hex(responseBody);
  const parts = sig.text.split(':');
  const tail = parts.slice(-2);
  const signedTextMatches = tail[0] === requestHash && tail[1] === responseHash;
  let recovered = '';
  try { recovered = recoverSigner(sig.text, sig.signature); } catch { /* invalid */ }
  const signerMatchesAttestation = !!recovered && recovered.toLowerCase() === attestedAddress.toLowerCase() && sig.signing_address.toLowerCase() === attestedAddress.toLowerCase();
  return { requestHash, responseHash, signedTextMatches, recovered, signerMatchesAttestation, ok: signedTextMatches && signerMatchesAttestation };
}

export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const p = jwt.split('.')[1];
  const b = p.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b + '='.repeat((4 - (b.length % 4)) % 4)), (c) => c.charCodeAt(0))));
}

export interface Check { id: string; label: string; status: 'pass' | 'fail' | 'skip'; detail: string }

/** Checks on an NRAS response (`[["JWT", overall], {"GPU-0": jwt}]`) per the docs' checklist. */
export function checkNras(nras: unknown, nonce: string, nowSec = Math.floor(Date.now() / 1000)): Check[] {
  const checks: Check[] = [];
  try {
    const arr = nras as [[string, string], Record<string, string>];
    const overall = decodeJwtPayload(arr[0][1]);
    checks.push({ id: 'nras.overall', label: 'NVIDIA overall attestation result', status: overall['x-nvidia-overall-att-result'] === true ? 'pass' : 'fail', detail: String(overall['x-nvidia-overall-att-result']) });
    checks.push({ id: 'nras.nonce', label: 'GPU eat_nonce matches our nonce', status: overall.eat_nonce === nonce ? 'pass' : 'fail', detail: String(overall.eat_nonce) });
    checks.push({ id: 'nras.exp', label: 'NRAS token not expired', status: Number(overall.exp) > nowSec ? 'pass' : 'fail', detail: String(overall.exp) });
    for (const [gpu, jwt] of Object.entries(arr[1] ?? {})) {
      const g = decodeJwtPayload(jwt);
      const verified = Object.entries(g).filter(([k]) => k.startsWith('x-nvidia-') && (k.endsWith('-verified') || k.endsWith('-validated'))).every(([, v]) => v === true);
      const ok = g.secboot === true && g.dbgstat === 'disabled' && g.measres === 'success' && verified && g.eat_nonce === nonce;
      checks.push({ id: `nras.${gpu}`, label: `${gpu}: secure boot, debug off, RIMs verified`, status: ok ? 'pass' : 'fail', detail: String(g.hwmodel ?? '') });
    }
  } catch (e) {
    checks.push({ id: 'nras.parse', label: 'NRAS response parse', status: 'fail', detail: (e as Error).message });
  }
  return checks;
}

/** TDX report_data binding as used by NEAR AI Cloud: first 32 bytes = signing address (padded), next 32 = nonce. */
export function checkReportDataBinding(reportDataHex: string, signingAddress: string, nonce: string): Check[] {
  const rd = reportDataHex.replace(/^0x/, '').toLowerCase();
  const addr = signingAddress.replace(/^0x/, '').toLowerCase();
  return [
    { id: 'tdx.bind.addr', label: 'TDX report_data binds signing address', status: rd.slice(0, 64).includes(addr) ? 'pass' : 'fail', detail: rd.slice(0, 64) },
    { id: 'tdx.bind.nonce', label: 'TDX report_data embeds our nonce', status: rd.slice(64, 128) === nonce.toLowerCase() ? 'pass' : 'fail', detail: rd.slice(64, 128) },
  ];
}

export class NearAiCloud {
  constructor(private apiKey: string, private base = NEAR_AI_BASE) {}
  private h() { return { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${this.apiKey}` }; }

  async chat(model: string, messages: { role: string; content: string }[]) {
    const requestBody = JSON.stringify({ model, messages, temperature: 0, stream: false });
    const res = await outboundFetch(`${this.base}/v1/chat/completions`, { method: 'POST', headers: this.h(), body: requestBody });
    const responseBody = await res.text();
    if (!res.ok) throw new Error(`NEAR AI Cloud ${res.status}: ${responseBody.slice(0, 200)}`);
    const json = JSON.parse(responseBody) as { id: string; choices: { message: { content: string } }[] };
    return { requestBody, responseBody, id: json.id, content: json.choices[0]?.message?.content ?? '' };
  }

  async attestation(model: string, nonce: string) {
    const res = await outboundFetch(`${this.base}/v1/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa&nonce=${nonce}`, { headers: this.h() });
    if (!res.ok) throw new Error(`attestation ${res.status}`);
    return (await res.json()) as { model_attestations: { signing_address: string; nvidia_payload: string; intel_quote: string; [k: string]: unknown }[] };
  }

  async signature(chatId: string, model: string, tries = 5): Promise<ChatSignature> {
    for (let i = 0; i < tries; i++) {
      const res = await outboundFetch(`${this.base}/v1/signature/${chatId}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`, { headers: this.h() });
      if (res.ok) return (await res.json()) as ChatSignature;
      await new Promise((r) => setTimeout(r, 400 * (i + 1))); // signature may live on another node: retry
    }
    throw new Error('signature not found');
  }
}
