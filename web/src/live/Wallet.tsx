import { usePoll } from '../api';
import { Icon } from '../icons';
import { Empty, Head, Seal } from '../ui';
import { accUrl, fmtNear, tusdc, txUrl, useLive } from './ctx';
import { downloadGuest, forgetGuest, savedRuns } from './guest';

interface Balance { exists: boolean; near_yocto: string; tusdc: string }

/** The guest account and the runs started in this browser, laid out like the guided demo's Wallet. */
export function Wallet() {
  const { guest, setGuest, createGuest, fund, funding, go, listings } = useLive();
  const [bal, refresh] = usePoll<Balance>(guest ? `/api/account/${guest.account}/balance` : null, 15000, [guest?.account]);
  const runs = savedRuns();
  const kind = (t: string) => listings?.find((l) => l.ticker === t)?.output_type;
  return (
    <div className="grid wallet-grid">
      <div className="stack">
        <div className="panel balance">
          <Head icon="wallet" title={guest ? 'Guest account' : 'No account yet'} tip="A NEAR testnet implicit account: its name is its public key, so there is nothing to sign up for. The key is kept in this browser only and signs your own testnet payments. It holds test tokens with no value." />
          <div className="body grid" style={{ gap: 10 }}>
            {!guest ? (
              <>
                <p className="small" style={{ margin: 0 }}>You only need an account to pay for a run. Quotes are free and need none. Continue as a guest: a key is made in this browser and our faucet sends it test tokens once.</p>
                <div className="row"><button className="btn primary lg" disabled={funding} onClick={createGuest}>{funding ? <><span className="spinner" />Creating</> : <><Icon name="sparkles" size={15} />Continue as guest</>}</button></div>
              </>
            ) : (
              <>
                <div className="bal-fig">{bal?.exists ? tusdc(bal.tusdc, 2) : '0.00'}<small>tUSDC</small></div>
                <dl className="kv">
                  <dt><Icon name="user" size={14} />Account</dt><dd><a className="hash" href={accUrl(guest.account)} target="_blank" rel="noreferrer">{guest.account.slice(0, 10)}…{guest.account.slice(-8)}</a></dd>
                  <dt><Icon name="bolt" size={14} />Gas</dt><dd>{bal ? (bal.exists ? `${fmtNear(bal.near_yocto)} NEAR` : 'not on-chain yet') : <span className="spinner" />}</dd>
                  <dt><Icon name="clock" size={14} />Made</dt><dd>{new Date(guest.created).toLocaleString()}</dd>
                </dl>
                <div className="row wrap" style={{ gap: 6 }}>
                  {bal && (!bal.exists || bal.tusdc === '0') && <button className="btn sm" disabled={funding} onClick={async () => { await fund(guest); refresh(); }}>{funding ? <span className="spinner" /> : <><Icon name="gift" size={13} />Get test tokens</>}</button>}
                  <button className="btn ghost sm" onClick={() => downloadGuest(guest)} title="Save the key file (works with near-cli)"><Icon name="download" size={13} />Save key</button>
                  <button className="btn ghost sm" onClick={() => { if (confirm('Forget this guest key? Its test tokens cannot be recovered without the key file.')) { forgetGuest(); setGuest(null); } }}><Icon name="trash" size={13} />Forget</button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      <div className="stack">
        <div className="panel">
          <Head icon="clock" title="Your runs in this browser" tip="The run token and the one-time key that opens each result stay in this browser, so a run can be reopened after a reload." />
          {runs.length === 0 ? <Empty icon="receipt" action={<button className="btn ghost sm" onClick={() => go({ page: 'recipes' })}><Icon name="market" size={13} />Find a recipe</button>}>No runs yet.</Empty> :
            <table><thead><tr><th>Recipe</th><th>Run</th><th>Payment</th><th className="r">Started</th></tr></thead><tbody>
              {runs.map((r) => (
                <tr key={r.run_id} className="click" onClick={() => go({ page: 'quote', ticker: r.recipe_id, run: r.run_id })}>
                  <td><span className="row" style={{ gap: 8 }}><Seal ticker={r.recipe_id} kind={kind(r.recipe_id)} size={26} /><span className="tk">{r.recipe_id}</span></span></td>
                  <td className="hash small">{r.run_id}</td>
                  <td className="small">{r.pay_tx ? <a href={txUrl(r.pay_tx)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{r.pay_tx.slice(0, 8)}…</a> : <span className="muted">not paid</span>}</td>
                  <td className="r small muted">{new Date(r.created).toLocaleString()}</td>
                </tr>
              ))}
            </tbody></table>}
        </div>
      </div>
    </div>
  );
}
