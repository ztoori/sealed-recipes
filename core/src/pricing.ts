/**
 * Market-driven list prices (contract v6). Same functions as contracts/sealed-recipes/src/pricing.rs,
 * checked against the vectors generated from the proved model (verification/smt).
 *
 * At the end of each pricing period, with `runs` paid runs against a target of `target`:
 *   used   = min(runs, 2 * target)
 *   price' = price ± floor(price * |used - target| / (8 * target)), clamped to [floor, ceiling]
 * so a period moves the price by at most 12.5% (EIP-1559's base-fee rule).
 */
export const MAX_PRICE = 10n ** 30n;
export const MAX_TARGET_RUNS = 1_000_000;
export const MAX_CATCHUP_PERIODS = 64n;
const U128 = 1n << 128n;

/** One period of the demand rule; null where the contract returns None. */
export function nextPrice(price: bigint, runs: bigint, target: number, floor: bigint, ceiling: bigint): bigint | null {
  if (!Number.isInteger(target) || target < 1 || target > MAX_TARGET_RUNS || floor > ceiling || ceiling > MAX_PRICE || price > MAX_PRICE) return null;
  const t = BigInt(target);
  const used = runs < 2n * t ? runs : 2n * t;
  let p: bigint;
  if (used >= t) {
    const prod = price * (used - t);
    if (prod >= U128) return null;
    p = price + prod / (8n * t);
    if (p >= U128) return null;
  } else {
    const prod = price * (t - used);
    if (prod >= U128) return null;
    p = price - prod / (8n * t);
  }
  return p < floor ? floor : p > ceiling ? ceiling : p;
}

/** Applies every period that ended before `now` (the first with its runs, the rest idle). */
export function rollPrice(o: { price: bigint; periodRuns: bigint; periodStartNs: bigint; periodNs: bigint; now: bigint; target: number; floor: bigint; ceiling: bigint }):
  { price: bigint; periodStartNs: bigint; ended: bigint } {
  if (o.periodNs <= 0n || o.now < o.periodStartNs + o.periodNs) return { price: o.price, periodStartNs: o.periodStartNs, ended: 0n };
  const ended = (o.now - o.periodStartNs) / o.periodNs;
  let p = nextPrice(o.price, o.periodRuns, o.target, o.floor, o.ceiling);
  if (p === null) throw new Error('pricing out of range');
  const idle = ended < MAX_CATCHUP_PERIODS ? ended : MAX_CATCHUP_PERIODS;
  for (let i = 1n; i < idle; i++) {
    if (p === o.floor) break;
    p = nextPrice(p, 0n, o.target, o.floor, o.ceiling)!;
  }
  return { price: p, periodStartNs: o.periodStartNs + ended * o.periodNs, ended };
}
