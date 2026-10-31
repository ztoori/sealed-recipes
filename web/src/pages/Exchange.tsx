import { useEffect, useState } from 'react';
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
          Each recipe is a sealed workflow with a fixed supply of shares. Every paid run streams a dividend to holders, so price tracks how much the workflow is actually used.
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
            <div className="body small muted">Grey candles: synthetic pre-launch history (local mode). Coloured candles: real trades on the ledger since this server started.</div>
          </div>
        )}
        {s && (
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
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
                <div className="blocks-strip">
                  {m.listing?.blocks.map((b: string, i: number) => (
                    <span key={b} className="row" style={{ gap: 6 }}>{i > 0 && <span className="arrow">›</span>}<span className="blk">{b.split('@')[0]}<small>{b.split('@')[1]}</small></span></span>
                  ))}
                </div>
                <div className="small">Form: {m.listing?.form.map((f: any) => f.label).join(', ')}</div>
                <div className="sealed-box">Wiring, parameters and prompts are sealed to the runner. On-chain commitment <SealedHash ticker={ticker} /></div>
                <button className="btn ghost sm" onClick={() => go('run', ticker)}>Run this recipe ({money(s.pricePerRun)})</button>
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
        {m && <OrderBook book={m.book} last={s?.last} />}
        {m && <Ticket ticker={ticker} last={s?.last} onDone={refresh} />}
        {m && (
          <div className="panel">
            <header><h2>Trades</h2></header>
            <table className="small"><tbody>
              {m.trades.slice(0, 12).map((t: any, i: number) => (
                <tr key={i}><td className={t.taker_side === 'Bid' ? 'gain' : 'loss'}>{px(Number(t.price) / 1e6)}</td><td className="r">{Number(t.qty).toLocaleString()}</td><td className="r muted">{short(t.buyer, 10, 0)}</td></tr>
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

function OrderBook({ book, last }: { book: { bids: any[]; asks: any[] }; last: number }) {
  const asks = book.asks.slice(0, 8).reverse();
  const bids = book.bids.slice(0, 8);
  const max = Math.max(1, ...book.asks.slice(0, 8).map((a) => a.qty), ...bids.map((b) => b.qty));
  return (
    <div className="panel book">
      <header><h2>Order book</h2><span className="small muted">shares vs USDC</span></header>
      <div className="lvl muted small"><span>Price</span><span>Shares</span><span>Orders</span></div>
      {asks.map((a) => <div key={'a' + a.price} className="lvl ask"><div className="bar" style={{ width: `${(a.qty / max) * 100}%` }} /><span>{px(a.price)}</span><span>{a.qty.toLocaleString()}</span><span>{a.orders}</span></div>)}
      <div className="mid"><span>{px(last)}</span><span className="muted small">spread {book.asks[0] && book.bids[0] ? px(book.asks[0].price - book.bids[0].price) : '—'}</span></div>
      {bids.map((b) => <div key={'b' + b.price} className="lvl bid"><div className="bar" style={{ width: `${(b.qty / max) * 100}%` }} /><span>{px(b.price)}</span><span>{b.qty.toLocaleString()}</span><span>{b.orders}</span></div>)}
    </div>
  );
}

function Ticket({ ticker, last, onDone }: { ticker: string; last: number; onDone: () => void }) {
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
      toast(`${side === 'buy' ? 'Bid' : 'Ask'} placed as ${acting} · tx ${short(r.tx, 6, 4)}`); onDone();
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
        <button className={'btn ' + (side === 'buy' ? 'buy' : 'sell')} disabled={!units || !Number(qty)} onClick={submit}>{side === 'buy' ? 'Place bid' : 'Place ask'}</button>
        <div className="small muted">{side === 'buy' ? 'Bids arrive as ft_transfer_call on the payment token (or through NEAR Intents with on_behalf_of).' : 'Shares stay in your account, locked, and keep earning dividends until filled.'}</div>
      </div>
    </div>
  );
}
