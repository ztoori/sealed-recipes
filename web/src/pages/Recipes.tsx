import { useEffect, useState } from 'react';
import { nextPrice } from '../../../core/src/pricing';
import { api, money, short, usd, usePoll } from '../api';
import { useApp } from '../App';

/**
 * Recipes: every listed recipe's market-driven price, public track record and the guarantee deposit that backs its quotes.
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
                <td className="r">{money(l.record.pricePerRun)}<Trend h={l.record.history} /></td>
                <td className="r">{l.record.keptPromise == null ? <span className="muted">—</span> : `${Math.round(l.record.keptPromise * 100)}%`}<div className="small muted">{l.record.runs} {l.record.runs === 1 ? 'run' : 'runs'}</div></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="body small muted">
          Prices are set by demand: each recipe's price per run rises when it's busy and falls when it's idle, inside a band its creator sets. You pay for one run, nothing more. Each creator posts a guarantee deposit: when a run delivers less than its signed quote promised, the shortfall is paid to you from it, in the same settlement.
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
                  <div className="bigpx">{money(rec.pricePerRun)} <span className="small muted">per run now</span></div>
                  <div className="small muted">{rec.pricing.fixed ? 'fixed price' : `band ${money(rec.pricing.floor)}–${money(rec.pricing.ceiling)}`}</div>
                  <div className="small muted">{rec.runs} paid {rec.runs === 1 ? 'run' : 'runs'} · {money(rec.revenue)} billed</div>
                  <button className="btn sm" style={{ marginTop: 8 }} onClick={() => go('run', ticker)}>Get a quote</button>
                </div>
              </div>
            </div>
            <PriceHistory rec={rec} />
          </div>
        )}
        {rec && (
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
            <MarketPrice ticker={ticker} rec={rec} onDone={refresh} />
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

function useNow(ms = 1000) { const [n, setN] = useState(Date.now()); useEffect(() => { const t = setInterval(() => setN(Date.now()), ms); return () => clearInterval(t); }, [ms]); return n; }

/** small arrow: the list price now vs the previous period */
function Trend({ h }: { h: { price: number }[] }) {
  if (!h || h.length < 2) return null;
  const a = h[h.length - 2].price, b = h[h.length - 1].price;
  if (a === b) return null;
  return <div className={'small ' + (b > a ? 'gain' : 'loss')} style={{ whiteSpace: 'nowrap' }}>{b > a ? '▲' : '▼'}&nbsp;{Math.abs((b - a) / a * 100).toFixed(1)}%</div>;
}

/** Price per run and paid runs per pricing period: the demand that moved each price. Usage, not trading. */
function PriceHistory({ rec }: { rec: any }) {
  const h: { runs: number; price: number }[] = rec.history ?? [];
  if (!h.length) return null;
  const W = 640, H = 120, pad = 6, n = Math.max(h.length, 12), bw = (W - 2 * pad) / n;
  const maxRuns = Math.max(rec.pricing.targetRuns * 2, ...h.map((x) => x.runs), 1);
  // scale to the prices actually seen (with the floor) so a 12.5% move is visible; the band is printed above
  const seen = h.map((x) => x.price);
  const lo = Math.min(rec.pricing.floor, ...seen), top = Math.max(...seen);
  const hi = Math.max(top + (top - lo) * 0.25, lo * 1.15, lo + 1e-9);
  const y = (p: number) => pad + (1 - (p - lo) / (hi - lo)) * (H - 2 * pad);
  const yr = (r: number) => H - pad - (r / maxRuns) * (H * 0.45);
  const x0 = W - pad - h.length * bw;
  const line = h.map((x, i) => `${i ? 'L' : 'M'}${x0 + i * bw},${y(x.price)} H${x0 + (i + 1) * bw}`).join(' ');
  return (
    <div className="body" style={{ paddingTop: 0 }}>
      <div className="row between small muted" style={{ marginBottom: 6 }}>
        <span>Price per run (line) and paid runs (bars) per {rec.pricing.periodS >= 120 ? `${Math.round(rec.pricing.periodS / 60)}-minute` : `${rec.pricing.periodS}-second`} period · dashed: target {rec.pricing.targetRuns}</span>
        <span>{money(rec.pricing.ceiling)} ceiling · {money(rec.pricing.floor)} floor</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Price and demand per period">
        <line x1={pad} x2={W - pad} y1={y(rec.pricing.floor)} y2={y(rec.pricing.floor)} stroke="#d7dde7" />
        <text x={pad} y={y(rec.pricing.floor) - 3} style={{ fontSize: 10, fill: '#8592a8' }}>floor {money(rec.pricing.floor)}</text>
        {h.map((x, i) => <rect key={i} x={x0 + i * bw + 2} width={bw - 4} y={yr(x.runs)} height={H - pad - yr(x.runs)} fill={x.runs > rec.pricing.targetRuns ? '#0f7a66' : x.runs < rec.pricing.targetRuns ? '#c9d2df' : '#5b6b84'} opacity={0.55} />)}
        <line x1={pad} x2={W - pad} y1={yr(rec.pricing.targetRuns)} y2={yr(rec.pricing.targetRuns)} stroke="#5b6b84" strokeDasharray="4 4" />
        <path d={line} fill="none" stroke="#b77a06" strokeWidth={2.5} />
        {h.map((x, i) => (i === 0 || x.price !== h[i - 1].price) && <text key={'t' + i} x={x0 + i * bw + 2} y={y(x.price) - 4} style={{ fontSize: 10, fill: '#9a5f00' }}>{money(x.price, 3)}</text>)}
      </svg>
    </div>
  );
}

