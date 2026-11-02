/**
 * Per-run resource limits (FRS-1 §2.2). Each part declares max wall time, HTTP calls, model calls and output
 * size. The runner enforces them; a part that goes over fails the run, and the contract refunds the buyer.
 * Time spent waiting for the buyer's wallet approval does not count against max_ms.
 */
import type { PartManifest } from '../../core/src/frs.js';

export const MODEL_HOSTS = new Set(['cloud-api.near.ai']);

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type Approval = <T>(wait: () => Promise<T>) => Promise<T>;

export class LimitExceeded extends Error {}

export async function enforceLimits<T>(m: PartManifest, fetchImpl: Fetch, run: (http: Fetch, approval: Approval) => Promise<T>): Promise<T> {
  const lim = m.limits ?? { max_ms: 60_000, max_http_calls: 50, max_model_calls: 0, max_output_bytes: 65_536 };
  let http = 0, model = 0, paused = 0, pausedAt = 0;
  const t0 = Date.now();
  const counted: Fetch = async (url, init) => {
    const host = new URL(url).host;
    if (++http > lim.max_http_calls) throw new LimitExceeded(`${m.id} exceeded max_http_calls (${lim.max_http_calls})`);
    if (MODEL_HOSTS.has(host) && url.includes('/chat/completions') && ++model > lim.max_model_calls) throw new LimitExceeded(`${m.id} exceeded max_model_calls (${lim.max_model_calls})`);
    return fetchImpl(url, init);
  };
  const approval: Approval = async (wait) => { pausedAt = Date.now(); try { return await wait(); } finally { paused += Date.now() - pausedAt; pausedAt = 0; } };
  let timer: NodeJS.Timeout | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timer = setInterval(() => {
      const active = Date.now() - t0 - paused - (pausedAt ? Date.now() - pausedAt : 0);
      if (active > lim.max_ms) reject(new LimitExceeded(`${m.id} exceeded max_ms (${lim.max_ms} ms)`));
    }, 50);
  });
  try {
    const out = await Promise.race([run(counted, approval), watchdog]);
    const bytes = new TextEncoder().encode(JSON.stringify(out)).length;
    if (bytes > lim.max_output_bytes) throw new LimitExceeded(`${m.id} exceeded max_output_bytes (${bytes} > ${lim.max_output_bytes})`);
    return out;
  } finally {
    clearInterval(timer);
  }
}
