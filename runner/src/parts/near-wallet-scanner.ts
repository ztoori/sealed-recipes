import type { PartHandler, Holding } from '../types.js';
import { isAccountId, view, viewAccount } from './near-rpc.js';

/**
 * near.wallet-scanner 1.1.0: every account, whatever it holds, answers within the part's limits.
 *
 * 1.0.0 read ft_metadata over RPC for every token, one call after another, so an account holding hundreds of tokens
 * (a DEX, a treasury, an exchange) ran past max_ms and max_http_calls and the whole recipe failed. 1.1.0:
 *   - balances come from one indexed FastNEAR call, prices and symbols from one 1Click call, whatever the token count;
 *   - only tokens 1Click does not list need ft_metadata, at most META_CALLS of them, a few at a time, inside a time
 *     budget; the most recently updated are read first (new airdrops are where scam tokens are);
 *   - the output stays under max_output_bytes: every priced token first (by value), then unpriced ones;
 *   - nothing left out is silent: `coverage` says how many tokens the account has and how many were kept, so the
 *     report can say "top 60 of 1,812" and an agent can tell a complete scan from a partial one;
 *   - a malformed or unknown account fails fast with a plain message, and an account with no tokens is a clean,
 *     empty result rather than an error.
 */
const META_CALLS = 30;        // ft_metadata calls at most (+ 2 list calls + 1 account check stay under max_http_calls)
const PARALLEL = 6;           // metadata calls in flight at once
const BUDGET_MS = 4500;       // stop starting metadata calls after this: worst case 4500 + CALL_MS, under max_ms (8000)
const CALL_MS = 2000;         // one metadata call that takes longer is skipped
const MAX_BYTES = 56_000;     // holdings + coverage stay under max_output_bytes (64000)

type Ft = { contract_id: string; balance: string; last_update_block_height?: number | null };
type Listed = { assetId: string; symbol: string; decimals: number; price: string; blockchain: string };

const within = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([p.catch(() => undefined), new Promise<undefined>((ok) => setTimeout(() => ok(undefined), ms))]);

export const walletScanner: PartHandler = async (inputs, ctx) => {
  const t0 = Date.now();
  const raw = String(inputs.account ?? '').trim();
  const account = raw.toLowerCase();
  if (!isAccountId(account)) throw new Error(`"${raw}" is not a valid NEAR account id (named like alice.near, or a 64-character implicit address)`);

  const [ftRes, tokRes] = await Promise.all([
    ctx.http(`${ctx.endpoints.fastnear}/v1/account/${account}/ft`),
    ctx.http(`${ctx.endpoints.oneclick}/v0/tokens`).catch(() => undefined),
  ]);
  if (!ftRes.ok) throw new Error(`FastNEAR answered ${ftRes.status} for ${account}`);
  const ft = ((await ftRes.json()) as { tokens?: Ft[] }).tokens ?? [];
  const listed: Listed[] = tokRes?.ok ? ((await tokRes.json()) as Listed[]) : [];
  const byAsset = new Map(listed.filter((t) => t.blockchain === 'near').map((t) => [t.assetId, t]));

  // a balance the indexer could not read comes back as "" (broken token contract): counted, never guessed
  const unreadable = ft.filter((t) => !/^\d+$/.test(t.balance ?? '')).length;
  const held = ft.filter((t) => /^\d+$/.test(t.balance) && BigInt(t.balance) > 0n);

  if (!held.length) {
    // no tokens: tell a missing account apart from an empty one
    let found: boolean | undefined;
    try { found = (await viewAccount(ctx, account)) !== undefined; } catch { found = undefined; }
    if (found === false && !ft.length) throw new Error(`${account} does not exist on this network${account.endsWith('.testnet') ? ' (this scanner reads NEAR mainnet; .testnet accounts live on testnet)' : ''}`);
    const coverage = { title: `No tokens found for ${account}`, account, complete: true, tokens_total: 0, shown: 0, priced: 0, unpriced_shown: 0, left_out: 0, unreadable, metadata_skipped: 0, priced_left_out: 0, account_found: found !== false };
    ctx.log(coverage.title, { coverage });
    return { holdings: [], coverage };
  }

  const owner = account;
  const priced: Holding[] = [], unpriced: Ft[] = [];
  for (const t of held) {
    const l = byAsset.get(`nep141:${t.contract_id}`);
    if (!l) { unpriced.push(t); continue; }
    const human = Number(t.balance) / 10 ** l.decimals;
    priced.push({ owner, assetId: l.assetId, contract: t.contract_id, symbol: l.symbol, name: l.symbol, decimals: l.decimals, amount: t.balance, usd: +(human * Number(l.price)).toFixed(4), listed: true });
  }
  priced.sort((a, b) => b.usd - a.usd);

  // metadata for unpriced tokens, newest first, bounded in count, parallelism and time
  unpriced.sort((a, b) => (b.last_update_block_height ?? 0) - (a.last_update_block_height ?? 0));
  const toRead = unpriced.slice(0, META_CALLS);
  const meta = new Map<string, { symbol: string; name: string; decimals: number }>();
  let next = 0, timedOut = 0;
  const worker = async () => {
    while (next < toRead.length && Date.now() - t0 < BUDGET_MS) {
      const t = toRead[next++];
      const md = await within(view<{ symbol?: string; name?: string; decimals?: number }>(ctx, t.contract_id, 'ft_metadata'), CALL_MS);
      if (md && typeof md.decimals === 'number') meta.set(t.contract_id, { symbol: String(md.symbol ?? '?').slice(0, 32), name: String(md.name ?? t.contract_id).slice(0, 64), decimals: md.decimals });
      else timedOut++;
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  const unpricedHoldings: Holding[] = toRead.filter((t) => meta.has(t.contract_id)).map((t) => {
    const m = meta.get(t.contract_id)!;
    return { owner, assetId: `nep141:${t.contract_id}`, contract: t.contract_id, symbol: m.symbol, name: m.name, decimals: m.decimals, amount: t.balance, usd: 0, listed: false };
  });

  // keep the output within its byte limit: priced tokens by value first, then unpriced ones
  const holdings: Holding[] = [];
  let bytes = 600;
  for (const h of [...priced, ...unpricedHoldings]) {
    const b = JSON.stringify(h).length + 1;
    if (bytes + b > MAX_BYTES) break;
    holdings.push(h); bytes += b;
  }
  const shownPriced = holdings.filter((h) => h.listed).length;
  const left_out = held.length - holdings.length;
  const coverage = {
    title: left_out ? `Showing ${holdings.length} of ${held.length} tokens held by ${account}` : `All ${held.length} tokens held by ${account}`,
    account, complete: left_out === 0, tokens_total: held.length, shown: holdings.length, priced: shownPriced,
    unpriced_shown: holdings.length - shownPriced, left_out, unreadable, metadata_skipped: timedOut + Math.max(0, unpriced.length - toRead.length),
    priced_left_out: priced.length - shownPriced, account_found: true,
  };
  ctx.log(`${coverage.title}; ${priced.length} priced, total $${holdings.reduce((s, h) => s + h.usd, 0).toFixed(2)}; ${Date.now() - t0} ms`, { coverage });
  return { holdings, coverage };
};
