import { useEffect, useState } from 'react';
import { nextPrice } from '../../../core/src/pricing';
import { api, money, short, usd, usePoll } from '../api';
import { useApp, useStoryOnce } from '../App';
import { CAT, Icon, RESULT_LABEL, recipeLook } from '../icons';
import { Empty, Head, Seal, Stat, Tip } from '../ui';

/**
 * Recipes: find a recipe (search, favorites), see its market-driven price, public track record and the guarantee
 * deposit that backs its quotes, and get a quote. There is nothing to invest in here: a buyer pays for one run of a
 * service, and the creator posts collateral that pays buyers when a run delivers less than its signed promise.
 */
const FAV_KEY = 'srs.favorites';
function useFavorites(): [Set<string>, (t: string) => void] {
  const [fav, setFav] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem(FAV_KEY) ?? '[]')); } catch { return new Set(); } });
  const toggle = (t: string) => setFav((f) => {
    const n = new Set(f); if (n.has(t)) n.delete(t); else n.add(t);
    try { localStorage.setItem(FAV_KEY, JSON.stringify([...n])); } catch { /* storage unavailable: favorites last for this visit */ }
    return n;
  });
  return [fav, toggle];
}

export function Recipes({ ticker: wanted }: { ticker?: string }) {
  const { go, story } = useApp();
  const once = useStoryOnce();
  const [listings] = usePoll<any[]>('/api/listings', 2500);
  const [q, setQ] = useState('');
  const [fav, toggleFav] = useFavorites();
  const ticker = wanted && listings?.some((l) => l.ticker === wanted) ? wanted : listings?.[0]?.ticker;
  const select = (t: string) => go({ page: 'recipes', ticker: t });

  const match = (l: any) => {
    const s = q.trim().toLowerCase(); if (!s) return true;
    return [l.ticker, l.name, l.description, l.creator, ...l.parts.map((p: string) => p.split('@')[0])].join(' ').toLowerCase().includes(s);
  };
  const shown = (listings ?? []).filter(match);
  const favs = shown.filter((l) => fav.has(l.ticker));
  const rest = shown.filter((l) => !fav.has(l.ticker));

  // story step 2: the buyer searches, opens CLNP, then asks it for a quote
  useEffect(() => {
    if (story.step !== 2 || !listings?.some((l) => l.ticker === 'CLNP') || !once('find')) return;
    const t1 = setTimeout(() => setQ('clean'), 700);
    const t2 = setTimeout(() => select('CLNP'), 1700);
    const t3 = setTimeout(() => go({ page: 'quote', ticker: 'CLNP' }), 5200);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [story.step, story.run, !!listings?.some((l) => l.ticker === 'CLNP')]);

  const row = (l: any) => (
    <li key={l.ticker} className={'rcp' + (l.ticker === ticker ? ' sel' : '') + (fav.has(l.ticker) ? ' fav' : '')}>
      <button className="pick" onClick={() => select(l.ticker)} aria-current={l.ticker === ticker ? 'true' : undefined}>
        <Seal ticker={l.ticker} kind={l.output_type} size={38} />
        <span className="nm">
          <b>{l.name}</b>
          <span className="sub"><span className="tk">{l.ticker}</span>by {l.creator.replace('.testnet', '')}</span>
        </span>
        <span className="px">
          <b>{money(l.record.pricePerRun)}</b>
          <Trend h={l.record.history} />
        </span>
      </button>
      <button className="star" aria-pressed={fav.has(l.ticker)} aria-label={(fav.has(l.ticker) ? 'Remove ' : 'Add ') + l.ticker + ' to favorites'} onClick={() => toggleFav(l.ticker)}><Icon name="star" size={15} fill={fav.has(l.ticker)} /></button>
    </li>
  );

  return (
    <div className="grid ex">
      <section className="rail" aria-label="Find a recipe">
        <label className="search-wrap"><Icon name="search" size={16} /><input className="search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search recipes, creators, parts" aria-label="Search recipes" /></label>
        <div className="rail-scroll">
          {favs.length > 0 && <><div className="listhead"><Icon name="star" size={13} fill />Favorites</div><ul className="rlist">{favs.map(row)}</ul></>}
          <div className="listhead">{q ? `${shown.length} matching` : 'All recipes'}<span className="count">{listings?.length ?? 0}</span></div>
          <ul className="rlist">{rest.map(row)}</ul>
          {listings && !shown.length && <Empty icon="search">Nothing matches “{q}”.</Empty>}
          {listings && !listings.some((l) => l.ticker === 'CLNP') && !q && (
            <div className="ghost-row" title="Play the demo to watch a creator compose and publish it"><Seal ticker="CLNP" kind="swap.receipts" size={38} className="dim" /><span className="nm"><b>Clean up and protect</b><span className="sub"><span className="tk">CLNP</span>published in the demo</span></span><Icon name="lock" size={15} /></div>
          )}
        </div>
      </section>

      <section className="grid detail" style={{ minWidth: 0 }}>
        {ticker && <RecipeDetail key={ticker} ticker={ticker} listings={listings ?? []} />}
      </section>
    </div>
  );
}

const RISK_TIP = 'Withdrawal risk: could this recipe be rebuilt if a part’s model or service disappeared? Open weights or bundled code: low. Remote services: medium. Closed models: high (SRS-1 §2.1).';

function RecipeDetail({ ticker, listings }: { ticker: string; listings: any[] }) {
  const { go } = useApp();
  const [m, refresh] = usePoll<any>(`/api/recipe/${ticker}`, 1500, [ticker]);
  const rec = m?.record;
  const l = listings.find((x) => x.ticker === ticker);
  if (!rec || !m.listing) return <div className="panel body muted loading"><span className="spinner" />Loading {ticker}</div>;
  const kept = rec.keptPromise;
  return (
    <>
      <div className="panel hero">
        <div className="hero-main">
          <Seal ticker={ticker} kind={l?.output_type} size={112} className="hero-seal" />
          <div className="hero-tx">
            <div className="hero-meta"><span className="tk lg">{ticker}</span><span>by <b>{m.listing.creator}</b></span><span className="ver">v{m.onchain?.version ?? 1}</span></div>
            <h1 className="listing-name">{m.listing.name}</h1>
            <p className="lede">{m.listing.description}</p>
            <div className="tags">
              {RESULT_LABEL[m.listing.output_type] && <span className="tag"><Icon name={recipeLook(ticker, m.listing.output_type).icon} size={13} />{RESULT_LABEL[m.listing.output_type]}</span>}
              <span className={'tag risk-' + m.listing.risk}><i className="dot" />{m.listing.risk} risk<Tip>{RISK_TIP}</Tip></span>
              {m.listing.privacy === 'confidential' && <span className="tag sealed"><Icon name="lock" size={13} />Confidential swaps</span>}
            </div>
          </div>
          <div className="hero-buy">
            <div className="bigpx">{money(rec.pricePerRun)}</div>
            <div className="per">per run <Tip>{rec.pricing.fixed ? 'Fixed by the creator.' : `Follows demand inside ${money(rec.pricing.floor)}–${money(rec.pricing.ceiling)}. A quote locks it.`}</Tip></div>
            <button id="get-quote" className="btn primary lg" onClick={() => go({ page: 'quote', ticker })}><Icon name="lock" size={16} />Get a quote</button>
          </div>
        </div>
        <div className="stats">
          <Stat icon="check" value={rec.runs} label={rec.runs === 1 ? 'paid run' : 'paid runs'} />
          <Stat icon="target" value={kept == null ? 'n/a' : `${Math.round(kept * 100)}%`} label="of promise kept" tone={kept == null ? undefined : kept >= 1 ? 'gain' : 'loss'} tip="Value delivered against the value promised in signed quotes, across all quoted runs." />
          <Stat icon="shield" value={money(rec.deposit.available, 0)} label="guarantee" tone="wax" tip="The creator’s collateral. If a run delivers less than its signed promise, the buyer is paid the shortfall from it, in the same settlement." />
          <Stat icon="receipt" value={money(rec.revenue)} label="billed" />
        </div>
      </div>

      <div className="panel">
        <Head icon="trend" title="Price and demand" tip="Line: price per run. Bars: paid runs per period; dashed line: the target. More runs than the target raise the price up to 12.5% a period, fewer lower it. It’s Ethereum’s base-fee rule, applied on-chain and proved to stay in the band.">
          <span className="spacer" /><span className="small muted">{money(rec.pricing.floor)}–{money(rec.pricing.ceiling)}</span>
        </Head>
        <PriceHistory rec={rec} />
      </div>

      <div className="panel">
        <Head icon="box" title="Inside" tip="Everyone sees which parts a recipe uses and what the buyer fills in. How they are wired, their settings and prompts are sealed to the runner.">
          <span className="spacer" /><span className="pill sealed"><Icon name="lock" size={12} />wiring sealed</span>
        </Head>
        <div className="body grid" style={{ gap: 12 }}>
          <div className="pipeline">
            <span className="pipe-form" title={'Buyer fills in: ' + m.listing.form.map((f: any) => f.label).join(', ')}><Icon name="user" size={15} />{m.listing.form.length} input{m.listing.form.length === 1 ? '' : 's'}</span>
            {m.listing.parts.map((b: string, i: number) => {
              const c = CAT[partCat(b)] ?? CAT.transform;
              return <button key={b + i} className="blk" style={{ ['--cc' as any]: c.color }} title={`${c.label} · ${b}. Click to open its code`} onClick={() => go({ page: 'compose', sub: 'part', part: b })}><Icon name={c.icon} size={15} /><span>{prettyPart(b)}</span></button>;
            })}
            <span className="pipe-out" title="Result for the buyer"><Icon name="check" size={15} /></span>
          </div>
          <div className="sealed-box"><Icon name="lock" size={14} /><span>On-chain commitment</span><span className="hash">{short(m.onchain?.sealed_hash ?? '', 14, 8)}</span></div>
        </div>
      </div>

      <div className="grid cards">
        <div className="stack">
        <MarketPrice ticker={ticker} rec={rec} onDone={refresh} />
        <div className="panel">
          <Head icon="clock" title="Track record" tip="Read from the contract." />
          <dl className="kv body">
            <dt><Icon name="check" size={14} />Successful</dt><dd>{rec.runs}</dd>
            <dt><Icon name="refresh" size={14} />Refunded</dt><dd>{rec.failed}</dd>
            <dt><Icon name="x" size={14} />Aborted</dt><dd>{rec.aborted}</dd>
            <dt><Icon name="shield" size={14} />Paid to buyers</dt><dd>{money(rec.deposit.paidToBuyers, 2)}</dd>
            <dt><Icon name="receipt" size={14} />Settles</dt><dd>{m.onchain?.settle_mode === 'checkpoint' ? 'per part' : 'once per run'}</dd>
          </dl>
          {m.onchain?.pending_sealed_hash && <div className="body small" style={{ paddingTop: 0 }}><span className="pill warn">v{(m.onchain.version ?? 1) + 1} from {new Date(Number(BigInt(m.onchain.update_effective_ns) / 1_000_000n)).toLocaleString()}</span> <Tip>Runs already paid keep the version they paid for.</Tip></div>}
        </div>
        </div>
        <Split rec={rec} />
        <div className="stack">
        <Deposit ticker={ticker} rec={rec} deposits={m.deposits} onDone={refresh} />
        <div className="panel">
          <Head icon="receipt" title="Settlements" tip="One receipt per paid run: every party is paid in the same transaction." />
          {m.settlements.length === 0 ? <Empty icon="receipt">No paid runs yet.</Empty> :
          <table><tbody>
            {m.settlements.slice(0, 8).map((x: any) => (
              <tr key={x.run_id} title={`${x.payouts.length} payees · ${usd(x.reserve)} to the guarantee`}><td><span className="hash">{short(x.tx, 6, 4)}</span>{x.compensation !== '0' && <div className="small gain">{usd(x.compensation)} to buyer</div>}</td><td className="muted small"><Icon name="users" size={13} /> {x.payouts.length}</td><td className="r"><b>{usd(x.price, 2)}</b></td></tr>
            ))}
          </tbody></table>}
        </div>
        </div>
      </div>
    </>
  );
}

const partCat = (id: string): string => {
  const n = id.split('@')[0];
  if (/scanner|positions|facts|access-keys|rpc|fresh/.test(n)) return 'source';
  if (/shield|risk|verified|check|allowlist/.test(n)) return 'guard';
  if (/swap|revoke|withdraw|claim|atomic|intents/.test(n)) return 'action';
  if (/report|summary|merge/.test(n)) return 'sink';
  return 'transform';
};
const prettyPart = (id: string) => id.split('@')[0].split('.').slice(1).join(' ').replace(/-/g, ' ');

/** Where each run's price goes: one bar, every party. */
function Split({ rec }: { rec: any }) {
  const p = rec.perRun;
  const segs = [
    { k: 'Creator', v: p.creator, c: 'var(--wax)' },
    ...p.parts.map((x: any) => ({ k: prettyPart(x.part), v: x.amount, c: 'var(--c-source)' })),
    { k: 'Runner', v: p.runner, c: 'var(--c-transform)' },
    { k: 'Guarantee', v: p.reserve, c: 'var(--gain)' },
    { k: 'Protocol', v: p.protocol, c: 'var(--muted)' },
  ].filter((s) => s.v > 0);
  const tot = segs.reduce((a, s) => a + s.v, 0) || 1;
  return (
    <div className="panel">
      <Head icon="split" title="Where the price goes" tip={`Sums to exactly ${money(p.price, 4)}, proved for every input in verification/. ${p.reserveBps / 100}% of the creator’s cut tops up the guarantee.`} />
      <div className="body">
        <div className="splitbar">{segs.map((s, i) => <i key={i} style={{ flex: s.v / tot, background: s.c }} title={`${s.k} ${money(s.v, 4)}`} />)}</div>
        <dl className="kv legend">
          {segs.map((s, i) => <span key={i} style={{ display: 'contents' }}><dt><i className="sw" style={{ background: s.c }} />{s.k}</dt><dd>{money(s.v, 4)}</dd></span>)}
        </dl>
      </div>
    </div>
  );
}

function useNow(ms = 1000) { const [n, setN] = useState(Date.now()); useEffect(() => { const t = setInterval(() => setN(Date.now()), ms); return () => clearInterval(t); }, [ms]); return n; }

/** small arrow: the list price now vs the previous period */
function Trend({ h }: { h: { price: number }[] }) {
  if (!h || h.length < 2) return null;
  const a = h[h.length - 2].price, b = h[h.length - 1].price;
  if (a === b) return <span className="trend flat">±0%</span>;
  return <span className={'trend ' + (b > a ? 'gain' : 'loss')}>{b > a ? '▲' : '▼'} {Math.abs((b - a) / a * 100).toFixed(1)}%</span>;
}

/** Price per run and paid runs per pricing period: the demand that moved each price. Usage, not trading. */
function PriceHistory({ rec }: { rec: any }) {
  const h: { runs: number; price: number }[] = rec.history ?? [];
  if (!h.length) return <Empty icon="trend">No price history yet.</Empty>;
  const W = 760, H = 150, pad = 8, n = Math.max(h.length, 12), bw = (W - 2 * pad) / n;
  const maxRuns = Math.max(rec.pricing.targetRuns * 2, ...h.map((x) => x.runs), 1);
  const seen = h.map((x) => x.price);
  const lo = Math.min(rec.pricing.floor, ...seen), top = Math.max(...seen);
  const hi = Math.max(top + (top - lo) * 0.25, lo * 1.15, lo + 1e-9);
  const y = (p: number) => pad + 14 + (1 - (p - lo) / (hi - lo)) * (H - 2 * pad - 14);
  const yr = (r: number) => H - pad - (r / maxRuns) * (H * 0.42);
  const x0 = W - pad - h.length * bw;
  const line = h.map((x, i) => `${i ? 'L' : 'M'}${x0 + i * bw},${y(x.price)} H${x0 + (i + 1) * bw}`).join(' ');
  const area = line + ` V${H - pad} H${x0} Z`;
  const last = h[h.length - 1];
  return (
    <div className="body chart" style={{ paddingTop: 4 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label="Price and demand per period">
        <defs><linearGradient id="pxfill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#F0B44C" stopOpacity=".24" /><stop offset="1" stopColor="#F0B44C" stopOpacity="0" /></linearGradient></defs>
        <line x1={pad} x2={W - pad} y1={y(rec.pricing.floor)} y2={y(rec.pricing.floor)} stroke="var(--line-2)" />
        {h.map((x, i) => <rect key={i} x={x0 + i * bw + 2} width={bw - 4} rx={2} y={yr(x.runs)} height={H - pad - yr(x.runs)} fill={x.runs > rec.pricing.targetRuns ? 'var(--gain)' : x.runs < rec.pricing.targetRuns ? 'var(--line-2)' : 'var(--muted)'} opacity={0.75} />)}
        <line x1={pad} x2={W - pad} y1={yr(rec.pricing.targetRuns)} y2={yr(rec.pricing.targetRuns)} stroke="var(--muted)" strokeDasharray="3 4" opacity=".7" />
        <path d={area} fill="url(#pxfill)" />
        <path d={line} fill="none" stroke="var(--wax)" strokeWidth={2.25} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="chart-lbl" style={{ top: `${(y(last.price) / H) * 100}%` }}>{money(last.price, 3)}</div>
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
      toast(`Price band saved · tx ${short(r.tx, 6, 4)}`); setEdit(null); onDone();
    } catch (e) { toast((e as Error).message, true); }
  };
  const fill = Math.min(1, p.periodRuns / Math.max(1, p.targetRuns));
  const ring = 2 * Math.PI * 22;
  return (
    <div className="panel">
      <Head icon="clock" title="This period" tip={p.fixed ? 'Fixed by the creator.' : 'Paid runs this period against the target decide the next price.'}>
        <span className="spacer" />{mine && !edit && !p.fixed && <button className="btn ghost sm icon-only" aria-label="Change the band" title="Change the band" onClick={() => setEdit({ floor: String(p.floor), ceiling: String(p.ceiling), target: String(p.targetRuns) })}><Icon name="sliders" size={14} /></button>}
      </Head>
      <div className="body period">
        <svg width="64" height="64" viewBox="0 0 56 56" aria-hidden className="ring">
          <circle cx="28" cy="28" r="22" fill="none" stroke="var(--line)" strokeWidth="5" />
          <circle cx="28" cy="28" r="22" fill="none" stroke="var(--wax)" strokeWidth="5" strokeLinecap="round" strokeDasharray={`${fill * ring} ${ring}`} transform="rotate(-90 28 28)" />
          <text x="28" y="32" textAnchor="middle" className="ring-tx">{p.periodRuns}/{p.targetRuns}</text>
        </svg>
        <dl className="kv">
          <dt>Runs vs target</dt><dd>{p.periodRuns} of {p.targetRuns}</dd>
          <dt>Ends in</dt><dd>{left >= 120 ? `${Math.floor(left / 60)}m ${left % 60}s` : `${left}s`}</dd>
          {next !== null && <><dt>Next price</dt><dd className={Number(next) / 1e6 > rec.pricePerRun ? 'gain' : Number(next) / 1e6 < rec.pricePerRun ? 'loss' : ''}>{money(Number(next) / 1e6, 4)}</dd></>}
        </dl>
      </div>
      {mine && edit && (
        <div className="body grid band-edit">
          <label className="field"><span>Floor</span><input aria-label="Floor (USDC)" value={edit.floor} onChange={(e) => setEdit({ ...edit, floor: e.target.value })} /></label>
          <label className="field"><span>Ceiling</span><input aria-label="Ceiling (USDC)" value={edit.ceiling} onChange={(e) => setEdit({ ...edit, ceiling: e.target.value })} /></label>
          <label className="field"><span>Target</span><input aria-label="Target runs" value={edit.target} onChange={(e) => setEdit({ ...edit, target: e.target.value })} /></label>
          <div className="row"><button className="btn sm" onClick={save}>Save band</button><button className="btn ghost sm" onClick={() => setEdit(null)}>Cancel</button></div>
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
  const d = rec.deposit;
  const tot = d.available + d.locked || 1;
  return (
    <div className="panel">
      <Head icon="shield" title="Guarantee deposit" tip={`The creator’s own collateral, not an investment. Each quote locks part of it as cover; a shortfall against the promise is paid to the buyer from it. It earns nothing. ${mine ? 'You can top it up or withdraw the free part.' : `Only ${rec.creator} can withdraw it.`}`} />
      <div className="body grid" style={{ gap: 10 }}>
        <div className="dep-fig"><b>{money(d.available, 2)}</b><span className="muted">free{d.locked > 0 && <> · {money(d.locked, 2)} locked</>}</span></div>
        {d.available + d.locked > 0 && <div className="splitbar thin"><i style={{ flex: d.available / tot, background: 'var(--gain)' }} /><i style={{ flex: d.locked / tot, background: 'var(--wax)' }} /></div>}
        <div className="small muted">+{money(d.fromRuns, 4)} added from runs</div>
        {mine && (
          <div className="row wrap" style={{ gap: 6 }}>
            <input className="amt" aria-label="Amount in USDC" value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" />
            <button className="btn sm" disabled={!Number(amt)} onClick={() => tx('bond', { recipe_id: ticker, amount: units }, `Topped up ${money(Number(amt))}`)}><Icon name="plus" size={13} />Top up</button>
            <button className="btn ghost sm" disabled={!Number(amt) || Number(amt) > d.available} onClick={() => tx('withdraw_bond', { recipe_id: ticker, amount: units }, `Withdrew ${money(Number(amt))}`)}>Withdraw</button>
          </div>
        )}
        {deposits.length > 0 && <table className="small"><tbody>{deposits.slice(0, 3).map((x: any, i: number) => <tr key={i}><td>{x.event === 'bond_posted' ? x.from : 'withdrawn'}</td><td className="muted hash">{short(x.tx, 6, 4)}</td><td className={'r ' + (x.event === 'bond_posted' ? 'gain' : 'loss')}>{x.event === 'bond_posted' ? '+' : '−'}{usd(x.amount, 2)}</td></tr>)}</tbody></table>}
      </div>
    </div>
  );
}
