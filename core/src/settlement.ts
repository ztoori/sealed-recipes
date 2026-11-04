/** Settlement math — must match `settlement_split` in contracts/fungible-recipes (see docs/CONTRACT_SPEC.md). */

export interface SplitInput {
  price: bigint;
  protocolFeeBps: number;
  runnerFee: bigint;
  partFees: bigint[];
  /** share of the creator's remainder kept as the recipe's guarantee deposit (0..10000) */
  reserveBps: number;
}

export interface Split {
  protocol: bigint;
  runner: bigint;
  parts: bigint[];
  remainder: bigint;
  /** added to the recipe's guarantee deposit (bond_available): the creator's money, held as collateral */
  reserve: bigint;
  creator: bigint;
}

export function minimumPrice(price: bigint, protocolFeeBps: number, runnerFee: bigint, partFees: bigint[]): boolean {
  const protocol = (price * BigInt(protocolFeeBps)) / 10000n;
  return price >= protocol + runnerFee + partFees.reduce((a, b) => a + b, 0n);
}

const U128 = 1n << 128n;
const checked = (x: bigint): bigint => { if (x >= U128) throw new Error('settlement overflow'); return x; };

/**
 * Same as the contract's `settlement_split` (v5). Every unit of the price goes to exactly one of: the protocol,
 * the runner, each part author, the creator, or the recipe's guarantee deposit. No shares, no dividends.
 * Throws where the contract returns None (fees above the price, a product above 2^128).
 */
export function settlementSplit(i: SplitInput): Split {
  if (i.reserveBps < 0 || i.reserveBps > 10000) throw new Error('reserve_bps must be <= 10000');
  if (i.protocolFeeBps < 0 || i.protocolFeeBps > 10000) throw new Error('protocol_fee_bps must be <= 10000');
  const protocol = checked(i.price * BigInt(i.protocolFeeBps)) / 10000n;
  const partsTotal = checked(i.partFees.reduce((a, b) => a + b, 0n));
  const remainder = i.price - protocol - i.runnerFee - partsTotal;
  if (remainder < 0n) throw new Error('price below minimum viable price');
  const reserve = checked(remainder * BigInt(i.reserveBps)) / 10000n;
  return { protocol, runner: i.runnerFee, parts: [...i.partFees], remainder, reserve, creator: remainder - reserve };
}

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
