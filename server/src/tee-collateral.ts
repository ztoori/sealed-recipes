/**
 * Intel's collateral for the runner's TDX quote (PCK CRL, TCB info, QE identity and their issuer chains), fetched from
 * a PCCS and cached, so browsers can verify the runner's quote against Intel's root CA themselves (web/src/tdx.ts)
 * without each of them calling Intel. Everything here is signed by Intel and checked in the browser against the root CA
 * built into dcap-qvl, so this server only relays it: it cannot make a quote look genuine.
 *   SRS_PCCS_URL: the PCCS to use (default Phala's, as dcap-qvl and scripts/verify-quote.ts use).
 */
import { getCollateral, PHALA_PCCS_URL } from '@phala/dcap-qvl';

const FRESH_MS = 60 * 60_000;    // collateral stays valid for days; refresh hourly so TCB updates show up soon
const RETRY_MS = 60_000;         // after a failure, don't ask the PCCS again for a minute

export function collateralCache(runnerQuote: () => Promise<string | null | undefined>, pccs = process.env.SRS_PCCS_URL || PHALA_PCCS_URL) {
  let cached: { at: number; body: unknown } | null = null;
  let failed: { at: number; error: string } | null = null;
  let inflight: Promise<unknown> | null = null;
  return async function collateral(): Promise<unknown> {
    if (cached && Date.now() - cached.at < FRESH_MS) return cached.body;
    if (failed && Date.now() - failed.at < RETRY_MS) throw new Error(failed.error);
    inflight ??= (async () => {
      try {
        const quote = await runnerQuote();
        if (!quote) throw new Error('the runner sends no hardware quote (local-dev runner)');
        const body = await getCollateral(pccs, Buffer.from(quote.replace(/^0x/, ''), 'hex'));
        cached = { at: Date.now(), body }; failed = null;
        return body;
      } catch (e) {
        failed = { at: Date.now(), error: `collateral: ${(e as Error).message}` };
        if (cached) return cached.body; // an older copy is still Intel-signed; the browser checks its dates
        throw new Error(failed.error);
      } finally { inflight = null; }
    })();
    return inflight;
  };
}
