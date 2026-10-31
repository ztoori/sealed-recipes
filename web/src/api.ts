import { useEffect, useRef, useState } from 'react';

export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text();
  let j: any; try { j = JSON.parse(t); } catch { j = { error: t }; }
  if (!r.ok) throw new Error(j.error ?? `${r.status}`);
  return j as T;
}

export function usePoll<T>(path: string | null, ms = 1500, deps: unknown[] = []): [T | undefined, () => void] {
  const [v, setV] = useState<T>();
  const tick = useRef(0);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    const go = () => api<T>(path).then((x) => alive && setV(x)).catch(() => {});
    go();
    const id = setInterval(go, ms);
    return () => { alive = false; clearInterval(id); };
  }, [path, ms, n, ...deps]);
  return [v, () => { tick.current++; setN((x) => x + 1); }];
}

export const usd = (units: string | number | bigint, dp = 4) => '$' + (Number(units) / 1e6).toFixed(dp);
export const money = (n: number, dp = 2) => '$' + n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
export const px = (n: number | null | undefined) => (n == null ? '—' : n < 0.1 ? n.toFixed(5) : n.toFixed(4));
export const short = (s: string, a = 8, b = 6) => (s && s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);
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
  { id: 'veil.testnet', role: 'Block author' },
  { id: 'sentinel.testnet', role: 'Block author' },
  { id: 'scanlabs.testnet', role: 'Block author' },
  { id: 'dana.testnet', role: 'Trader' },
  { id: 'tee-runner-1.testnet', role: 'TEE runner' },
  { id: 'frs-treasury.testnet', role: 'Protocol' },
];

export const ASSET_LABEL: Record<string, string> = {
  'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': 'USDC (NEAR)',
  'nep141:wrap.near': 'wNEAR',
};
