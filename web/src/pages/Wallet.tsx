import { api, short, usd, usePoll } from '../api';
import { useApp } from '../App';
import { Icon } from '../icons';
import { Empty, Head } from '../ui';

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
    <div className="grid wallet-grid">
      <div className="panel balance">
        <Head icon="wallet" title={acting} tip="Fees, creator earnings, refunds and shortfall payments all land here inside the settlement receipt. Withdraw sends an ft_transfer of the payment token (1 yoctoNEAR attached on testnet)." />
        <div className="body">
          <div className="bal-fig">{usd(p.balance, 2)}<small>USDC</small></div>
          <div className="row"><button className="btn primary" disabled={p.balance === '0'} onClick={() => tx('withdraw', {}, 'Withdrawn')}><Icon name="download" size={15} />Withdraw all</button><span className="small muted">{income.length} payment{income.length === 1 ? '' : 's'} received</span></div>
        </div>
      </div>
      <div className="panel">
        <Head icon="compose" title="Your recipes" />
        {p.created.length === 0 && <Empty icon="compose" action={<button className="btn ghost sm" onClick={() => go({ page: 'compose', sub: 'recipe' })}><Icon name="plus" size={13} />Compose</button>}>None yet. You are paid inside every run’s settlement.</Empty>}
        {p.created.length > 0 && <table><thead><tr><th>Recipe</th><th className="r">Runs</th><th className="r">Earned</th><th className="r">Guarantee</th></tr></thead><tbody>
          {p.created.map((x: any) => (
            <tr key={x.ticker} className="click" onClick={() => go({ page: 'recipes', ticker: x.ticker })}>
              <td><span className="tk">{x.ticker}</span></td>
              <td className="r">{Number(x.runs)}</td>
              <td className="r">{usd(x.earned)}</td>
              <td className="r">{usd(x.deposit_available, 2)}{x.deposit_locked !== '0' && <div className="small muted">+{usd(x.deposit_locked, 2)} locked</div>}</td>
            </tr>
          ))}
        </tbody></table>}
      </div>
      <AccountHealth chain={p.chain} />
      <div className="panel">
        <Head icon="trend" title="Income" tip="From settlements, most recent first. Part authors, creators and the runner are paid inside each run’s settlement." />
        {income.length === 0 && <Empty icon="receipt">Nothing yet.</Empty>}
        <table className="small"><tbody>
          {income.slice(0, 12).map((x: any, i: number) => <tr key={i}><td><span className="tk">{x.ref}</span></td><td style={{ textTransform: 'capitalize' }}>{x.what}<div className="muted hash">tx {short(x.tx, 6, 4)}</div></td><td className="r gain"><b>+{usd(x.amount)}</b></td></tr>)}
        </tbody></table>
      </div>
      <div className="panel">
        <Head icon="layers" title="Tokens" tip="Local world: fictional balances." />
        {p.wallet.length === 0 && <Empty icon="layers">No tokens.</Empty>}
        <table className="small"><tbody>
          {p.wallet.filter((w: any) => w.balance !== '0').map((w: any) => (
            <tr key={w.contract_id} className="tokrow"><td><span className="tokdot">{String(w.symbol).slice(0, 3)}</span><span><b>{w.symbol}</b><div className="muted hash">{short(w.contract_id, 16, 6)}</div></span></td><td className="r">{(Number(w.balance) / 10 ** (w.decimals ?? 0)).toLocaleString(undefined, { maximumFractionDigits: 4 })}</td></tr>
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
  const tip = (show: boolean, text: string, ticker: string, icon: string) => show && <div className="tipline"><Icon name={icon} size={16} /><span>{text}</span><button className="btn ghost sm" onClick={() => go({ page: 'recipes', ticker })}>{ticker}<Icon name="chevron" size={12} /></button></div>;
  return (
    <div className="panel">
      <Head icon="user" title="Account" tip="On-chain state (local world). Suggestions point to recipes that could help." />
      <div className="body">
        <dl className="kv">
          <dt><Icon name="globe" size={14} />NEAR</dt><dd>{NEARf(chain.native).toLocaleString()}</dd>
          <dt><Icon name="key" size={14} />Access keys</dt><dd>{full} full · {app} app</dd>
          <dt><Icon name="layers" size={14} />Staked</dt><dd>{chain.stakes.reduce((t, s) => t + NEARf(s.staked), 0).toLocaleString()} NEAR in {chain.stakes.length} pool{chain.stakes.length === 1 ? '' : 's'}</dd>
        </dl>
        <div className="tips">
          {tip(app > 0 || full > 1, `${app} app key${app === 1 ? '' : 's'} left by dApps${full > 1 ? `, ${full} full-access` : ''}`, 'KEYS', 'key')}
          {tip(ready > 0, `${ready.toLocaleString()} NEAR ready to withdraw`, 'STAK', 'layers')}
          {tip(idle.length > 0, `${idle.length} validator${idle.length > 1 ? 's' : ''} stopped validating`, 'STAK', 'alert')}
        </div>
      </div>
    </div>
  );
}
