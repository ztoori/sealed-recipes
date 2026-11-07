import { createContext, useCallback, useContext, useEffect, useReducer, useRef, useState } from 'react';
import { ACCOUNTS, usePoll } from './api';
import { parseRoute, routeHash, section, type Route } from './route';
import { Recipes } from './pages/Recipes';
import { Quote } from './pages/Quote';
import { Compose } from './pages/Compose';
import { Wallet } from './pages/Wallet';
import { Docs } from './pages/Docs';
import { Landing } from './pages/Landing';
import { Icon, ROLE_ICON } from './icons';

import { storyReducer, type StoryStep } from './story-machine';
export type { StoryStep } from './story-machine';

export interface Story { run: number; step: StoryStep; start: () => void; advance: (from: StoryStep) => void; stop: () => void }

interface Ctx {
  acting: string; setActing: (a: string) => void;
  route: Route; go: (r: Route) => void;
  story: Story;
  toast: (msg: string, err?: boolean) => void;
  mode: any;
}
const AppCtx = createContext<Ctx>(null as unknown as Ctx);
export const useApp = () => useContext(AppCtx);

/** true exactly once per story run for a given key: lets a page run its part of the story once, and again on replay */
export function useStoryOnce() {
  const { story } = useApp();
  const done = useRef(new Set<string>());
  return (key: string) => { const k = `${story.run}:${key}`; if (done.current.has(k)) return false; done.current.add(k); return true; };
}

const STEPS: Record<number, { title: string; body: string }> = {
  1: { title: 'A creator composes and seals “Clean up and protect”', body: 'Five parts snap together, type-checked. The recipe is encrypted in the browser to the attested runner and backed by a $25 guarantee.' },
  2: { title: 'A buyer finds it and gets a signed quote', body: 'Bob opens CLNP, seals his job once, gets a promise from a private dry run, and pays from Arbitrum via NEAR Intents.' },
  3: { title: 'The sealed workflow runs', body: 'Scam airdrops quarantined by private AI, dust swapped confidentially to a fresh address. Only Bob’s wallet signs.' },
  4: { title: 'Everyone is paid in one receipt', body: 'Protocol, runner, five part authors and the creator settle together; delivery is checked against the promise.' },
};

const MENU: [ReturnType<typeof section>, string, string, Route][] = [
  ['recipes', 'Recipes', 'market', { page: 'recipes' }],
  ['compose', 'Compose', 'compose', { page: 'compose', sub: 'recipe' }],
  ['wallet', 'Wallet', 'wallet', { page: 'wallet' }],
  ['docs', 'Documentation', 'docs', { page: 'docs', sub: 'standard' }],
];

