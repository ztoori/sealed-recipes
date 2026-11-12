/**
 * The live marketplace on NEAR testnet (served by server/src/live.ts). Same look and layout as the guided demo
 * (web/src/App.tsx), with real chain state. Nobody logs in:
 *  - read-only recipes take any public mainnet account, typed in like on a block explorer, sealed in this browser;
 *  - paying uses a guest key made in this browser and funded once by the testnet faucet (test tokens only);
 *  - every step is a real testnet transaction, linked to the explorer.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, short, usePoll } from '../api';
import { Icon } from '../icons';
import { BrandMark } from '../ui';
import { Ctx, DEMO, accUrl, liveHash, parseLive, type Listing, type LiveRoute, type Mode } from './ctx';
import { loadGuest, newGuest, type Guest } from './guest';
import { Landing } from '../pages/Landing';
import { Docs } from '../pages/Docs';
import { Compose } from '../pages/Compose';
import { DemoPages, PracticeBanner } from './DemoPages';
import { Recipes } from './Recipes';
import { Quote } from './Quote';
import { Wallet } from './Wallet';

const MENU: { key: string; label: string; icon: string; route: LiveRoute }[] = [
  { key: 'recipes', label: 'Recipes', icon: 'market', route: { page: 'recipes' } },
  { key: 'compose', label: 'Compose', icon: 'compose', route: { page: 'compose', sub: 'recipe' } },
  { key: 'wallet', label: 'Wallet', icon: 'wallet', route: { page: 'wallet' } },
  { key: 'docs', label: 'Docs', icon: 'docs', route: { page: 'docs', sub: 'spec' } },
];

export function Live() {
  const [mode] = usePoll<Mode>('/api/mode', 60000);
  const [listings] = usePoll<Listing[]>('/api/listings', 30000);
  const [guest, setGuest] = useState<Guest | null>(() => loadGuest());
  const [funding, setFunding] = useState(false);
  const [route, setRoute] = useState<LiveRoute>(() => parseLive(location.hash));
  const [toastMsg, setToast] = useState<{ msg: string; err?: boolean; id: number } | null>(null);

  const toast = useCallback((msg: string, err?: boolean) => {
    const id = Date.now();
    setToast({ msg, err, id });
    setTimeout(() => setToast((t) => (t?.id === id ? null : t)), 5000);
  }, []);
  const go = useCallback((r: LiveRoute) => {
    const h = liveHash(r);
    if (location.hash !== h) history.pushState(null, '', h);
    setRoute(r); window.scrollTo({ top: 0 });
  }, []);
  useEffect(() => { const on = () => setRoute(parseLive(location.hash)); addEventListener('popstate', on); addEventListener('hashchange', on); return () => { removeEventListener('popstate', on); removeEventListener('hashchange', on); }; }, []);

  const fund = useCallback(async (g: Guest) => {
    setFunding(true);
    try { await api('/api/faucet', { account_id: g.account }); toast('Guest account funded with test tokens'); }
    catch (e) { const m = (e as Error).message; toast(m.startsWith('<') ? 'The faucet could not be reached; try again in a minute' : m, true); }
    finally { setFunding(false); }
  }, [toast]);
  const createGuest = useCallback(async () => { const g = newGuest(); setGuest(g); await fund(g); return g; }, [fund]);

  const home = route.page === 'home';
  const current = route.page === 'quote' ? 'recipes' : route.page;
  return (
    <Ctx.Provider value={{ mode, listings, guest, setGuest, createGuest, fund, funding, route, go, toast }}>
      <div className="top">
        <a className="brand" href="#/" onClick={(e) => { e.preventDefault(); go({ page: 'home' }); }} aria-label="Sealed Recipes home">
          <BrandMark />
          <b>Sealed Recipes</b>
        </a>
        {!home && <>
        <nav className="nav" aria-label="Sections">
          {MENU.map((m) => <button key={m.key} aria-label={m.label} aria-current={current === m.key ? 'page' : undefined} onClick={() => go(m.route)}><Icon name={m.icon} size={17} /><span>{m.label}</span></button>)}
        </nav>
        <div className="spacer" />
        <a className="mode on-chain" href={accUrl(mode?.contract_id ?? '')} target="_blank" rel="noreferrer" title={mode ? `${mode.contract_id} on NEAR ${mode.mode}\nrunner ${mode.runner_id}` + (mode.services ? '\n' + Object.entries(mode.services).map(([k, v]) => `${k}: ${v}`).join('\n') : '') : ''}><i className="dot" />Live · {mode?.mode ?? 'testnet'}</a>
        <button className="acting" title={guest ? 'Your guest account' : 'Make a guest account to pay for runs'} onClick={() => go({ page: 'wallet' })}>
          <span className="avatar"><Icon name="user" size={15} /></span>
          <span className="who"><b>{guest ? short(guest.account, 6, 4) : 'Guest'}</b><small>{guest ? 'guest · testnet' : 'no account yet'}</small></span>
          <Icon name="chevron" size={14} className="caret" />
        </button>
        <a className="story-btn" href={`${DEMO}?story=1`} title="The guided demo, with simulated services"><Icon name="play" size={15} fill />Guided demo</a>
        </>}
      </div>
      <main className={home ? 'home' : undefined}>
        {route.page === 'home' && <DemoPages backend=""><Landing /></DemoPages>}
        {route.page === 'docs' && <DemoPages backend=""><Docs sub={route.sub} /></DemoPages>}
        {route.page === 'compose' && <DemoPages backend="/demo" banner={(a, s) => <PracticeBanner acting={a} setActing={s} />}><Compose sub={route.sub} part={route.part} /></DemoPages>}
        {route.page === 'recipes' && <Recipes ticker={route.ticker} />}
        {route.page === 'quote' && <Quote key={route.ticker + (route.run ?? '')} ticker={route.ticker} runId={route.run} />}
        {route.page === 'wallet' && <Wallet />}
      </main>
      {toastMsg && <div key={toastMsg.id} className={'toast' + (toastMsg.err ? ' err' : '')} role="alert"><Icon name={toastMsg.err ? 'alert' : 'check'} size={16} />{toastMsg.msg}</div>}
    </Ctx.Provider>
  );
}
