import { api, money, px, short, usd, usePoll } from '../api';
import { useApp } from '../App';

export function Wallet() {
  const { acting, toast, go } = useApp();
  const [p, refresh] = usePoll<any>(`/api/portfolio/${acting}`, 1500, [acting]);
  const [ev] = usePoll<any>('/api/chain/events?last=600', 3000);
  const income = (ev?.events ?? []).flatMap((e: any) => {
    const d = e.data[0];
    if (e.event === 'frs_settlement') return d.payouts.filter((x: any) => x.account_id === acting).map((x: any) => ({ what: x.role.startsWith('part:') ? `part fee (${x.role.slice(6).split('@')[0]})` : x.role.replace('_', ' '), ref: d.recipe_id, amount: Number(x.amount), tx: e.tx_hash }));
    if (e.event === 'batch_cleared' && d.price !== null) return d.fills.filter((f: any) => f.owner === acting && f.side === 'Ask').map((f: any) => ({ what: `sold ${Number(f.qty).toLocaleString()} shares in batch #${d.batch_id}`, ref: d.recipe_id, amount: Number(f.qty) * Number(d.price), tx: e.tx_hash }));
    if (e.event === 'dividends_claimed' && d.account_id === acting && d.amount !== '0') return [{ what: 'dividends claimed', ref: d.recipe_id, amount: Number(d.amount), tx: e.tx_hash }];
    return [];
  }).reverse();
  const tx = async (method: string, args: Record<string, unknown>, ok: string) => {
    try { const r = await api('/api/chain/tx', { signer: acting, method, args }); toast(`${ok} · tx ${short(r.tx, 6, 4)}`); refresh(); } catch (e) { toast((e as Error).message, true); }
  };
  if (!p) return null;
  const pendingTotal = p.positions.reduce((s: number, x: any) => s + Number(x.pending), 0);
  return (
    <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', alignItems: 'start' }}>
      <div className="panel">
        <header><h2>{acting}</h2><span className="small muted">contract balance</span></header>
        <div className="body grid" style={{ gap: 10 }}>
          <div className="bigpx">{usd(p.balance)} <span className="small muted">USDC withdrawable</span></div>
          <div className="small muted">Fees, royalties, dividends, refunds and sale proceeds all land here inside the settlement receipt. Withdraw sends an ft_transfer of the payment token (1 yoctoNEAR attached on testnet).</div>
          <div className="row"><button className="btn" disabled={p.balance === '0'} onClick={() => tx('withdraw', {}, 'Withdrawn')}>Withdraw all</button></div>
        </div>
      </div>
      <div className="panel">
        <header><h2>Recipe shares</h2><span className="small muted">{money(pendingTotal / 1e6, 4)} unclaimed dividends</span></header>
        {p.positions.length === 0 && <div className="body small muted">No shares. Buy some on the exchange, or publish a recipe to receive its whole supply.</div>}
        <table><thead><tr><th>Recipe</th><th className="r">Shares</th><th className="r">Value</th><th className="r">Dividends</th><th /></tr></thead><tbody>
          {p.positions.map((x: any) => (
            <tr key={x.ticker}>
              <td><button className="btn ghost sm" onClick={() => go('exchange', x.ticker)}>{x.ticker}</button></td>
              <td className="r">{Number(x.shares).toLocaleString()}{x.locked !== '0' && <div className="small muted">{Number(x.locked).toLocaleString()} in asks</div>}</td>
              <td className="r">{money(Number(x.shares) * x.last)}<div className="small muted">@ {px(x.last)}</div></td>
              <td className="r">{usd(x.pending)}</td>
              <td className="r"><button className="btn sm" disabled={x.pending === '0'} onClick={() => tx('claim_dividends', { recipe_id: x.ticker }, `Claimed ${x.ticker} dividends`)}>Claim</button></td>
            </tr>
          ))}
        </tbody></table>
      </div>
      <div className="panel">
        <header><h2>Income</h2><span className="small muted">from settlements and auctions, recent</span></header>
        {income.length === 0 && <div className="body small muted">Nothing yet. Part authors, creators and the runner are paid inside each run's settlement.</div>}
        <table className="small"><tbody>
          {income.slice(0, 12).map((x: any, i: number) => <tr key={i}><td>{x.what}<div className="muted">{x.ref} · tx {short(x.tx, 6, 4)}</div></td><td className="r gain">+{usd(x.amount)}</td></tr>)}
        </tbody></table>
        <div className="body small muted">Dividends move into your balance automatically whenever your share balance changes (a trade, a transfer), or when you claim.</div>
      </div>
      <div className="panel">
        <header><h2>Open orders</h2></header>
        {p.orders.length === 0 && <div className="body small muted">No open orders.</div>}
        <table className="small"><tbody>
          {p.orders.map((o: any) => (
            <tr key={o.id}><td>#{o.id} {o.recipe_id}</td><td className={o.side === 'Bid' ? 'gain' : 'loss'}>{o.side}</td><td className="r">{Number(o.qty).toLocaleString()} @ {px(Number(o.price) / 1e6)}</td>
              <td className="r"><button className="btn ghost sm" onClick={() => tx('cancel_order', { order_id: o.id }, 'Order cancelled')}>Cancel</button></td></tr>
          ))}
        </tbody></table>
      </div>
      <div className="panel">
        <header><h2>Tokens in this wallet</h2><span className="small muted">local world, fictional balances</span></header>
        {p.wallet.length === 0 && <div className="body small muted">No tokens.</div>}
        <table className="small"><tbody>
          {p.wallet.filter((w: any) => w.balance !== '0').map((w: any) => (
            <tr key={w.contract_id}><td><b>{w.symbol}</b><div className="muted hash">{short(w.contract_id, 18, 8)}</div></td><td className="r">{(Number(w.balance) / 10 ** (w.decimals ?? 0)).toLocaleString(undefined, { maximumFractionDigits: 4 })}</td></tr>
          ))}
        </tbody></table>
      </div>
    </div>
  );
}
