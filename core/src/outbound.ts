/**
 * Outbound guard: every call from our processes to a service outside this machine goes through here, so a busy demo
 * or a bug can't hammer FastNEAR, NEAR RPC, 1Click or NEAR AI Cloud into rate-limiting or blocking us.
 *
 * Per destination host:
 *  - a rate limit (token bucket: `rps` sustained, `burst` at once) and a cap on calls in flight (`concurrency`);
 *  - "too many requests" (429) pauses the whole host for its Retry-After (or a backoff) and the call is retried:
 *    a rejected request was never executed, so retrying it is always safe;
 *  - network errors and 502/503/504 are retried, with backoff and jitter, only for requests that are safe to repeat:
 *    GET/HEAD, NEAR JSON-RPC reads (never broadcast_tx / send_tx) and 1Click quotes (no funds move);
 *  - successful GETs are cached for `cacheTtlMs`, and identical GETs in flight share one request;
 *  - a call that would wait longer than `maxWaitMs` in the queue fails fast instead of piling up.
 * Calls to this machine (127.0.0.1, localhost: the demo's mocks) are not limited.
 *
 * Policies can be tuned without a code change: SRS_OUTBOUND='{"api.fastnear.com":{"rps":20}}' (merged per host).
 * No Node-only imports: this file is also bundled into code the browser loads.
 */

export interface HostPolicy {
  /** sustained requests per second */ rps: number;
  /** requests allowed at once after an idle period */ burst: number;
  /** requests in flight at the same time */ concurrency: number;
  /** cache successful GET responses this long (0: no cache) */ cacheTtlMs: number;
  /** retries after a 429 or a retryable failure */ retries: number;
  /** longest time a call may wait for its turn before failing */ maxWaitMs: number;
}

const BASE: HostPolicy = { rps: 2, burst: 4, concurrency: 2, cacheTtlMs: 0, retries: 2, maxWaitMs: 30_000 };
const FASTNEAR: Partial<HostPolicy> = { rps: 5, burst: 10, concurrency: 4, cacheTtlMs: 15_000, retries: 3 };
const RPC: Partial<HostPolicy> = { rps: 5, burst: 10, concurrency: 4, retries: 3 };
export const DEFAULT_POLICIES: Record<string, Partial<HostPolicy>> = {
  'api.fastnear.com': FASTNEAR, 'test.api.fastnear.com': FASTNEAR,
  'rpc.mainnet.fastnear.com': RPC, 'test.rpc.fastnear.com': RPC, 'rpc.mainnet.near.org': RPC, 'rpc.testnet.near.org': RPC,
  '1click.chaindefuser.com': { rps: 2, burst: 4, concurrency: 2, cacheTtlMs: 60_000, retries: 2 },
  'solver-relay-v2.chaindefuser.com': { rps: 2, burst: 4, concurrency: 2, retries: 1 },
  'cloud-api.near.ai': { rps: 1, burst: 3, concurrency: 2, retries: 2, maxWaitMs: 60_000 },
  'nras.attestation.nvidia.com': { rps: 1, burst: 2, concurrency: 1, cacheTtlMs: 60_000, retries: 1 },
};

export interface HostStats { requests: number; cached: number; shared: number; waited: number; retries: number; rate_limited_429: number; failures: number; rejected_queue_full: number; in_flight: number; paused_until?: number }

class Host {
  tokens: number; last = Date.now(); inFlight = 0; pausedUntil = 0;
  queue: (() => void)[] = [];
  stats: HostStats = { requests: 0, cached: 0, shared: 0, waited: 0, retries: 0, rate_limited_429: 0, failures: 0, rejected_queue_full: 0, in_flight: 0 };
  constructor(readonly policy: HostPolicy) { this.tokens = policy.burst; }
  refill(now: number) { this.tokens = Math.min(this.policy.burst, this.tokens + ((now - this.last) / 1000) * this.policy.rps); this.last = now; }
}

