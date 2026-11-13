/**
 * Intel DCAP verification of the runner's TDX quote, in this browser. dcap-qvl (pure JavaScript) checks the quote's
 * signature chain up to Intel's root CA, which is built into the library, the revocation lists and the TCB status, using
 * the collateral the marketplace relays (/api/tee/collateral). The collateral is signed by Intel, so the marketplace
 * cannot make a quote pass. It also returns the REPORTDATA Intel signed, which must carry the runner's report_data
 * (its keys, code hash and this browser's nonce).
 * Loaded on demand, so pages that never see a hardware quote (the guided demo, local-dev runners) never download it.
 */
import { withBase } from './api';

export interface IntelCheck { ok: boolean; status?: string; advisories?: string[]; reportData?: string; rtmr3?: string; error?: string }
/** TCB states that count as genuine and current; anything else (out of date, revoked, …) is reported as a failure */
const GOOD = ['UpToDate', 'SWHardeningNeeded'];

let collateral: Promise<unknown> | null = null;
const getCollateral = () => (collateral ??= fetch(withBase('/api/tee/collateral'))
  .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error ?? `collateral ${r.status}`); return j; })
  .catch((e) => { collateral = null; throw e; }));

const hexBytes = (h: string) => Uint8Array.from((h.replace(/^0x/, '').match(/../g) ?? []).map((x) => parseInt(x, 16)));
const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * expectReportData: the runner's report_data (hex); the check fails unless Intel's signed REPORTDATA starts with it.
 * opts.collateral / opts.nowSecs: for tests with fixed vectors.
 */
export async function checkWithIntel(quoteHex: string, expectReportData?: string, opts: { collateral?: unknown; nowSecs?: number } = {}): Promise<IntelCheck> {
  try {
    const [{ verify }, col] = await Promise.all([import('@phala/dcap-qvl'), opts.collateral ? Promise.resolve(opts.collateral) : getCollateral()]);
    const r = verify(hexBytes(quoteHex), col as never, opts.nowSecs ?? Math.floor(Date.now() / 1000));
    // TDX 1.0, 1.5 and 1.5ex reports all carry the 1.0 fields (REPORTDATA included) in their base
    const td = r.report.asTd10() ?? r.report.asTd15()?.base ?? r.report.asTd15Ex()?.base.base ?? null;
    const reportData = td ? hex(Uint8Array.from(td.reportData)) : '';
    if (!td) return { ok: false, status: r.status, error: 'not a TDX quote' };
    const rtmr3 = hex(Uint8Array.from(td.rtMr3));
    if (expectReportData && !reportData.startsWith(expectReportData.toLowerCase())) return { ok: false, status: r.status, reportData, error: 'Intel-signed REPORTDATA does not carry the runner keys and this nonce' };
    const ok = GOOD.includes(r.status);
    return { ok, status: r.status, advisories: r.advisory_ids, reportData, rtmr3, ...(ok ? {} : { error: `TCB status ${r.status}` }) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
