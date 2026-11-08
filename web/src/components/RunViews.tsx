import { short, usd, usePoll } from '../api';

export type Ev = { seq: number; at: number; source: string; type: string; data: any; sealed?: boolean };

export function Output({ out }: { out: any }) {
  const [tokens] = usePoll<{ assetId: string; decimals: number; symbol: string }[]>('/api/tokens', 600000);
  if (Array.isArray(out)) {
    const dec = (a?: string) => tokens?.find((t) => t.assetId === a)?.decimals;
    const human = (r: any) => r.amountOut != null ? Number(r.amountOut) : dec(r.assetOut) != null ? Number(r.amountOutUnits) / 10 ** dec(r.assetOut)! : NaN;
    const target = tokens?.find((t) => t.assetId === out[0]?.assetOut)?.symbol ?? '';
    const swaps = out.some((r) => r.amountIn != null);
    return (
      <>
        <table><thead><tr><th>{swaps ? 'Swept' : 'Asset'}</th><th className="r">{swaps ? 'Amount in' : 'From'}</th><th className="r">Received</th><th>Status</th>{swaps && <th>Privacy</th>}</tr></thead><tbody>
          {out.map((r, i) => <tr key={i}><td>{r.symbol}</td><td className="r">{swaps ? r.amountIn : <span className="hash">{r.source}</span>}</td><td className="r">{Number.isFinite(human(r)) ? human(r).toLocaleString(undefined, { maximumFractionDigits: 4 }) : 'n/a'}</td><td><span className={'pill ' + (r.status === 'SUCCESS' ? 'ok' : 'bad')}>{r.status}</span></td>{swaps && <td><span className={'pill ' + (r.confidentiality === 'basic' ? 'sealed' : '')}>{r.confidentiality === 'basic' ? 'confidential' : 'public'}</span></td>}</tr>)}
        </tbody></table>
        {swaps && <p className="small" style={{ marginBottom: 0 }}><b>{out.reduce((s, r) => s + (Number.isFinite(human(r)) ? human(r) : 0), 0).toFixed(4)} {target}</b> delivered to a fresh address. Scam tokens untouched.</p>}
      </>
    );
  }
  if (out?.title && Array.isArray(out.items)) return (<><h3 className="serif" style={{ fontWeight: 500, fontSize: 22, marginBottom: 8 }}>{out.title}</h3><table className="small"><tbody>{out.items.map((f: any, i: number) => <tr key={i}><td style={{ width: '28%' }}>{f.tag ? <span className={'pill ' + f.tag}>{f.label}</span> : <b>{f.label}</b>}</td><td style={{ wordBreak: 'break-word' }}>{f.detail}</td></tr>)}</tbody></table></>);
  if (out?.title) return (<><h3 className="serif" style={{ fontWeight: 500, fontSize: 20 }}>{out.title}</h3><table className="small"><tbody>{out.flagged.map((f: any) => <tr key={f.contract}><td><b>{f.symbol}</b><div className="muted hash">{f.contract}</div></td><td>{f.reason}</td></tr>)}</tbody></table></>);
  return <pre className="codebox">{JSON.stringify(out, null, 1)}</pre>;
}

