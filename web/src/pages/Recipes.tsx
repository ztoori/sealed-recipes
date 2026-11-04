import { useEffect, useState } from 'react';
import { api, money, short, usd, usePoll } from '../api';
import { useApp } from '../App';

/**
 * Recipes: every listed recipe's public track record and the guarantee deposit that backs its quotes.
 * There is nothing to invest in here. A buyer pays for one run of a service; the creator posts collateral
 * that pays buyers when a run delivers less than its signed promise. Neither is a share of anything.
 */
export function Recipes() {
  const { ticker, setTicker, go } = useApp();
  const [listings] = usePoll<any[]>('/api/listings', 2500);
  useEffect(() => { if (listings?.length && !listings.some((l) => l.ticker === ticker)) setTicker(listings[0].ticker); }, [listings, ticker]);
  const [m, refresh] = usePoll<any>(ticker ? `/api/recipe/${ticker}` : null, 1500, [ticker]);
  const rec = m?.record;

  return (
    <div className="grid ex">
      <section className="panel" aria-label="Listed recipes">
        <header><h2>Listed recipes</h2><span className="muted small">{listings?.length ?? 0}</span></header>
        <table>
          <thead><tr><th>Recipe</th><th className="r">Per run</th><th className="r">Kept promise</th></tr></thead>
          <tbody>
            {(listings ?? []).map((l) => (
              <tr key={l.ticker} className={'click' + (l.ticker === ticker ? ' sel' : '')} onClick={() => setTicker(l.ticker)}>
                <td><b>{l.ticker}</b><div className="small muted">{l.name}</div></td>
                <td className="r">{money(l.record.pricePerRun)}</td>
                <td className="r">{l.record.keptPromise == null ? <span className="muted">—</span> : `${Math.round(l.record.keptPromise * 100)}%`}<div className="small muted">{l.record.runs} {l.record.runs === 1 ? 'run' : 'runs'}</div></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="body small muted">
          You pay for one run of a recipe, nothing more. Each creator posts a guarantee deposit: when a run delivers less than its signed quote promised, the shortfall is paid to you from it, in the same settlement.
          {!listings?.some((l) => l.ticker === 'CLNP') && <p><button className="btn sm" onClick={() => go('compose')}>Compose “Clean up and protect”</button></p>}
        </div>
      </section>

      <section className="grid" style={{ minWidth: 0 }}>
        {rec && m.listing && (
          <div className="panel">
            <div className="body">
              <div className="row between wrap" style={{ alignItems: 'flex-start' }}>
                <div>
                  <div className="small muted">{ticker} · by {m.listing.creator} · v{m.onchain?.version ?? 1}</div>
                  <h1 className="listing-name">{m.listing.name}</h1>
                  <p className="muted" style={{ maxWidth: 640, margin: '6px 0 0' }}>{m.listing.description}</p>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="bigpx">{money(rec.pricePerRun)} <span className="small muted">per run</span></div>
                  <div className="small muted">{rec.runs} paid {rec.runs === 1 ? 'run' : 'runs'} · {money(rec.revenue)} billed</div>
                  <button className="btn sm" style={{ marginTop: 8 }} onClick={() => go('run', ticker)}>Get a quote</button>
                </div>
              </div>
            </div>
            <Activity counts={rec.activity} />
          </div>
        )}
        {rec && (
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
            <div className="panel">
              <header><h2>Track record</h2><span className="small muted">on-chain</span></header>
              <dl className="kv body">
                <dt>Successful runs</dt><dd>{rec.runs}</dd>
                <dt>Refunded runs</dt><dd>{rec.failed}</dd>
                <dt>Aborted before running</dt><dd>{rec.aborted}</dd>
                <dt>Delivered vs promised</dt><dd>{rec.keptPromise == null ? 'no quoted runs yet' : `${(rec.keptPromise * 100).toFixed(0)}%`}</dd>
                <dt>Paid to buyers from the deposit</dt><dd>{money(rec.deposit.paidToBuyers, 2)}</dd>
                <dt>Version</dt><dd>v{m.onchain?.version ?? 1}{m.onchain?.pending_sealed_hash ? <div className="small"><span className="pill warn">v{(m.onchain.version ?? 1) + 1} announced</span> takes effect {new Date(Number(BigInt(m.onchain.update_effective_ns) / 1_000_000n)).toLocaleString()}. Runs already paid keep the version they paid for.</div> : null}</dd>
                <dt>Settlement</dt><dd>{m.onchain?.settle_mode === 'checkpoint' ? 'per checkpoint: each part is paid as soon as it finishes; durable multi-step runs' : 'one receipt at the end of the run'}</dd>
                <dt>Withdrawal risk</dt><dd>{m.listing?.risk ?? '—'}</dd>
              </dl>
            </div>
            <Deposit ticker={ticker} rec={rec} deposits={m.deposits} onDone={refresh} />
            <div className="panel">
              <header><h2>Where each run’s price goes</h2></header>
              <dl className="kv body">
                <dt>Protocol</dt><dd>{money(rec.perRun.protocol, 4)}</dd>
                <dt>Runner</dt><dd>{money(rec.perRun.runner, 4)}</dd>
                {rec.perRun.parts.map((p: any, i: number) => <span key={i} style={{ display: 'contents' }}><dt>Part · {p.part.split('@')[0]}</dt><dd>{money(p.amount, 4)}</dd></span>)}
                <dt>Creator</dt><dd>{money(rec.perRun.creator, 4)}</dd>
                <dt>To the guarantee deposit</dt><dd>{money(rec.perRun.reserve, 4)} <span className="small muted">({rec.perRun.reserveBps / 100}% of the creator’s cut)</span></dd>
              </dl>
              <div className="body small muted" style={{ paddingTop: 0 }}>Sums to exactly {money(rec.perRun.price, 4)}; proved for every input in verification/.</div>
            </div>
          </div>
        )}
        {m && (
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
            <div className="panel">
              <header><h2>Settlements</h2><span className="small muted">one receipt per paid run</span></header>
              {m.settlements.length === 0 && <div className="body muted small">No paid runs yet. Run the recipe to see every party get paid in one receipt.</div>}
              <table><tbody>
                {m.settlements.slice(0, 8).map((x: any) => (
                  <tr key={x.run_id}><td><span className="hash">{short(x.tx, 6, 4)}</span><div className="small muted">{x.payouts.length} payees{x.compensation !== '0' ? ` · ${usd(x.compensation)} paid to buyer` : ''}</div></td><td className="r">{usd(x.price, 2)}</td><td className="r small">{usd(x.reserve)} to deposit</td></tr>
                ))}
              </tbody></table>
            </div>
            <div className="panel">
              <header><h2>What the marketplace can see</h2></header>
              <div className="body grid" style={{ gap: 8 }}>
                <div className="parts-strip">
                  {m.listing?.parts.map((b: string, i: number) => (
                    <span key={b + i} className="row" style={{ gap: 6 }}>{i > 0 && <span className="arrow">›</span>}<span className="blk">{b.split('@')[0]}<small>{b.split('@')[1]}</small></span></span>
                  ))}
                </div>
                <div className="small">Form: {m.listing?.form.map((f: any) => f.label).join(', ')}</div>
                <div className="sealed-box">Wiring, parameters and prompts are sealed to the runner. On-chain commitment <span className="hash">{short(m.onchain?.sealed_hash ?? '', 14, 8)}</span></div>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

/** Paid runs per hour over the last 24 hours. Usage, not a price: there is no price here but the run's. */
function Activity({ counts }: { counts: number[] }) {
  const max = Math.max(1, ...counts);
  return (
    <div className="body" style={{ paddingTop: 0 }}>
      <div className="small muted" style={{ marginBottom: 6 }}>Paid runs per hour, last 24 hours</div>
      <svg viewBox="0 0 480 64" width="100%" height="64" role="img" aria-label="Runs per hour">
        {counts.map((c, i) => <rect key={i} x={i * 20 + 2} y={60 - (c / max) * 56} width={16} height={Math.max(1, (c / max) * 56)} rx={2} fill={c ? '#0f7a66' : '#d7dde7'} />)}
      </svg>
    </div>
  );
}

function Deposit({ ticker, rec, deposits, onDone }: { ticker: string; rec: any; deposits: any[]; onDone: () => void }) {
  const { acting, toast } = useApp();
  const [amt, setAmt] = useState('5');
  const mine = acting === rec.creator;
  const units = String(Math.round(Number(amt) * 1e6));
  const tx = async (method: string, args: Record<string, string>, ok: string) => {
    try { const r = await api('/api/chain/tx', { signer: acting, method, args }); toast(`${ok} · tx ${short(r.tx, 6, 4)}`); onDone(); } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <div className="panel">
      <header><h2>Guarantee deposit</h2><span className="small muted">collateral, not an investment</span></header>
      <dl className="kv body">
        <dt>Available to back quotes</dt><dd>{money(rec.deposit.available, 2)}</dd>
        <dt>Locked by runs in flight</dt><dd>{money(rec.deposit.locked, 2)}</dd>
        <dt>Added from runs</dt><dd>{money(rec.deposit.fromRuns, 4)}</dd>
      </dl>
      <div className="body grid" style={{ gap: 8, paddingTop: 0 }}>
        <div className="small muted">The creator’s own money. Each quote locks part of it as cover; a shortfall against the promise is paid to the buyer from that cover. It earns nothing and belongs to nobody else. {mine ? 'You can top it up or take out the free part.' : `Only ${rec.creator} can withdraw it.`}</div>
        {mine && (
          <div className="row wrap" style={{ gap: 6 }}>
            <input aria-label="Amount in USDC" value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" style={{ width: 80 }} />
            <button className="btn sm" disabled={!Number(amt)} onClick={() => tx('bond', { recipe_id: ticker, amount: units }, `Deposited ${money(Number(amt))}`)}>Top up</button>
            <button className="btn ghost sm" disabled={!Number(amt) || Number(amt) > rec.deposit.available} onClick={() => tx('withdraw_bond', { recipe_id: ticker, amount: units }, `Moved ${money(Number(amt))} to your balance`)}>Withdraw</button>
          </div>
        )}
        {deposits.length > 0 && <table className="small"><tbody>{deposits.slice(0, 4).map((d: any, i: number) => <tr key={i}><td>{d.event === 'bond_posted' ? `deposit by ${d.from}` : 'withdrawn by creator'}<div className="muted hash">tx {short(d.tx, 6, 4)}</div></td><td className={'r ' + (d.event === 'bond_posted' ? 'gain' : 'loss')}>{d.event === 'bond_posted' ? '+' : '−'}{usd(d.amount, 2)}</td></tr>)}</tbody></table>}
      </div>
    </div>
  );
}
