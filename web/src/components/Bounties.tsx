import { useState } from 'react';
import { api, usePoll } from '../api';
import { useApp } from '../App';

type Check = { name: string; ok: boolean; detail: string };
type Bid = { bid_id: string; handle: string; near_account_id?: string; amount: string; eta_seconds: number; proposal: string };
type Tx = { type: string; to: string; amount: string; token: string; tx: string };
type Bounty = { id: string; job_type: string; job_name: string; budget: string; token: string; market_url: string; status: string; bids: Bid[]; awarded?: Bid; checks?: Check[]; recipe_id?: string; transactions: Tx[]; log: { at: number; msg: string }[] };
type Res = { mode: 'mock' | 'live'; market: string; ready: boolean; bounties: Bounty[] };

const STATUS: Record<string, [string, string]> = {
  open: ['', 'open for bids'], in_progress: ['warn', 'building'], submitted: ['warn', 'delivered'], verifying: ['warn', 'verifying'],
  accepted: ['ok', 'accepted, paid'], rejected: ['bad', 'rejected, disputed'], disputed: ['bad', 'disputed'],
};

/**
 * Builder bounties on NEAR AI Agent Market for job types nobody serves yet. With `jobType`, offers to post one for that
 * job type and shows only its bounties; without, lists them all.
 */
export function Bounties({ jobType, served: hasRecipe }: { jobType?: string; served?: boolean }) {
  const { toast } = useApp();
  const [res, refresh] = usePoll<Res>('/api/bounties', 1500);
  const [budget, setBudget] = useState('250');
  const [busy, setBusy] = useState(false);
  if (!res) return null;
  const list = res.bounties.filter((b) => !jobType || b.job_type === jobType);
  const live = list.find((b) => !['accepted', 'rejected', 'disputed', 'cancelled', 'closed'].includes(b.status));
  const served = !!jobType && list.some((b) => b.status === 'accepted');

  const post = async () => {
    setBusy(true);
    try { await api('/api/bounties', { job_type: jobType, budget, by: 'marketplace' }); toast('Bounty posted on NEAR AI Agent Market'); refresh(); }
    catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const award = async (b: Bounty, x: Bid) => {
    try { await api(`/api/bounties/${b.id}/award`, { bid_id: x.bid_id }); toast(`Awarded to @${x.handle}; Agent Market holds ${x.amount} ${b.token} in escrow`); refresh(); }
    catch (e) { toast((e as Error).message, true); }
  };

  if (!list.length && (!jobType || hasRecipe)) return null;
  return (
    <div className="panel" id="bounties">
      <header><h2>Builder bounties</h2>
        <span className="small muted">on NEAR AI Agent Market {res.mode === 'mock' && <span className="pill warn" title={`This demo talks to ${res.market}, built to the published API at market.near.ai/skill.md. Set AGENT_MARKET_URL and AGENT_MARKET_API_KEY to use the real market.`}>offline mock</span>}</span>
      </header>
      <div className="body grid" style={{ gap: 12 }}>
        {jobType && !live && !served && !hasRecipe && (
          <div className="small">
            Pay an agent to build the recipe this job needs. The bounty goes to Agent Market with this job type's spec; builders bid there, and the
            delivery (a sealed recipe published here, never the recipe itself) is checked automatically before the escrow is released.
            <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'end' }}>
              <div className="field"><label htmlFor="bounty-budget">Budget (USDC)</label><input id="bounty-budget" className="num" value={budget} onChange={(e) => setBudget(e.target.value)} style={{ width: 100 }} /></div>
              <button id="post-bounty" className="btn" disabled={busy || !res.ready} onClick={post}>Post a bounty on Agent Market</button>
            </div>
          </div>
        )}
        {served && <div className="small"><span className="pill ok">served</span> A builder delivered a recipe for this job: seal the job again to get its quote.</div>}
        {list.map((b) => {
          const [cls, label] = STATUS[b.status] ?? ['', b.status];
          return (
            <div key={b.id} className="bounty" style={{ borderTop: '1px solid var(--rule)', paddingTop: 8 }}>
              <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
                <b>{b.job_name}</b><span className={`pill ${cls}`}>{label}</span><span className="spacer" />
                <span className="num small">{b.budget} {b.token}</span>
                <span className="small muted hash" title={b.market_url}>job {b.id.slice(0, 8)}</span>
              </div>
              {b.status === 'open' && (b.bids.length ? (
                <table className="quotes small" style={{ marginTop: 6 }}>
                  <thead><tr><th>Builder</th><th className="r">Bid</th><th>Proposal</th><th /></tr></thead>
                  <tbody>{[...b.bids].sort((x, y) => Number(x.amount) - Number(y.amount)).map((x) => (
                    <tr key={x.bid_id}><td>@{x.handle}<div className="muted hash">{x.near_account_id}</div></td><td className="r num">{x.amount}</td><td style={{ maxWidth: 360 }}>{x.proposal}</td>
                      <td><button className="btn sm award-btn" data-handle={x.handle} onClick={() => award(b, x)}>Award</button></td></tr>
                  ))}</tbody>
                </table>) : <div className="small muted">Waiting for bids…</div>)}
              {b.awarded && <div className="small" style={{ marginTop: 4 }}>Awarded to <b>@{b.awarded.handle}</b> ({b.awarded.near_account_id}) for {b.awarded.amount} {b.token}</div>}
              {b.checks && (
                <div style={{ marginTop: 6 }}>
                  <div className="small muted">Delivery checks{b.recipe_id ? ` for ${b.recipe_id}` : ''}: Sealed Recipes accepts only if all pass</div>
                  {b.checks.map((c) => <div key={c.name} className={`check ${c.ok ? 'pass' : 'fail'}`}><span className="i">{c.ok ? '✓' : '✗'}</span><span>{c.name}</span><span className="d">{c.detail}</span></div>)}
                </div>
              )}
              {b.transactions.length > 0 && (
                <div className="small" style={{ marginTop: 6 }}>
                  <div className="muted">Agent Market transactions</div>
                  {b.transactions.map((t, i) => <div key={i} className="num">{t.type}: {Number(t.amount).toFixed(2)} {t.token} → <span className="hash">{t.to}</span></div>)}
                </div>
              )}
              <details className="small" style={{ marginTop: 4 }}><summary>log</summary>{b.log.map((l, i) => <div key={i}><span className="muted">{new Date(l.at).toLocaleTimeString()}</span> {l.msg}</div>)}</details>
              {b.status === 'accepted' && b.recipe_id && <div className="small gain" style={{ marginTop: 4 }}>{b.recipe_id} is listed. Buyers asking for this job now get a quote from it, and any other recipe can compete.</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
