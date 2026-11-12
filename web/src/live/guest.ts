/**
 * A guest account: an ed25519 key made in this browser. Its NEAR implicit account id is the public key in hex, so it
 * needs no name and no sign-up; it exists once the testnet faucet sends it a little NEAR. The secret key stays in this
 * browser's storage and signs only this visitor's own testnet payments. Testnet only: it holds test tokens.
 */
import nacl from 'tweetnacl';
import bs58 from 'bs58';

export interface Guest { account: string; secretKey: `ed25519:${string}`; created: number }
const KEY = 'srs-live-guest';
const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');

export function loadGuest(): Guest | null {
  try { const g = JSON.parse(localStorage.getItem(KEY) ?? 'null'); return g && /^[0-9a-f]{64}$/.test(g.account) ? g : null; } catch { return null; }
}
export function newGuest(): Guest {
  const kp = nacl.sign.keyPair();
  const g: Guest = { account: hex(kp.publicKey), secretKey: `ed25519:${bs58.encode(kp.secretKey)}`, created: Date.now() };
  try { localStorage.setItem(KEY, JSON.stringify(g)); } catch { /* private mode: the guest lasts for this page only */ }
  return g;
}
export function forgetGuest() { try { localStorage.removeItem(KEY); } catch { /* nothing stored */ } }
export function downloadGuest(g: Guest) {
  const body = { account_id: g.account, public_key: 'ed25519:' + bs58.encode(fromHex(g.account)), private_key: g.secretKey, network: 'testnet', note: 'Sealed Recipes guest account (NEAR testnet only). Works with near-cli: save as ~/.near-credentials/testnet/<account_id>.json' };
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' })); a.download = `guest-${g.account.slice(0, 8)}.testnet-key.json`; a.click();
}
function fromHex(h: string) { return Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16))); }

/** runs this browser started, so a page reload can reopen them (the token and the one-time reply key stay here) */
export interface SavedRun { run_id: string; token: string; recipe_id: string; reply_sk: string; buyer: string; created: number; pay_tx?: string }
const RUNS = 'srs-live-runs';
export const savedRuns = (): SavedRun[] => { try { return JSON.parse(localStorage.getItem(RUNS) ?? '[]'); } catch { return []; } };
export const saveRun = (r: SavedRun) => { try { localStorage.setItem(RUNS, JSON.stringify([r, ...savedRuns().filter((x) => x.run_id !== r.run_id)].slice(0, 20))); } catch { /* not kept */ } };
export { hex };
