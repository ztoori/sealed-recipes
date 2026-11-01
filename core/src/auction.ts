/**
 * Uniform-price batch auction (docs/CONTRACT_SPEC.md, "Share trading: frequent batch auctions").
 * Same rules as `clear_auction` in the Rust contract and scripts/gen-auction-vectors.py;
 * all three are checked against contracts/test-vectors/batch-auction.json.
 */
export interface AuctionOrder { id: number; side: 'Bid' | 'Ask'; owner: string; price: bigint; qty: bigint }
export interface Fill { order_id: number; owner: string; side: 'Bid' | 'Ask'; qty: bigint }
export interface AuctionResult {
  price: bigint | null;
  volume: bigint;
  demand: bigint; // D(P)
  supply: bigint; // S(P)
  fills: Fill[]; // bids (price desc, id asc) then asks (price asc, id asc)
  credits: Map<string, bigint>; // bid price improvement + ask proceeds
  shareDeltas: Map<string, bigint>;
}

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
const minB = (a: bigint, b: bigint) => (a < b ? a : b);
const absB = (a: bigint) => (a < 0n ? -a : a);

export function demandAt(orders: AuctionOrder[], p: bigint) { return sum(orders.filter((o) => o.side === 'Bid' && o.price >= p).map((o) => o.qty)); }
export function supplyAt(orders: AuctionOrder[], p: bigint) { return sum(orders.filter((o) => o.side === 'Ask' && o.price <= p).map((o) => o.qty)); }

export function clearingPrice(orders: AuctionOrder[]): { price: bigint | null; volume: bigint } {
  const cands = [...new Set(orders.map((o) => o.price))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let best = 0n;
  const stats = cands.map((p) => { const d = demandAt(orders, p), s = supplyAt(orders, p); const v = minB(d, s); if (v > best) best = v; return { p, d, s, v }; });
  if (best === 0n) return { price: null, volume: 0n };
  let tied = stats.filter((x) => x.v === best);
  const imb = tied.reduce((m, x) => minB(m, absB(x.d - x.s)), absB(tied[0].d - tied[0].s));
  tied = tied.filter((x) => absB(x.d - x.s) === imb);
  return { price: (tied[0].p + tied[tied.length - 1].p) / 2n, volume: best };
}

export function clearAuction(orders: AuctionOrder[]): AuctionResult {
  const { price, volume } = clearingPrice(orders);
  const credits = new Map<string, bigint>(), shareDeltas = new Map<string, bigint>();
  if (price === null) return { price, volume, demand: 0n, supply: 0n, fills: [], credits, shareDeltas };
  const add = (m: Map<string, bigint>, k: string, v: bigint) => { if (v !== 0n) m.set(k, (m.get(k) ?? 0n) + v); };
  const fills: Fill[] = [];
  let left = volume;
  for (const o of orders.filter((o) => o.side === 'Bid' && o.price >= price).sort((a, b) => (a.price === b.price ? a.id - b.id : a.price > b.price ? -1 : 1))) {
    if (left === 0n) break;
    const q = minB(o.qty, left); left -= q;
    fills.push({ order_id: o.id, owner: o.owner, side: 'Bid', qty: q });
    add(shareDeltas, o.owner, q); add(credits, o.owner, (o.price - price) * q);
  }
  left = volume;
  for (const o of orders.filter((o) => o.side === 'Ask' && o.price <= price).sort((a, b) => (a.price === b.price ? a.id - b.id : a.price < b.price ? -1 : 1))) {
    if (left === 0n) break;
    const q = minB(o.qty, left); left -= q;
    fills.push({ order_id: o.id, owner: o.owner, side: 'Ask', qty: q });
    add(shareDeltas, o.owner, -q); add(credits, o.owner, q * price);
  }
  for (const [k, v] of [...shareDeltas]) if (v === 0n) shareDeltas.delete(k);
  return { price, volume, demand: demandAt(orders, price), supply: supplyAt(orders, price), fills, credits, shareDeltas };
}
