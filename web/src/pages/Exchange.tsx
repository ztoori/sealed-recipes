import { useEffect, useState } from 'react';

function useNow(ms = 250) { const [n, setN] = useState(Date.now()); useEffect(() => { const t = setInterval(() => setN(Date.now()), ms); return () => clearInterval(t); }, [ms]); return n; }
import { api, compact, money, pct, px, short, usd, usePoll } from '../api';
import { useApp } from '../App';
import { PriceChart } from '../components/Chart';

export function Exchange() {
  const { ticker, setTicker, go } = useApp();
  const [listings] = usePoll<any[]>('/api/listings', 2500);
  useEffect(() => { if (listings?.length && !listings.some((l) => l.ticker === ticker)) setTicker(listings[0].ticker); }, [listings, ticker]);
  const [m, refresh] = usePoll<any>(ticker ? `/api/market/${ticker}` : null, 1500, [ticker]);
  const s = m?.stats;

  return (
    <div className="grid ex">
      <section className="panel" aria-label="Listed recipes">
        <header><h2>Listed recipes</h2><span className="muted small">{listings?.length ?? 0}</span></header>
        <table>
          <thead><tr><th>Recipe</th><th className="r">Last</th><th className="r">24h</th></tr></thead>
          <tbody>
            {(listings ?? []).map((l) => (
              <tr key={l.ticker} className={'click' + (l.ticker === ticker ? ' sel' : '')} onClick={() => setTicker(l.ticker)}>
                <td><b>{l.ticker}</b><div className="small muted">{l.name}</div></td>
                <td className="r">{px(l.market.last)}</td>
                <td className={'r ' + (l.market.change24h >= 0 ? 'gain' : 'loss')}>{pct(l.market.change24h)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="body small muted">
          Revenue shares are optional funding for creators: they sell part of a recipe's future run revenue, and every paid run pays holders a dividend. Shares change hands in frequent batch auctions: orders collect for {s?.batch ? Math.round(s.batch.intervalMs / 1000) : 12} seconds, then everything that crosses clears at one price.
          {!listings?.some((l) => l.ticker === 'CLNP') && <p><button className="btn sm" onClick={() => go('compose')}>Compose “Clean up and protect”</button></p>}
        </div>
      </section>

      <section className="grid" style={{ minWidth: 0 }}>
        {s && m.listing && (
          <div className="panel">
            <div className="body">
              <div className="row between wrap" style={{ alignItems: 'flex-start' }}>
                <div>
                  <div className="small muted">{ticker} · by {m.listing.creator}</div>
                  <h1 className="listing-name">{m.listing.name}</h1>
                  <p className="muted" style={{ maxWidth: 640, margin: '6px 0 0' }}>{m.listing.description}</p>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="bigpx">{px(s.last)} <span className="small muted">USDC</span></div>
                  <div className={s.change24h >= 0 ? 'gain' : 'loss'}>{pct(s.change24h)} 24h</div>
                  <div className="small muted">mkt cap {money(s.marketCap, 0)}</div>
                </div>
              </div>
            </div>
            <PriceChart candles={m.candles} ticker={ticker} />
            <div className="body small muted">Grey candles: synthetic pre-launch history (local mode). Coloured candles: real auction clearings on the ledger since this server started.</div>
          </div>
        )}
        {s && (
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
            <div className="panel">
              <header><h2>Track record</h2><span className="small muted">on-chain</span></header>
              <dl className="kv body">
                <dt>Successful runs</dt><dd>{s.runs}</dd>
                <dt>Refunded runs</dt><dd>{Number(m.onchain?.failed ?? 0)}</dd>
                <dt>Delivered vs promised</dt><dd>{Number(m.onchain?.promised_total ?? 0) ? `${(Number(m.onchain.delivered_total) / Number(m.onchain.promised_total) * 100).toFixed(0)}%` : 'no quoted runs yet'}</dd>
                <dt>Bond backing quotes</dt><dd>{usd(m.onchain?.bond_available ?? 0, 2)}{Number(m.onchain?.bond_locked ?? 0) ? ` (+${usd(m.onchain.bond_locked, 2)} locked)` : ''}</dd>
                <dt>Paid out to buyers from bond</dt><dd>{usd(m.onchain?.compensated_total ?? 0, 2)}</dd>
                <dt>Withdrawal risk</dt><dd>{m.listing?.risk ?? '—'}</dd>
              </dl>
            </div>
            <div className="panel">
              <header><h2>Run economics</h2></header>
              <dl className="kv body">
                <dt>Price per run</dt><dd>{money(s.pricePerRun, 2)}</dd>
                <dt>To shareholders per run</dt><dd>{money(s.perRunToShareholders, 4)}</dd>
                <dt>Dividend per share per run</dt><dd>{(s.dividendPerSharePerRun * 1e6).toFixed(3)} µUSDC</dd>
                <dt>Runs to pay back a share</dt><dd>{s.runsToPayback ? compact(s.runsToPayback) : '—'}</dd>
                <dt>Paid runs</dt><dd>{s.runs}</dd>
                <dt>Dividends paid</dt><dd>{money(s.dividendsPaid, 4)}</dd>
              </dl>
            </div>
            <div className="panel">
              <header><h2>What the market can see</h2></header>
              <div className="body grid" style={{ gap: 8 }}>
                <div className="parts-strip">
                  {m.listing?.parts.map((b: string, i: number) => (
                    <span key={b} className="row" style={{ gap: 6 }}>{i > 0 && <span className="arrow">›</span>}<span className="blk">{b.split('@')[0]}<small>{b.split('@')[1]}</small></span></span>
                  ))}
                </div>
                <div className="small">Form: {m.listing?.form.map((f: any) => f.label).join(', ')}</div>
                <div className="sealed-box">Wiring, parameters and prompts are sealed to the runner. On-chain commitment <SealedHash ticker={ticker} /></div>
                <button className="btn ghost sm" onClick={() => go('run', ticker)}>Get a quote from {ticker} ({money(s.pricePerRun)} per run)</button>
              </div>
            </div>
          </div>
        )}
        {m && (
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
            <div className="panel">
              <header><h2>Settlements</h2><span className="small muted">one receipt per paid run</span></header>
              {m.settlements.length === 0 && <div className="body muted small">No paid runs yet. Run the recipe to see every party get paid in one receipt.</div>}
              <table><tbody>
                {m.settlements.slice(0, 6).map((x: any) => (
                  <tr key={x.run_id}><td><span className="hash">{short(x.tx, 6, 4)}</span><div className="small muted">{x.payouts.length} payees + shareholders</div></td><td className="r">{usd(x.price, 2)}</td><td className="r small">{usd(x.shareholder_pool)} to holders</td></tr>
                ))}
              </tbody></table>
            </div>
            <div className="panel">
              <header><h2>Top holders</h2></header>
              <table><tbody>
                {m.holders.map((h: any) => (
                  <tr key={h.account}><td>{h.account}{h.account.startsWith('sim-trader') && <span className="pill" style={{ marginLeft: 6 }}>sim trader</span>}</td><td className="r">{(Number(h.shares) / Number(s.totalShares) * 100).toFixed(2)}%</td></tr>
                ))}
              </tbody></table>
            </div>
          </div>
        )}
      </section>

      <section className="grid">
        {m && <AuctionBook book={m.book} stats={s} />}
        {m && <Ticket ticker={ticker} last={s?.last} batch={s?.batch} onDone={refresh} />}
        {m && (
          <div className="panel">
            <header><h2>Auction results</h2><span className="small muted">one price per batch</span></header>
            {m.auctions.length === 0 && <div className="body small muted">The first batch is this recipe's opening auction.</div>}
            <table className="small"><thead><tr><th>Batch</th><th className="r">Price</th><th className="r">Shares</th><th className="r">Fills</th></tr></thead><tbody>
              {m.auctions.slice(0, 12).map((a: any) => (
                <tr key={a.batch_id}><td>#{a.batch_id}{a.batch_id === 1 && <span className="pill" style={{ marginLeft: 6 }}>opening</span>}</td><td className="r">{a.price === null ? <span className="muted">no cross</span> : px(Number(a.price) / 1e6)}</td><td className="r">{Number(a.volume).toLocaleString()}</td><td className="r muted">{a.fills}</td></tr>
              ))}
            </tbody></table>
          </div>
        )}
      </section>
    </div>
  );
}

function SealedHash({ ticker }: { ticker: string }) {
  const [v] = usePoll<any>(`/api/chain/recipes/${ticker}`, 10000, [ticker]);
  return <span className="hash"> {v ? short(v.sealed_hash, 14, 8) : ''}</span>;
}

function AuctionBook({ book, stats }: { book: { bids: any[]; asks: any[] }; stats: any }) {
  const now = useNow();
  const asks = book.asks.slice(0, 8).reverse();
  const bids = book.bids.slice(0, 8);
  const max = Math.max(1, ...book.asks.slice(0, 8).map((a) => a.qty), ...bids.map((b) => b.qty));
  const left = stats?.batch ? Math.max(0, stats.batch.closesMs - now) : 0;
  const frac = stats?.batch ? 1 - left / stats.batch.intervalMs : 0;
  const ind = stats?.indicative;
  return (
    <div className="panel book">
      <header><h2>Batch #{stats?.batch?.id ?? '…'}</h2><span className="small muted">clears in {(left / 1000).toFixed(1)} s</span></header>
      <div className="clock" aria-hidden><div style={{ width: `${Math.min(100, frac * 100)}%` }} /></div>
      <div className="lvl muted small"><span>Price</span><span>Shares</span><span>Orders</span></div>
      {asks.map((a) => <div key={'a' + a.price} className={'lvl ask' + (ind?.price != null && a.price <= ind.price ? ' in' : '')}><div className="bar" style={{ width: `${(a.qty / max) * 100}%` }} /><span>{px(a.price)}</span><span>{a.qty.toLocaleString()}</span><span>{a.orders}</span></div>)}
      <div className="mid">
        <span>{ind?.price != null ? <>Indicative {px(ind.price)}</> : <span className="muted">No cross yet</span>}</span>
        <span className="muted small">{ind?.volume ? `${ind.volume.toLocaleString()} shares would clear` : 'bids and asks don’t overlap'}</span>
      </div>
      {bids.map((b) => <div key={'b' + b.price} className={'lvl bid' + (ind?.price != null && b.price >= ind.price ? ' in' : '')}><div className="bar" style={{ width: `${(b.qty / max) * 100}%` }} /><span>{px(b.price)}</span><span>{b.qty.toLocaleString()}</span><span>{b.orders}</span></div>)}
      <div className="body small muted">Every order that crosses fills at the single clearing price, so there is nothing to gain by being first. Bold rows would fill if the batch closed now.</div>
    </div>
  );
}

function Ticket({ ticker, last, batch, onDone }: { ticker: string; last: number; batch?: { id: number }; onDone: () => void }) {
  const { acting, toast } = useApp();
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [price, setPrice] = useState('');
  const [qty, setQty] = useState('1000');
  useEffect(() => { if (last) setPrice(last.toFixed(5)); }, [ticker]);
  const units = Math.round(Number(price) * 1e6);
  const submit = async () => {
    try {
      const r = side === 'buy'
        ? await api('/api/chain/tx', { signer: acting, method: 'bid', args: { recipe_id: ticker, price: String(units), qty } })
        : await api('/api/chain/tx', { signer: acting, method: 'place_ask', args: { recipe_id: ticker, price: String(units), qty } });
      toast(`${side === 'buy' ? 'Bid' : 'Ask'} queued for batch #${batch?.id ?? ''} as ${acting} (tx ${short(r.tx, 6, 4)})`); onDone();
    } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <div className="panel">
      <header><h2>Trade {ticker}</h2><span className="small muted">as {acting}</span></header>
      <div className="body grid" style={{ gap: 10 }}>
        <div className="seg" role="group" aria-label="Side">
          <button className="b" aria-pressed={side === 'buy'} onClick={() => setSide('buy')}>Buy</button>
          <button className="s" aria-pressed={side === 'sell'} onClick={() => setSide('sell')}>Sell</button>
        </div>
        <div className="field"><label htmlFor="tp">Limit price (USDC per share)</label><input id="tp" value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" /></div>
        <div className="field"><label htmlFor="tq">Shares</label><input id="tq" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} inputMode="numeric" /></div>
        <div className="row between small"><span className="muted">{side === 'buy' ? 'Escrow' : 'Proceeds'}</span><b>{money((units * Number(qty)) / 1e6, 4)}</b></div>
        <button className={'btn ' + (side === 'buy' ? 'buy' : 'sell')} disabled={!units || !Number(qty)} onClick={submit}>{side === 'buy' ? `Bid in batch #${batch?.id ?? ''}` : `Offer in batch #${batch?.id ?? ''}`}</button>
        <div className="small muted">{side === 'buy' ? 'Your limit is the most you pay; you pay the batch’s clearing price and get the difference back. Bids arrive as ft_transfer_call (or through NEAR Intents with on_behalf_of).' : 'Your limit is the least you accept; you receive the clearing price. Shares stay in your account, locked, and keep earning dividends until filled.'}</div>
      </div>
    </div>
  );
}
