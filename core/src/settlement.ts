/** Settlement math — must match `settlement_split` in contracts/fungible-recipes (see docs/CONTRACT_SPEC.md). */
export const SCALE = 10n ** 18n;

export interface SplitInput {
  price: bigint;
  protocolFeeBps: number;
  runnerFee: bigint;
  partFees: bigint[];
  royaltyBps: number;
  totalShares: bigint;
}

export interface Split {
  protocol: bigint;
  runner: bigint;
  parts: bigint[];
  remainder: bigint;
  creator: bigint;
  pool: bigint;
  accIncrement: bigint;
  distributed: bigint;
  dustToProtocol: bigint;
  protocolTotal: bigint;
}

export function minimumPrice(price: bigint, protocolFeeBps: number, runnerFee: bigint, partFees: bigint[]): boolean {
  const protocol = (price * BigInt(protocolFeeBps)) / 10000n;
  return price >= protocol + runnerFee + partFees.reduce((a, b) => a + b, 0n);
}

export function settlementSplit(i: SplitInput): Split {
  if (i.totalShares <= 0n) throw new Error('total_shares must be > 0');
  const protocol = (i.price * BigInt(i.protocolFeeBps)) / 10000n;
  const partsTotal = i.partFees.reduce((a, b) => a + b, 0n);
  const remainder = i.price - protocol - i.runnerFee - partsTotal;
  if (remainder < 0n) throw new Error('price below minimum viable price');
  const creator = (remainder * BigInt(i.royaltyBps)) / 10000n;
  const pool = remainder - creator;
  const accIncrement = (pool * SCALE) / i.totalShares;
  const distributed = (accIncrement * i.totalShares) / SCALE;
  const dustToProtocol = pool - distributed;
  return { protocol, runner: i.runnerFee, parts: [...i.partFees], remainder, creator, pool, accIncrement, distributed, dustToProtocol, protocolTotal: protocol + dustToProtocol };
}
