/**
 * Shared state of the live page: the contract's mode, the listings, this browser's guest account, navigation and toasts.
 * Navigation mirrors the guided demo's (web/src/route.ts), as a hash, so every page has its own link:
 *   #/  (landing)   #/demo (the guided demo film)   #/recipes[/TICKER]   #/quote/TICKER[/RUN_ID]   #/wallet   #/compose/...   #/docs/SUB
 * Landing, Docs and Compose are the demo's pages shown in this shell (DemoPages.tsx); the guided story is the demo
 * itself, which this same site serves under /demo (simulated services).
 */
import { createContext, useContext } from 'react';
import type { Guest } from './guest';
import { parseRoute, routeHash, type DocsSub } from '../route';

/** the guided demo, served by this site under /demo (server/src/demo-proxy.ts) */
export const DEMO = '/demo/';
export const EXPLORER = 'https://testnet.nearblocks.io';
export const txUrl = (h: string) => `${EXPLORER}/txns/${h}`;
export const accUrl = (a: string) => `${EXPLORER}/address/${a}`;
/** tUSDC has 6 decimals */
export const tusdc = (u: string | number | bigint | undefined, dp = 2) => (Number(u ?? 0) / 1e6).toFixed(dp);
export const fmtNear = (y: string) => (Number(BigInt(y) / 10n ** 18n) / 1e6).toFixed(4);

export interface Mode { mode: string; contract_id: string; payment_token: string; runner_id: string; rpc_url: string; faucet: boolean; services?: Record<string, string> }
export interface OnChain { runs: string | number; failed: string | number; aborted?: string | number; price_per_run: string; revenue?: string; promised_total?: string; delivered_total?: string; compensated_total?: string; bond_available?: string; bond_locked?: string; settle_mode?: string; version?: number; sealed_hash?: string; price_floor?: string; price_ceiling?: string; target_runs?: number; period_runs?: string | number; creator?: string; runner_id?: string }
export interface Listing { record?: any; ticker: string; name: string; description: string; creator: string; form: { id: string; label: string; type: string; placeholder?: string; default?: unknown; options?: string[]; required?: boolean }[]; price_per_run: string; risk: string; privacy: string; output_type: string; parts: string[]; capabilities: string[]; publish_tx?: string; onchain?: OnChain | null }

export type LiveRoute = { page: 'home' } | { page: 'film' } | { page: 'recipes'; ticker?: string } | { page: 'quote'; ticker: string; run?: string } | { page: 'wallet' }
  | { page: 'compose'; sub: 'recipe' | 'part' | 'review'; part?: string } | { page: 'docs'; sub: DocsSub };

export function parseLive(hash: string): LiveRoute {
  const [page, a, b] = hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  switch (page) {
    case '': case undefined: return { page: 'home' };
    case 'demo': case 'film': return { page: 'film' };
    case 'quote': return a ? { page: 'quote', ticker: a.toUpperCase(), ...(b ? { run: b } : {}) } : { page: 'recipes' };
    case 'wallet': return { page: 'wallet' };
    case 'compose': case 'docs': return parseRoute(hash) as LiveRoute;
    default: return a ? { page: 'recipes', ticker: a.toUpperCase() } : { page: 'recipes' };
  }
}
export function liveHash(r: LiveRoute): string {
  switch (r.page) {
    case 'home': return '#/';
    case 'film': return '#/demo';
    case 'recipes': return r.ticker ? `#/recipes/${r.ticker}` : '#/recipes';
    case 'quote': return `#/quote/${r.ticker}${r.run ? '/' + encodeURIComponent(r.run) : ''}`;
    case 'wallet': return '#/wallet';
    case 'compose': case 'docs': return routeHash(r);
  }
}

export interface LiveCtx {
  mode?: Mode; listings?: Listing[];
  guest: Guest | null; setGuest: (g: Guest | null) => void;
  /** make a guest key in this browser and ask the faucet for test tokens */
  createGuest: () => Promise<Guest | null>; fund: (g: Guest) => Promise<void>; funding: boolean;
  route: LiveRoute; go: (r: LiveRoute) => void;
  toast: (msg: string, err?: boolean) => void;
}
export const Ctx = createContext<LiveCtx>(null as unknown as LiveCtx);
export const useLive = () => useContext(Ctx);