export interface Row { title: string; sub?: string; source: string; logs: string[]; state?: 'fail'; sealed?: boolean }
export function timeline(events: Ev[]): Row[] {
  const rows: Row[] = [];
  let part: Row | null = null;
  for (const e of events) {
    const d = e.data;
    switch (e.type) {
      case 'quote': rows.push({ title: 'Quote from 1Click', sub: `${d.quote.amountInFormatted} in → ${usd(d.quote.amountOut, 2)} USDC to ${d.request.recipient}`, source: 'NEAR Intents', logs: [] }); break;
      case 'deposit_submitted': rows.push({ title: 'Deposit sent to the Intents deposit address', sub: `tx ${short(d.txHash, 8, 6)}`, source: 'NEAR Intents', logs: [] }); break;
      case 'status': { const last = rows.at(-1); if (last?.title.startsWith('Deposit')) last.logs.push(`1Click: ${d.status}`); break; }
      case 'run_requested': rows.push({ title: 'Solver delivered via ft_transfer_call: run escrowed on-chain', sub: `tx ${short(d.tx, 8, 6)} · block ${d.height}`, source: 'contract', logs: [] }); break;
      case 'accepted': rows.push({ title: `Runner ${d.runner_id} accepted the run`, sub: d.tee === 'local-dev' ? 'local-dev runner (no hardware TEE)' : 'Intel TDX', source: 'runner', logs: [] }); break;
      case 'verified': rows.push({ title: 'Runner checked the on-chain commitments', source: 'runner', logs: d.checks.map((c: any) => `${c.ok ? '✓' : '✕'} ${c.label}`) }); break;
      case 'rechecked': rows.push({ title: d.ok ? 'Runner re-priced the run before executing: quote still holds' : 'Wallet changed since the quote: run aborted', sub: `threshold ${d.threshold_bps / 100}% of the quoted promise`, source: 'runner', logs: [], ...(d.ok ? {} : { state: 'fail' as const }) }); break;
      case 'recheck': { const last = rows.at(-1); if (last) { last.logs.push(`fresh promise ${usd(d.fresh_promised, 2)} vs quoted ${usd(d.quoted_promised, 2)}`); last.sealed = true; } break; }
      case 'refunded': rows.push({ title: 'Runner reported the failure: refunded now', sub: 'signed fail report, no waiting for the reclaim timeout', source: 'runner', logs: [] }); break;
      case 'checkpoint': (part ?? rows.at(-1))?.logs.push(`checkpoint #${d.local_seq} stored, sealed to the runner${d.mid_part ? ' (before an irreversible step)' : ''}`); break;
      case 'run_checkpoint': rows.push({ title: d.payouts.length ? `Checkpoint on-chain: ${d.payouts.map((p: any) => p.role.slice(5).split('@')[0]).join(', ')} paid` : 'Heartbeat checkpoint on-chain', sub: `seq ${d.seq} · billed so far ${usd(d.billed, 2)} · timeout extended`, source: 'contract', logs: [] }); break;
      case 'runner_lost': rows.push({ title: 'Runner stopped mid-run', sub: d.checkpoint ? `last stored checkpoint #${d.checkpoint}; the marketplace asks it to resume` : 'no checkpoint yet; the run restarts from the beginning', source: 'market', logs: [], state: 'fail' }); break;
      case 'resuming': rows.push({ title: 'Runner resumed from its checkpoint', sub: `checkpoint #${d.local_seq} verified and opened inside the runner: ${d.completed_parts} parts already done${d.mid_part ? `, continuing inside ${d.mid_part}` : ''}`, source: 'runner', logs: [] }); break;
      case 'payment_rejected': rows.push({ title: 'Contract rejected the payment and refunded it', sub: d.error, source: 'contract', logs: [], state: 'fail' }); break;
      case 'decrypted': rows.push({ title: 'Recipe and inputs decrypted inside the runner', sub: 'plaintext never leaves the runner process', source: 'runner', logs: [] }); break;
      case 'part_start': part = { title: d.name, sub: `by ${d.author} · ${usd(d.fee, 2)} per call`, source: 'part', logs: [] }; rows.push(part); break;
      case 'part_log': if (part) { part.logs.push(d.msg); part.sealed = true; } break;
      case 'part_done': if (part) part.sub += ` · ${d.ms} ms`; break;
      case 'part_error': rows.push({ title: 'Part failed', sub: d.error, source: 'runner', logs: [], state: 'fail' }); break;
      case 'approval_required': part?.logs.push(`wallet approval requested: ${d.transactions.length} transfers`); break;
      case 'approval_result': part?.logs.push(d.approved ? `approved, ${d.transfers} transfers sent` : 'rejected by buyer'); break;
      case 'signed': rows.push({ title: 'Runner signed the report', sub: d.message.length > 100 ? d.message.slice(0, 100) + '…' : d.message, source: 'runner', logs: [] }); break;
      case 'srs_settlement': rows.push({ title: 'report_run verified the ed25519 signature and settled', sub: `tx ${short(d.tx, 8, 6)} · ${d.payouts.length} payees + guarantee deposit`, source: 'contract', logs: [] }); break;
      case 'run_refunded': rows.push({ title: 'Run refunded to the buyer', sub: d.reason, source: 'contract', logs: [] }); break;
      case 'failed': rows.push({ title: 'Run failed', sub: d.error, source: 'runner', logs: [], state: 'fail' }); break;
      case 'completed': if (!d.ok) rows.push({ title: d.outcome === 'abort' ? 'Run aborted and refunded' : 'Run failed and was refunded', sub: d.reason ?? d.error, source: 'runner', logs: [], state: 'fail' }); break;
    }
  }
  return rows;
}
