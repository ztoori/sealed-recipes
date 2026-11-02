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

export function measure(job: JobType | undefined, output: unknown, prices: Prices): { expected: bigint; promised: bigint; delivered: bigint } {
  if (!job?.metric || !Array.isArray(output)) return { expected: 0n, promised: 0n, delivered: 0n };
  let expected = 0n, promised = 0n, delivered = 0n;
  for (const r of output as Receipt[]) {
    const asset = r.assetOut ?? USDC;
    const out = BigInt(r.amountOutUnits ?? '0');
    if (r.status === 'QUOTED') { expected += toPaymentUnits(asset, out, prices); promised += toPaymentUnits(asset, BigInt(r.minAmountOutUnits ?? '0'), prices); }
    if (r.status === 'SUCCESS') delivered += toPaymentUnits(asset, out, prices);
  }
  return { expected, promised, delivered };
}

export async function fetchPrices(oneclickBase: string): Promise<Prices> {
  const tokens = (await fetch(`${oneclickBase}/v0/tokens`).then((r) => r.json())) as { assetId: string; price: string; decimals: number }[];
  return new Map(tokens.map((t) => [t.assetId, { price: Number(t.price), decimals: t.decimals }]));
}
