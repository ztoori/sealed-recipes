/**
 * Which container image is the runner? The CVM measures its app-compose.json (which holds the docker-compose file and
 * so the image digest) into RTMR3 as a "compose-hash" runtime event. This browser checks that chain end to end:
 *   1. every RTMR3 event's digest is computed from its own content (dstack runtime events:
 *      sha384(le32(event_type) ‖ ":" ‖ event ‖ ":" ‖ payload); dstack does not send them);
 *   2. replaying those digests gives the RTMR3 inside the quote that Intel's signature chain just verified;
 *   3. the "compose-hash" event's payload is sha256 of the app-compose.json the runner sent;
 *   4. that app-compose.json runs exactly the pinned runner/docker-compose.yml from this site's source.
 * The runner can send anything; only data consistent with the Intel-signed RTMR3 passes.
 */
export interface ComposeCheck { ok: boolean; composeHash?: string; image?: string; error?: string }
interface Ev { imr: number; event_type: number; digest: string; event: string; event_payload: string }

const DSTACK_RUNTIME_EVENT = 0x08000001;
const enc = new TextEncoder();
const bytes = (h: string) => Uint8Array.from((h.replace(/^0x/, '').match(/../g) ?? []).map((x) => parseInt(x, 16)));
const hex = (u: ArrayBuffer | Uint8Array) => Array.from(u instanceof Uint8Array ? u : new Uint8Array(u), (b) => b.toString(16).padStart(2, '0')).join('');
const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const digest = async (alg: 'SHA-256' | 'SHA-384', d: Uint8Array) => new Uint8Array(await crypto.subtle.digest(alg, d as BufferSource));
const le32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const norm = (s: string) => s.replace(/\r\n/g, '\n').trim();

/** sha384 digest of a dstack runtime event, as the CVM extends it into RTMR3 */
export const runtimeEventDigest = async (e: Pick<Ev, 'event_type' | 'event' | 'event_payload'>) =>
  hex(await digest('SHA-384', cat(le32(e.event_type), enc.encode(':'), enc.encode(e.event), enc.encode(':'), bytes(e.event_payload))));

/** RTMR replay: mr = sha384(mr ‖ digest), from 48 zero bytes */
export async function replayRtmr(digests: string[]): Promise<string> {
  let mr: Uint8Array = new Uint8Array(48);
  for (const d of digests) { const b = new Uint8Array(48); b.set(bytes(d).slice(0, 48)); mr = await digest('SHA-384', cat(mr, b)); }
  return hex(mr);
}

/** rtmr3Hex: RTMR3 from the Intel-verified quote; pinnedCompose: runner/docker-compose.yml as this site was built with */
export async function checkCompose(att: { event_log?: string; app_compose?: string }, rtmr3Hex: string, pinnedCompose: string): Promise<ComposeCheck> {
  try {
    if (!att.event_log || !att.app_compose) return { ok: false, error: 'the runner sent no event log or app-compose (older runner build)' };
    const log = (JSON.parse(att.event_log) as Ev[]).filter((e) => e.imr === 3);
    // dstack sends runtime events without their digests: each one is computed here from its own content (and checked
    // against the digest when one is sent), so the payloads read below are exactly what was extended into RTMR3
    const digests: string[] = [];
    for (const e of log) {
      if (e.event_type !== DSTACK_RUNTIME_EVENT) { if (!e.digest) return { ok: false, error: `RTMR3 event type ${e.event_type} without a digest` }; digests.push(e.digest.toLowerCase()); continue; }
      const d = await runtimeEventDigest(e);
      if (e.digest && e.digest.toLowerCase() !== d) return { ok: false, error: `RTMR3 event "${e.event}" does not match its digest` };
      digests.push(d);
    }
    if ((await replayRtmr(digests)) !== rtmr3Hex.toLowerCase()) return { ok: false, error: 'the event log does not replay to the RTMR3 in the Intel-signed quote' };
    const ch = log.filter((e) => e.event === 'compose-hash');
    if (ch.length !== 1) return { ok: false, error: `expected one compose-hash event in RTMR3, found ${ch.length}` };
    const composeHash = ch[0].event_payload.toLowerCase();
    if (hex(await digest('SHA-256', enc.encode(att.app_compose))) !== composeHash) return { ok: false, composeHash, error: 'app-compose.json does not hash to the compose hash measured in RTMR3' };
    const app = JSON.parse(att.app_compose) as { docker_compose_file?: string };
    const image = /^\s*image:\s*(\S+)/m.exec(app.docker_compose_file ?? '')?.[1];
    if (norm(app.docker_compose_file ?? '') !== norm(pinnedCompose)) return { ok: false, composeHash, image, error: 'the measured docker-compose differs from the pinned runner/docker-compose.yml' };
    return { ok: true, composeHash, image };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
