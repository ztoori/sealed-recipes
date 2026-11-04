/** Settlement math — must match `settlement_split` in contracts/fungible-recipes (see docs/CONTRACT_SPEC.md). */
export const SCALE = 10n ** 18n;

export interface SplitInput {
  price: bigint;
  protocolFeeBps: number;
  runnerFee: bigint;
  partFees: bigint[];
  royaltyBps: number;
  totalShares: bigint;
  /** the recipe's acc_per_share before this run (0 for the first run) */
  accBefore?: bigint;
}

export interface Split {
  protocol: bigint;
  runner: bigint;
  parts: bigint[];
  remainder: bigint;
  creator: bigint;
  pool: bigint;
  accIncrement: bigint;
  accAfter: bigint;
  distributed: bigint;
  dustToProtocol: bigint;
  protocolTotal: bigint;
}

export function minimumPrice(price: bigint, protocolFeeBps: number, runnerFee: bigint, partFees: bigint[]): boolean {
  const protocol = (price * BigInt(protocolFeeBps)) / 10000n;
  return price >= protocol + runnerFee + partFees.reduce((a, b) => a + b, 0n);
}

const U128 = 1n << 128n;
const checked = (x: bigint): bigint => { if (x >= U128) throw new Error('settlement overflow'); return x; };

/**
 * Same as the contract's `settlement_split`. The shareholders' share telescopes: the total ever set aside is
 * floor(acc * total_shares / SCALE), exactly what holders can claim in total (proved in verification/smt).
 * Throws where the contract returns None (fees above price, total_shares 0, a product above 2^128).
 */
export function settlementSplit(i: SplitInput): Split {
  if (i.totalShares <= 0n) throw new Error('total_shares must be > 0');
  const accBefore = i.accBefore ?? 0n;
  const protocol = checked(i.price * BigInt(i.protocolFeeBps)) / 10000n;
  const partsTotal = checked(i.partFees.reduce((a, b) => a + b, 0n));
  const remainder = i.price - protocol - i.runnerFee - partsTotal;
  if (remainder < 0n) throw new Error('price below minimum viable price');
  const creator = (remainder * BigInt(i.royaltyBps)) / 10000n;
  const pool = remainder - creator;
  const accIncrement = checked(pool * SCALE) / i.totalShares;
  const accAfter = checked(accBefore + accIncrement);
  const distributed = checked(accAfter * i.totalShares) / SCALE - checked(accBefore * i.totalShares) / SCALE;
  const dustToProtocol = pool - distributed;
  return { protocol, runner: i.runnerFee, parts: [...i.partFees], remainder, creator, pool, accIncrement, accAfter, distributed, dustToProtocol, protocolTotal: protocol + dustToProtocol };
}

// ---- dividends: same rules as contracts/fungible-recipes/src/dividends.rs ----
export const accrued = (shares: bigint, acc: bigint) => checked(shares * acc) / SCALE;
export const pendingDividends = (shares: bigint, debt: bigint, acc: bigint) => { const a = accrued(shares, acc); return a > debt ? a - debt : 0n; };
export function harvestDividends(shares: bigint, debt: bigint, acc: bigint): [paid: bigint, debt: bigint] {
  const a = accrued(shares, acc);
  return [a > debt ? a - debt : 0n, a > debt ? a : debt];
}
/** debt after a share-count change, rounded up so rounding never favours holders */
export const rebaseDebt = (shares: bigint, acc: bigint) => { const x = checked(shares * acc); return x / SCALE + (x % SCALE ? 1n : 0n); };

// ---- bonds: same rules as contracts/fungible-recipes/src/bond.rs ----
export interface Bond { available: bigint; locked: bigint }
export const bondLock = (b: Bond, cover: bigint): Bond | null => (b.available < cover ? null : { available: b.available - cover, locked: checked(b.locked + cover) });
export const bondRelease = (b: Bond, covered: bigint): Bond | null => (b.locked < covered ? null : { available: checked(b.available + covered), locked: b.locked - covered });
export function bondSettle(b: Bond, covered: bigint, promised: bigint, delivered: bigint): [Bond, bigint] | null {
  const shortfall = promised > delivered ? promised - delivered : 0n;
  const compensation = shortfall < covered ? shortfall : covered;
  if (b.locked < covered) return null;
  return [{ available: checked(b.available + covered - compensation), locked: b.locked - covered }, compensation];
}
export const bondWithdraw = (b: Bond, amount: bigint): Bond | null => (b.available < amount ? null : { available: b.available - amount, locked: b.locked });
export const bondDeposit = (b: Bond, amount: bigint): Bond | null => ({ available: checked(b.available + amount), locked: b.locked });