const sleep = (ms: number, signal?: AbortSignal | null) => new Promise<void>((ok, fail) => {
  if (signal?.aborted) { fail(signal.reason); return; }
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); ok(); }, ms);
  const onAbort = () => { clearTimeout(t); fail(signal!.reason); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

/** seconds or an HTTP date → milliseconds to wait (capped) */
function retryAfterMs(h: string | null, fallback: number): number {
  if (!h) return fallback;
  const s = Number(h);
  const ms = Number.isFinite(s) ? s * 1000 : Date.parse(h) - Date.now();
  return Math.min(60_000, Math.max(250, Number.isFinite(ms) ? ms : fallback));
}

/** may this request be sent twice? (a 429 is always retryable: it was never executed) */
export function safeToRepeat(method: string, url: URL, body: unknown): boolean {
  if (method === 'GET' || method === 'HEAD') return true;
  if (typeof body === 'string' && body.includes('"jsonrpc"')) {
    try { const m = String((JSON.parse(body) as { method?: string }).method ?? ''); return m !== '' && !m.startsWith('broadcast_tx') && m !== 'send_tx'; } catch { return false; }
  }
  return url.pathname === '/v0/quote'; // 1Click quotes move no funds
}

export class OutboundGuard {
  private hosts = new Map<string, Host>();
  private cache = new Map<string, { until: number; status: number; headers: [string, string][]; body: ArrayBuffer }>();
  private inflight = new Map<string, Promise<{ status: number; headers: [string, string][]; body: ArrayBuffer }>>();
  private policies: Record<string, Partial<HostPolicy>>;
  constructor(policies: Record<string, Partial<HostPolicy>> = DEFAULT_POLICIES, private opts: { limitLocal?: boolean; fetchImpl?: typeof fetch; cacheMax?: number } = {}) {
    this.policies = policies;
  }
  policyFor(host: string): HostPolicy { return { ...BASE, ...(this.policies['*'] ?? {}), ...(this.policies[host] ?? {}) }; }
  private host(name: string) { let h = this.hosts.get(name); if (!h) { h = new Host(this.policyFor(name)); this.hosts.set(name, h); } return h; }
  stats(): Record<string, HostStats> {
    return Object.fromEntries([...this.hosts].map(([k, h]) => [k, { ...h.stats, in_flight: h.inFlight, ...(h.pausedUntil > Date.now() ? { paused_until: h.pausedUntil } : {}) }]));
  }

  /** wait for a rate token and a concurrency slot; returns a release function */
  private async acquire(h: Host, signal?: AbortSignal | null): Promise<() => void> {
    const started = Date.now();
    for (let waited = false; ; waited = true) {
      const now = Date.now();
      h.refill(now);
      const pause = h.pausedUntil - now;
      if (pause <= 0 && h.tokens >= 1 && h.inFlight < h.policy.concurrency) {
        h.tokens -= 1; h.inFlight++;
        if (waited) h.stats.waited++;
        let released = false;
        return () => { if (released) return; released = true; h.inFlight--; const next = h.queue.shift(); next?.(); };
      }
      if (now - started > h.policy.maxWaitMs) { h.stats.rejected_queue_full++; throw new Error(`outbound: too many requests queued for this service; try again shortly`); }
      // wake on a released slot, a refilled token or the end of a pause, whichever comes first
      const untilToken = h.tokens >= 1 ? 50 : Math.ceil(((1 - h.tokens) / h.policy.rps) * 1000);
      const wait = Math.max(10, Math.min(1000, pause > 0 ? pause : untilToken));
      let wake!: () => void;
      const woken = new Promise<void>((ok) => { wake = ok; h.queue.push(ok); });
      try { await Promise.race([sleep(wait, signal), woken]); }
      finally { const i = h.queue.indexOf(wake); if (i >= 0) h.queue.splice(i, 1); } // never leave a stale waiter behind
    }
  }

  async fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(String(input));
    const doFetch = this.opts.fetchImpl ?? globalThis.fetch;
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (local && !this.opts.limitLocal) return doFetch(url, init);
    const method = (init.method ?? 'GET').toUpperCase();
    const h = this.host(url.host);
    const p = h.policy;
    const cacheable = method === 'GET' && p.cacheTtlMs > 0 && !init.body;
    const key = cacheable ? `${url.href}|${new Headers(init.headers).get('authorization') ?? ''}` : '';
    const toResponse = (r: { status: number; headers: [string, string][]; body: ArrayBuffer }) =>
      new Response([101, 204, 205, 304].includes(r.status) ? null : r.body.slice(0), { status: r.status, headers: r.headers });
    if (cacheable) {
      const hit = this.cache.get(key);
      if (hit && hit.until > Date.now()) { h.stats.cached++; return toResponse(hit); }
      const shared = this.inflight.get(key);
      if (shared) { h.stats.shared++; return toResponse(await shared); }
    }
    const run = async () => {
      const repeatable = safeToRepeat(method, url, init.body);
      for (let attempt = 0; ; attempt++) {
        const release = await this.acquire(h, init.signal);
        h.stats.requests++;
        let res: Response;
        try { res = await doFetch(url, init); }
        catch (e) {
          release();
          if (init.signal?.aborted || !repeatable || attempt >= p.retries) { h.stats.failures++; throw e; }
          h.stats.retries++; await sleep(backoff(attempt), init.signal); continue;
        }
        release();
        if (res.status === 429) {
          h.stats.rate_limited_429++;
          h.pausedUntil = Date.now() + retryAfterMs(res.headers.get('retry-after'), backoff(attempt));
          if (attempt >= p.retries) return res;
          h.stats.retries++; await res.body?.cancel().catch(() => {}); continue; // acquire() waits out the pause
        }
        if ([502, 503, 504].includes(res.status) && repeatable && attempt < p.retries) {
          h.stats.retries++; await res.body?.cancel().catch(() => {}); await sleep(backoff(attempt), init.signal); continue;
        }
        if (res.status >= 500) h.stats.failures++;
        return res;
      }
    };
    if (!cacheable) return run();
    const shared = (async () => {
      const res = await run();
      const stored = { status: res.status, headers: [...res.headers] as [string, string][], body: await res.arrayBuffer() };
      if (res.ok) {
        this.cache.set(key, { ...stored, until: Date.now() + p.cacheTtlMs });
        const max = this.opts.cacheMax ?? 500;
        if (this.cache.size > max) for (const k of [...this.cache.keys()].slice(0, this.cache.size - max)) this.cache.delete(k);
      }
      return stored;
    })();
    this.inflight.set(key, shared);
    try { return toResponse(await shared); } finally { this.inflight.delete(key); }
  }
}

/** exponential backoff with jitter: ~0.5 s, 1 s, 2 s, … capped at 10 s */
function backoff(attempt: number) { return Math.min(10_000, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5); }

function envPolicies(): Record<string, Partial<HostPolicy>> {
  const raw = typeof process !== 'undefined' ? process.env?.SRS_OUTBOUND : undefined;
  if (!raw) return DEFAULT_POLICIES;
  try {
    const extra = JSON.parse(raw) as Record<string, Partial<HostPolicy>>;
    const merged: Record<string, Partial<HostPolicy>> = { ...DEFAULT_POLICIES };
    for (const [k, v] of Object.entries(extra)) merged[k] = { ...(merged[k] ?? {}), ...v };
    return merged;
  } catch { return DEFAULT_POLICIES; }
}

/** the process-wide guard: one per process, so all its callers share each host's limits */
export const outbound = new OutboundGuard(envPolicies());
export const outboundFetch = (input: string | URL, init?: RequestInit) => outbound.fetch(input, init);