export function App() {
  const [acting, setActing] = useState('bob.testnet');
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  const [story, dispatch] = useReducer(storyReducer, { run: 0, step: 0 });
  const [toastMsg, setToast] = useState<{ msg: string; err?: boolean; id: number } | null>(null);
  const [mode] = usePoll<any>('/api/mode', 30000);

  const toast = useCallback((msg: string, err?: boolean) => {
    const id = Date.now();
    setToast({ msg, err, id });
    setTimeout(() => setToast((t) => (t?.id === id ? null : t)), 4200); // a later toast is not cleared by an earlier timer
  }, []);
  const go = useCallback((r: Route) => {
    const h = routeHash(r);
    if (location.hash !== h) history.pushState(null, '', h);
    setRoute(r); window.scrollTo({ top: 0 });
  }, []);
  useEffect(() => { const on = () => setRoute(parseRoute(location.hash)); addEventListener('popstate', on); addEventListener('hashchange', on); return () => { removeEventListener('popstate', on); removeEventListener('hashchange', on); }; }, []);

  const storyApi: Story = { ...story, start: () => dispatch({ type: 'start' }), advance: (from) => dispatch({ type: 'advance', from }), stop: () => dispatch({ type: 'stop' }) };
  // entering a step sets the scene; the pages run the step itself
  useEffect(() => {
    if (story.step === 1) { setActing('chef.testnet'); go({ page: 'compose', sub: 'recipe' }); }
    if (story.step === 2) { setActing('bob.testnet'); go({ page: 'recipes' }); }
  }, [story.step, story.run]);
  useEffect(() => { if (new URLSearchParams(location.search).get('story') === '1') setTimeout(() => dispatch({ type: 'start' }), 800); }, []);

  const playing = story.step >= 1 && story.step <= 4;
  const cap = playing ? STEPS[story.step] : null;
  const current = section(route);
  const actor = ACCOUNTS.find((a) => a.id === acting);
  return (
    <AppCtx.Provider value={{ acting, setActing, route, go, story: storyApi, toast, mode }}>
      <div className="top">
        <a className="brand" href="#/" onClick={(e) => { e.preventDefault(); go({ page: 'home' }); }} aria-label="Sealed Recipes home">
          <BrandMark />
          <b>Sealed Recipes</b>
        </a>
        <nav className="nav" aria-label="Sections">
          {MENU.map(([s, label, icon, r]) => <button key={s} aria-label={label} aria-current={current === s ? 'page' : undefined} onClick={() => go(r)}><Icon name={icon} size={17} /><span>{label === 'Documentation' ? 'Docs' : label}</span></button>)}
        </nav>
        <div className="spacer" />
        <button className="mode" title={mode ? 'Offline demo\n' + Object.entries(mode.services).map(([k, v]) => `${k}: ${v}`).join('\n') : ''} onClick={() => go({ page: 'docs', sub: 'trust' })}><i className="dot" />Local</button>
        <label className="acting" title="Switch who you are acting as">
          <span className="avatar"><Icon name={ROLE_ICON[actor?.role ?? ''] ?? 'user'} size={15} /></span>
          <span className="who"><b>{acting.replace('.testnet', '')}</b><small>{actor?.role}</small></span>
          <Icon name="chevron" size={14} className="caret" />
          <select value={acting} onChange={(e) => setActing(e.target.value)} aria-label="Acting as account" disabled={playing}>
            {ACCOUNTS.map((a) => <option key={a.id} value={a.id}>{a.id} ({a.role})</option>)}
          </select>
        </label>
        <button className="story-btn" aria-label={playing ? `Story step ${story.step} of 4` : 'Play the demo story'} disabled={playing} onClick={() => dispatch({ type: 'start' })}>
          <Icon name="play" size={15} fill />{playing ? `Step ${story.step}/4` : 'Play demo'}
        </button>
      </div>
      <main className={route.page === 'home' ? 'home' : undefined}>
        {route.page === 'home' && <Landing />}
        {route.page === 'recipes' && <Recipes ticker={route.ticker} />}
        {route.page === 'quote' && <Quote key={route.ticker} ticker={route.ticker} />}
        {route.page === 'compose' && <Compose sub={route.sub} part={route.part} />}
        {route.page === 'wallet' && <Wallet />}
        {route.page === 'docs' && <Docs sub={route.sub} />}
      </main>
      {cap && (
        <div className="caption" role="status" aria-live="polite">
          <div className="cap-steps" aria-hidden>{[1, 2, 3, 4].map((n) => <i key={n} className={n < story.step ? 'done' : n === story.step ? 'now' : ''} />)}</div>
          <div className="stepno">{story.step}</div>
          <div><h3>{cap.title}</h3><p>{cap.body}</p></div>
          <button onClick={() => dispatch({ type: 'stop' })} aria-label="Stop the story"><Icon name="stop" size={14} fill />Stop</button>
        </div>
      )}
      {story.step === 5 && (
        <div className="caption done" role="status">
          <div className="cap-steps" aria-hidden>{[1, 2, 3, 4].map((n) => <i key={n} className="done" />)}</div>
          <div className="stepno"><Icon name="check" size={22} /></div>
          <div><h3>That was one job, end to end</h3><p>Every step is in the ledger: CLNP’s track record, everyone’s income in Wallet, the proofs in Docs.</p></div>
          <button onClick={() => { dispatch({ type: 'stop' }); go({ page: 'recipes', ticker: 'CLNP' }); }}>Open CLNP</button>
        </div>
      )}
      {toastMsg && <div key={toastMsg.id} className={'toast' + (toastMsg.err ? ' err' : '')} role="alert"><Icon name={toastMsg.err ? 'alert' : 'check'} size={16} />{toastMsg.msg}</div>}
    </AppCtx.Provider>
  );
}

/** A recipe card closed with a wax seal: the product in one picture. */
export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="brandmark">
      <defs><radialGradient id="bm-wax" cx="35%" cy="30%" r="80%"><stop offset="0" stopColor="#FFE3A3" /><stop offset=".5" stopColor="#F0B44C" /><stop offset="1" stopColor="#8A5A0E" /></radialGradient></defs>
      <rect x="3" y="2.5" width="18" height="24" rx="3" fill="#E9EDF6" opacity=".14" stroke="#E9EDF6" strokeOpacity=".5" />
      <path d="M7 8h10M7 12h10M7 16h6" stroke="#E9EDF6" strokeOpacity=".7" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M23 14.6l1.8 1.3 2.2-.3.7 2.1 2 1-.5 2.2 1 2-1.8 1.3-.1 2.2-2.2.3-1.2 1.9-2.1-.7-2.1.7-1.2-1.9-2.2-.3-.1-2.2-1.8-1.3 1-2-.5-2.2 2-1 .7-2.1 2.2.3z" fill="url(#bm-wax)" />
      <path d="M21.2 22.4l1.3 1.3 2.6-2.8" stroke="#4A3000" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
