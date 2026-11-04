/**
 * Job metrics: turn a recipe's output into the value it delivered (or expects to deliver), in payment-token
 * units (USDC, 6 decimals), so quotes from different recipes are comparable and bonds can be enforced.
 */
import type { JobType } from '../../core/src/frs.js';

const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
interface Receipt { status: string; assetOut?: string; amountOutUnits?: string; minAmountOutUnits?: string }
type Prices = Map<string, { price: number; decimals: number }>;

function toPaymentUnits(asset: string, units: bigint, prices: Prices): bigint {
  if (asset === USDC) return units;
  const t = prices.get(asset);
  if (!t) return 0n;
  return BigInt(Math.floor((Number(units) / 10 ** t.decimals) * t.price * 1e6));
}

/** Deposits that reached the market (executed or failed by it). INCOMPLETE_DEPOSIT means the buyer sent less
 *  than the runner asked for; 1Click refunds it and it never executes. */
const EXECUTED = new Set(['SUCCESS', 'FAILED', 'REFUNDED']);

export function measure(job: JobType | undefined, output: unknown, prices: Prices): { expected: bigint; promised: bigint; delivered: bigint; executed: bigint } {
  if (!job?.metric || !Array.isArray(output)) return { expected: 0n, promised: 0n, delivered: 0n, executed: 0n };
  let expected = 0n, promised = 0n, delivered = 0n, executed = 0n;
  for (const r of output as Receipt[]) {
    const asset = r.assetOut ?? USDC;
    const out = BigInt(r.amountOutUnits ?? '0');
    const min = toPaymentUnits(asset, BigInt(r.minAmountOutUnits ?? '0'), prices);
    if (r.status === 'QUOTED') { expected += toPaymentUnits(asset, out, prices); promised += min; }
    if (r.status === 'SUCCESS') delivered += toPaymentUnits(asset, out, prices);
    if (EXECUTED.has(r.status)) executed += min;
  }
  return { expected, promised, delivered, executed };
}

/**
 * The `delivered` value a bonded run reports. The bond insures the market, not the buyer's own choices: value
 * the buyer withheld after the pre-execution re-check (drained the wallet, sent less than asked) counts as
 * delivered at its quoted minimum. `fresh` is the promise the re-check measured; `executed` is the quoted
 * minimum of what actually reached the market. Model-checked in verification/tla/BondedRuns.tla (NoBondDrain).
 */
export function creditedDelivered(delivered: bigint, fresh: bigint, executed: bigint): bigint {
  return delivered + (fresh > executed ? fresh - executed : 0n);
}

export async function fetchPrices(oneclickBase: string): Promise<Prices> {
  const tokens = (await fetch(`${oneclickBase}/v0/tokens`).then((r) => r.json())) as { assetId: string; price: string; decimals: number }[];
  return new Map(tokens.map((t) => [t.assetId, { price: Number(t.price), decimals: t.decimals }]));
}
