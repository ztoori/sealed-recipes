import { createContext, useContext, useEffect, useRef, useState } from 'react';

/**
 * Where this app is mounted: '' at the site root (localhost, demo.sealedrecipes.xyz), '/demo' when a live site
 * serves the demo under /demo (no SRS_DEMO_URL set).
 * Every request to the server goes through withBase, so the same build works in both places.
 *
 * The live site also shows the demo's practice composer inside its own pages, talking to the demo backend under /demo
 * while the rest of the page talks to the live one. Polls take their backend from ApiBase (the nearest provider);
 * direct calls made by the composer's components use the scoped base set while that page is open (setScopedBase).
 */
export const BASE = new URL('.', location.href).pathname.replace(/\/$/, '');
/**
 * The live site, when this is the hosted demo: '/' under /demo on the live site, the same domain without `demo.` on the
 * demo's own address (demo.sealedrecipes.xyz → sealedrecipes.xyz), null when run locally (`npm run demo`).
 */
export const LIVE_SITE: string | null = BASE === '/demo' ? '/' : /^demo\./.test(location.hostname) ? `${location.protocol}//${location.hostname.replace(/^demo\./, '')}/` : null;
let scoped: string | null = null;
export const setScopedBase = (b: string | null) => { scoped = b; };
export const ApiBase = createContext<string | null>(null);
export const withBase = (p: string, base?: string | null) => (p.startsWith('/') ? (base ?? scoped ?? BASE) + p : p);

export async function api<T = any>(path: string, body?: unknown, base?: string | null, headers: Record<string, string> = {}): Promise<T> {
  const r = await fetch(withBase(path, base), body === undefined ? { headers } : { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const t = await r.text();
  let j: any; try { j = JSON.parse(t); } catch { j = { error: t }; }
  if (!r.ok) throw new Error(j.error ?? `${r.status}`);
  return j as T;
}

/**
 * A server-sent event stream read with fetch, so a secret (a run token) travels in a header rather than in the URL,
 * where proxies and edge logs would keep it. Reconnects while open (the server replays the run's events; callers
 * drop repeats by seq). Returns a function that closes the stream.
 */
export function eventStream(path: string, headers: Record<string, string>, onData: (data: string) => void, onGone: () => void): () => void {
  const ac = new AbortController();
  let closed = false;
  (async () => {
    for (let attempt = 0; !closed; attempt++) {
      try {
        const r = await fetch(withBase(path), { headers: { accept: 'text/event-stream', ...headers }, signal: ac.signal });
        if (r.status === 404 || r.status === 401) { closed = true; onGone(); return; }
        if (!r.ok || !r.body) throw new Error(String(r.status));
        attempt = 0;
        const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          for (let i; (i = buf.indexOf('\n\n')) >= 0;) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); if (chunk.startsWith('data: ')) onData(chunk.slice(6)); }
        }
      } catch { if (closed) return; }
      await new Promise((ok) => setTimeout(ok, Math.min(10_000, 1000 * (attempt + 1))));
    }
  })();
  return () => { closed = true; ac.abort(); };
}

export function usePoll<T>(path: string | null, ms = 1500, deps: unknown[] = []): [T | undefined, () => void] {
  const base = useContext(ApiBase);
  const [v, setV] = useState<T>();
  const tick = useRef(0);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    const go = () => api<T>(path, undefined, base).then((x) => alive && setV(x)).catch(() => {});
    go();
    const id = setInterval(go, ms);
    return () => { alive = false; clearInterval(id); };
  }, [path, ms, n, base, ...deps]);
  return [v, () => { tick.current++; setN((x) => x + 1); }];
}

/**
 * The token amounts are in. The demo (and the live site's practice composer) uses demo USDC, shown as dollars; the live
 * site's own data is tUSDC, the testnet token with no value, shown by name. Set by live/DemoPages.tsx for the pages it hosts.
 */
let currency: 'USDC' | 'tUSDC' = 'USDC';
export const setCurrency = (c: 'USDC' | 'tUSDC') => { currency = c; };
export const currencyName = () => currency;
const withUnit = (s: string) => (currency === 'tUSDC' ? `${s} tUSDC` : '$' + s);
export const usd = (units: string | number | bigint, dp = 4) => withUnit((Number(units) / 1e6).toFixed(dp));
export const money = (n: number, dp = 2) => withUnit(n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp }));
export const px = (n: number | null | undefined) => (n == null ? 'n/a' : n < 0.1 ? n.toFixed(5) : n.toFixed(4));
export const short = (s: string, a = 8, b = 6) => (s && s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);
/**
 * Label for a transaction hash. In local mode the server talks to its in-process contract mirror
 * (core/src/ledger.ts) and to mocked services, so every hash it returns is simulated and is shown as
 * "simulated tx". A NEAR RPC chain adapter would report `mode: 'near'` from /api/mode, and App passes
 * it to setLedgerMode.
 */
let ledgerMode: 'local' | 'near' = 'local';
export const setLedgerMode = (mode?: string) => { ledgerMode = mode === 'near' ? 'near' : 'local'; };
export const txRef = (hash: string, a = 6, b = 4) => `${ledgerMode === 'near' ? 'tx' : 'simulated tx'} ${short(hash, a, b)}`;
export const pct = (x: number) => (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%';
export const compact = (n: number) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : n.toFixed(0);

export const PAY_ASSETS = [
  { id: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', label: 'USDC on Arbitrum', refund: '0xB0b0000000000000000000000000000000000001' },
  { id: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near', label: 'USDC on Solana', refund: 'B0bSo1anaRefundAddr1111111111111111111111111' },
  { id: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', label: 'USDC on Ethereum', refund: '0xB0b0000000000000000000000000000000000001' },
  { id: 'nep141:wrap.near', label: 'wNEAR on NEAR', refund: 'bob.testnet' },
];

export const ACCOUNTS = [
  { id: 'chef.testnet', role: 'Creator' },
  { id: 'bob.testnet', role: 'Buyer' },
  { id: 'veil.testnet', role: 'Part author' },
  { id: 'sentinel.testnet', role: 'Part author' },
  { id: 'scanlabs.testnet', role: 'Part author' },
  { id: 'dana.testnet', role: 'Trader' },
  { id: 'audit-a.testnet', role: 'Reviewer' },
  { id: 'audit-b.testnet', role: 'Reviewer' },
  { id: 'audit-c.testnet', role: 'Reviewer' },
  { id: 'tee-runner-1.testnet', role: 'TEE runner' },
  { id: 'srs-treasury.testnet', role: 'Protocol' },
];

export const ASSET_LABEL: Record<string, string> = {
  'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': 'USDC (NEAR)',
  'nep141:usdt.tether-token.near': 'USDT (NEAR)',
  'nep141:wrap.near': 'wNEAR',
};

/**
 * Attestation comes straight from the runner (not through the marketplace); the registered keys come
 * from the contract view. In local mode that view is the server's mirror; in production it is NEAR RPC.
 */
export async function runnerAttestation(nonce: string): Promise<{ attestation: any; onchain: any }> {
  const mode = await api<any>('/api/mode');
  const attestation = await fetch(withBase(`${mode.runner_url}/attestation?nonce=${nonce}`)).then((r) => r.json());
  const onchain = await api(`/api/chain/runners/${mode.runner_id}`);
  return { attestation, onchain };
}
