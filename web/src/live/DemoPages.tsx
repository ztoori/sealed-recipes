/**
 * The guided demo's Landing, Docs and Compose pages, shown inside the live site's own shell, so a visitor never
 * leaves it:
 *  - backend '' (Landing, Docs): the pages read the live server (real recipes, the real runner's attestation,
 *    the sealed recipes this marketplace holds, the parts registered on the contract);
 *  - backend '/demo' (Compose): the practice composer runs against the demo's simulated services, served by this
 *    site under /demo, because publishing on testnet takes the creator's own key. A banner says so.
 * Links inside these pages are mapped to the live site's routes; "Watch the demo" opens the demo film (#/demo).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { ACCOUNTS, ApiBase, api, setCurrency, setLedgerMode, setScopedBase } from '../api';
import { AppCtx, type AppCtxValue } from '../App';
import { routeHash, type Route } from '../route';
import { Icon, ROLE_ICON } from '../icons';
import { DEMO, useLive, type LiveRoute } from './ctx';

const toDemo = (r: LiveRoute): Route => (r.page === 'quote' ? { page: 'quote', ticker: r.ticker } : r.page === 'compose' ? { page: 'compose', sub: r.sub, part: r.part } : r.page === 'docs' ? { page: 'docs', sub: r.sub } : r.page === 'recipes' ? { page: 'recipes', ticker: r.ticker } : r.page === 'wallet' ? { page: 'wallet' } : { page: 'home' });

export function DemoPages({ backend, children, banner }: { backend: '' | '/demo'; children: ReactNode; banner?: (acting: string, setActing: (a: string) => void) => ReactNode }) {
  const live = useLive();
  const [acting, setActing] = useState('chef.testnet');
  const [mode, setMode] = useState<any>();
  const [ready, setReady] = useState<boolean | 'failed'>(backend === '');
  // direct calls made by these pages' components go to their backend (set during render, before their effects run)
  setScopedBase(backend || null);
  setLedgerMode(backend ? 'local' : 'near');
  setCurrency(backend ? 'USDC' : 'tUSDC'); // live data is in tUSDC; the practice composer uses demo USDC
  useEffect(() => () => { setScopedBase(null); setCurrency('USDC'); }, []);

  // the practice composer needs this visitor's demo sandbox: the demo gateway makes one on a page view, then it boots
  useEffect(() => {
    if (!backend) { api('/api/mode', undefined, '').then(setMode).catch(() => {}); return; }
    let alive = true;
    (async () => {
      try { await fetch(`${backend}/`, { headers: { accept: 'text/html' }, credentials: 'same-origin' }); } catch { /* retried below */ }
      for (let i = 0; i < 30 && alive; i++) {
        try { const m = await api('/api/mode', undefined, backend); if (alive) { setMode(m); setReady(true); } return; }
        catch { await new Promise((r) => setTimeout(r, 2000)); }
      }
      if (alive) setReady('failed');
    })();
    return () => { alive = false; };
  }, [backend]);

  const go = (r: Route) => {
    if (r.page === 'compose' || r.page === 'docs' || r.page === 'home') { live.go(r as LiveRoute); return; }
    if (r.page === 'film') { live.go({ page: 'film' }); return; }
    // recipes, quotes and wallets of the practice composer live in the demo; on live data they are the live pages
    if (backend) { location.href = DEMO + routeHash(r); return; }
    live.go(r.page === 'quote' ? { page: 'quote', ticker: r.ticker } : r.page === 'recipes' ? { page: 'recipes', ticker: r.ticker } : { page: 'wallet' });
  };
  const value: AppCtxValue = {
    acting, setActing, route: toDemo(live.route), go, toast: live.toast, mode,
    story: { run: 0, step: 0, start: () => live.go({ page: 'film' }), advance: () => {}, stop: () => {} },
  };
  return (
    <ApiBase.Provider value={backend}>
      <AppCtx.Provider value={value}>
        {banner?.(acting, setActing)}
        {ready === true ? children
          : ready === 'failed' ? <div className="panel body">The practice composer is not available right now. The live recipes are under <button className="linkbtn" onClick={() => live.go({ page: 'recipes' })}>Recipes</button>.</div>
          : <div className="panel body muted row"><span className="spinner" />Starting your practice workspace (simulated services)</div>}
      </AppCtx.Provider>
    </ApiBase.Provider>
  );
}

/** the banner over the practice composer: what it is, and which demo account is acting */
export function PracticeBanner({ acting, setActing }: { acting: string; setActing: (a: string) => void }) {
  const actor = ACCOUNTS.find((a) => a.id === acting);
  return (
    <div className="purpose-line practice">
      <Icon name="compose" size={16} />
      <p><b>Practice composer.</b> Build, seal and publish a recipe or a part on simulated services, with demo accounts and demo money. Nothing here goes on testnet: there, a creator publishes with their own key.</p>
      <label className="acting" title="Switch the demo account you act as">
        <span className="avatar"><Icon name={ROLE_ICON[actor?.role ?? ''] ?? 'user'} size={15} /></span>
        <span className="who"><b>{acting.replace('.testnet', '')}</b><small>{actor?.role} (demo)</small></span>
        <Icon name="chevron" size={14} className="caret" />
        <select value={acting} onChange={(e) => setActing(e.target.value)} aria-label="Demo account you act as">
          {ACCOUNTS.map((a) => <option key={a.id} value={a.id}>{a.id} ({a.role})</option>)}
        </select>
      </label>
    </div>
  );
}
