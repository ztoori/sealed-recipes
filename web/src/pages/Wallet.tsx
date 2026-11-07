import { api, short, usd, usePoll } from '../api';
import { useApp } from '../App';

export function Wallet() {
  const { acting, toast, go } = useApp();
  const [p, refresh] = usePoll<any>(`/api/account/${acting}`, 1500, [acting]);
  const [ev] = usePoll<any>('/api/chain/events?last=600', 3000);
  const income = (ev?.events ?? []).flatMap((e: any) => {
    const d = e.data[0];
    if (e.event === 'srs_settlement') return [...(d.buyer === acting && d.compensation !== '0' ? [{ what: 'shortfall paid from the guarantee deposit', ref: d.recipe_id, amount: Number(d.compensation), tx: e.tx_hash }] : []), ...d.payouts.filter((x: any) => x.account_id === acting).map((x: any) => ({ what: x.role.startsWith('part:') ? `part fee (${x.role.slice(5).split('@')[0]})` : x.role.replace('_', ' '), ref: d.recipe_id, amount: Number(x.amount), tx: e.tx_hash }))];
    return [];
  }).reverse();
  const tx = async (method: string, args: Record<string, unknown>, ok: string) => {
    try { const r = await api('/api/chain/tx', { signer: acting, method, args }); toast(`${ok} · tx ${short(r.tx, 6, 4)}`); refresh(); } catch (e) { toast((e as Error).message, true); }
  };
  if (!p) return null;
  return (
    <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', alignItems: 'start' }}>
      <div className="panel">
        <header><h2>{acting}</h2><span className="small muted">contract balance</span></header>
        <div className="body grid" style={{ gap: 10 }}>
          <div className="bigpx">{usd(p.balance)} <span className="small muted">USDC withdrawable</span></div>
          <div className="small muted">Fees, creator earnings, refunds and shortfall payments all land here inside the settlement receipt. Withdraw sends an ft_transfer of the payment token (1 yoctoNEAR attached on testnet).</div>
          <div className="row"><button className="btn" disabled={p.balance === '0'} onClick={() => tx('withdraw', {}, 'Withdrawn')}>Withdraw all</button></div>
        </div>
      </div>
      <div className="panel">
        <header><h2>Recipes you created</h2></header>
        {p.created.length === 0 && <div className="body small muted">None yet. Compose one and publish it; you are paid inside every run's settlement. <button className="btn ghost sm" onClick={() => go({ page: 'compose', sub: 'recipe' })}>Compose a recipe</button></div>}
        {p.created.length > 0 && <table><thead><tr><th>Recipe</th><th className="r">Runs</th><th className="r">Earned</th><th className="r">Guarantee deposit</th></tr></thead><tbody>
          {p.created.map((x: any) => (
            <tr key={x.ticker}>
              <td><button className="btn ghost sm" onClick={() => go({ page: 'recipes', ticker: x.ticker })}>{x.ticker}</button></td>
              <td className="r">{Number(x.runs)}</td>
              <td className="r">{usd(x.earned)}</td>
              <td className="r">{usd(x.deposit_available, 2)}{x.deposit_locked !== '0' && <div className="small muted">+{usd(x.deposit_locked, 2)} locked</div>}</td>
            </tr>
          ))}
        </tbody></table>}
      </div>
      <AccountHealth chain={p.chain} />
      <div className="panel">
        <header><h2>Income</h2><span className="small muted">from settlements, recent</span></header>
        {income.length === 0 && <div className="body small muted">Nothing yet. Part authors, creators and the runner are paid inside each run's settlement.</div>}
        <table className="small"><tbody>
          {income.slice(0, 12).map((x: any, i: number) => <tr key={i}><td>{x.what}<div className="muted">{x.ref} · tx {short(x.tx, 6, 4)}</div></td><td className="r gain">+{usd(x.amount)}</td></tr>)}
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

const NEARf = (y: string) => Number(BigInt(y) / 10n ** 21n) / 1000;
/** What a recipe could do for this account, from its own on-chain state: connects the wallet to the recipes. */
function AccountHealth({ chain }: { chain: { native: string; keys: { public_key: string; full: boolean; receiver?: string }[]; stakes: { pool: string; staked: string; unstaked: string; can_withdraw: boolean; active: boolean }[] } }) {
  const { go } = useApp();
  const full = chain.keys.filter((k) => k.full).length, app = chain.keys.length - full;
  const ready = chain.stakes.filter((s) => s.can_withdraw && BigInt(s.unstaked) > 0n).reduce((t, s) => t + NEARf(s.unstaked), 0);
  const idle = chain.stakes.filter((s) => !s.active && BigInt(s.staked) > 0n);
  if (!chain.keys.length && !chain.stakes.length && chain.native === '0') return null;
  const tip = (show: boolean, text: string, ticker: string) => show && <div className="row between small" style={{ padding: '6px 0', borderTop: '1px solid var(--rule-soft)' }}><span>{text}</span><button className="btn ghost sm" onClick={() => go({ page: 'recipes', ticker })}>{ticker}</button></div>;
  return (
    <div className="panel">
      <header><h2>Account</h2><span className="small muted">on-chain state (local world)</span></header>
      <div className="body">
        <dl className="kv">
          <dt>NEAR</dt><dd>{NEARf(chain.native).toLocaleString()}</dd>
          <dt>Access keys</dt><dd>{full} full-access, {app} app key{app === 1 ? '' : 's'}</dd>
          <dt>Staked</dt><dd>{chain.stakes.reduce((t, s) => t + NEARf(s.staked), 0).toLocaleString()} NEAR in {chain.stakes.length} pool{chain.stakes.length === 1 ? '' : 's'}</dd>
        </dl>
        <div style={{ marginTop: 8 }}>
          {tip(app > 0 || full > 1, `${app} app key${app === 1 ? '' : 's'} left by dApps${full > 1 ? `, ${full} full-access keys` : ''}: check which are risky`, 'KEYS')}
          {tip(ready > 0, `${ready.toLocaleString()} NEAR finished unbonding and is waiting to be withdrawn`, 'STAK')}
          {tip(idle.length > 0, `${idle.length} validator${idle.length > 1 ? 's' : ''} you stake with stopped validating`, 'STAK')}
        </div>
      </div>
    </div>
  );
}