/** Current period: demand so far against the target, and what the price will be when the period ends. */
function MarketPrice({ ticker, rec, onDone }: { ticker: string; rec: any; onDone: () => void }) {
  const { acting, toast } = useApp();
  const now = useNow();
  const p = rec.pricing;
  const left = Math.max(0, Math.round((p.periodEndsMs - now) / 1000));
  const u = (x: number) => BigInt(Math.round(x * 1e6));
  const next = p.fixed ? null : nextPrice(u(rec.pricePerRun), BigInt(p.periodRuns), p.targetRuns, u(p.floor), u(p.ceiling));
  const mine = acting === rec.creator;
  const [edit, setEdit] = useState<{ floor: string; ceiling: string; target: string } | null>(null);
  const save = async () => {
    try {
      const r = await api('/api/chain/tx', { signer: acting, method: 'set_pricing', args: { id: ticker, pricing: { price_floor: String(u(Number(edit!.floor))), price_ceiling: String(u(Number(edit!.ceiling))), target_runs: Number(edit!.target) } } });
      toast(`Pricing band updated · tx ${short(r.tx, 6, 4)}`); setEdit(null); onDone();
    } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <div className="panel">
      <header><h2>Market price</h2><span className="small muted">{p.fixed ? 'fixed by the creator' : 'set by demand'}</span></header>
      <dl className="kv body">
        <dt>Price per run now</dt><dd>{money(rec.pricePerRun, 4)}</dd>
        <dt>Band</dt><dd>{money(p.floor, 2)} – {money(p.ceiling, 2)}</dd>
        <dt>Paid runs this period</dt><dd>{p.periodRuns} of {p.targetRuns} target</dd>
        <dt>Period ends in</dt><dd>{left >= 120 ? `${Math.floor(left / 60)} min ${left % 60} s` : `${left} s`}</dd>
        {next !== null && <><dt>Next price if no more runs</dt><dd className={Number(next) / 1e6 > rec.pricePerRun ? 'gain' : Number(next) / 1e6 < rec.pricePerRun ? 'loss' : ''}>{money(Number(next) / 1e6, 4)}</dd></>}
      </dl>
      <div className="body small muted" style={{ paddingTop: 0 }}>
        More paid runs than the target raise the price by up to 12.5% a period, fewer lower it. Same rule as Ethereum's base fee, applied on-chain and proved to stay in the band.
        {mine && !edit && <p style={{ marginBottom: 0 }}><button className="btn ghost sm" onClick={() => setEdit({ floor: String(p.floor), ceiling: String(p.ceiling), target: String(p.targetRuns) })}>Change the band</button></p>}
      </div>
      {mine && edit && (
        <div className="body grid" style={{ gap: 6, paddingTop: 0, gridTemplateColumns: '1fr 1fr 1fr' }}>
          <input aria-label="Floor (USDC)" value={edit.floor} onChange={(e) => setEdit({ ...edit, floor: e.target.value })} />
          <input aria-label="Ceiling (USDC)" value={edit.ceiling} onChange={(e) => setEdit({ ...edit, ceiling: e.target.value })} />
          <input aria-label="Target runs" value={edit.target} onChange={(e) => setEdit({ ...edit, target: e.target.value })} />
          <button className="btn sm" onClick={save}>Save</button><button className="btn ghost sm" onClick={() => setEdit(null)}>Cancel</button>
        </div>
      )}
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
