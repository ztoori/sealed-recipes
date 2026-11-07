import { createContext, useCallback, useContext, useEffect, useReducer, useRef, useState } from 'react';
import { ACCOUNTS, usePoll } from './api';
import { parseRoute, routeHash, section, type Route } from './route';
import { Recipes } from './pages/Recipes';
import { Quote } from './pages/Quote';
import { Compose } from './pages/Compose';
import { Wallet } from './pages/Wallet';
import { Docs } from './pages/Docs';

import { storyReducer, type StoryStep } from './story-machine';
export type { StoryStep } from './story-machine';

export interface Story { run: number; step: StoryStep; advance: (from: StoryStep) => void; stop: () => void }

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
  1: { title: 'A creator composes “Clean up and protect” from five parts and publishes it sealed', body: 'Pick the job, add parts: each one wires itself to the previous step, type-checked. The recipe is sealed in the browser to the attested runner key and backed by a $25 guarantee deposit.' },
  2: { title: 'A buyer finds it on Recipes and asks it for a quote', body: 'Bob searches “clean” and opens CLNP; SWPR does the same job cheaper, but routes publicly. One short form, sealed once: CLNP quotes from a sealed dry run, signs a promise, and Bob pays from Arbitrum through NEAR Intents.' },
  3: { title: 'The workflow sweeps dust and swaps privately to a fresh address', body: 'The runner verifies the on-chain commitments, decrypts, quarantines scam airdrops with a signed private-AI verdict, then routes confidential 1Click swaps to a never-used address.' },
  4: { title: 'The creator and every part author are paid in the same settlement', body: 'One signed report, one receipt: protocol, runner, five part authors and the creator, with 10% of the creator’s cut topping up the recipe’s guarantee deposit. Delivery is checked against the signed promise.' },
};

const MENU: [ReturnType<typeof section>, string, Route][] = [
  ['recipes', 'Recipes', { page: 'recipes' }],
  ['compose', 'Compose', { page: 'compose', sub: 'recipe' }],
  ['wallet', 'Wallet', { page: 'wallet' }],
  ['docs', 'Documentation', { page: 'docs', sub: 'standard' }],
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

  const storyApi: Story = { ...story, advance: (from) => dispatch({ type: 'advance', from }), stop: () => dispatch({ type: 'stop' }) };
  // entering a step sets the scene; the pages run the step itself
  useEffect(() => {
    if (story.step === 1) { setActing('chef.testnet'); go({ page: 'compose', sub: 'recipe' }); }
    if (story.step === 2) { setActing('bob.testnet'); go({ page: 'recipes' }); }
  }, [story.step, story.run]);
  useEffect(() => { if (new URLSearchParams(location.search).get('story') === '1') setTimeout(() => dispatch({ type: 'start' }), 800); }, []);

  const playing = story.step >= 1 && story.step <= 4;
  const cap = playing ? STEPS[story.step] : null;
  const current = section(route);
  return (
    <AppCtx.Provider value={{ acting, setActing, route, go, story: storyApi, toast, mode }}>
      <div className="top">
        <a className="brand" href="#/recipes" onClick={(e) => { e.preventDefault(); go({ page: 'recipes' }); }} aria-label="Sealed Recipes home">
          <BrandMark />
          <b>Sealed Recipes</b>
        </a>
        <nav className="nav" aria-label="Sections">
          {MENU.map(([s, label, r]) => <button key={s} aria-current={current === s ? 'page' : undefined} onClick={() => go(r)}>{label}</button>)}
        </nav>
        <div className="spacer" />
        <label className="acting"><span>Acting as</span>
          <select value={acting} onChange={(e) => setActing(e.target.value)} aria-label="Acting as account" disabled={playing}>
            {ACCOUNTS.map((a) => <option key={a.id} value={a.id}>{a.id} ({a.role})</option>)}
          </select>
        </label>
        <button className="mode" title={mode ? 'Offline demo. ' + Object.entries(mode.services).map(([k, v]) => `${k}: ${v}`).join('\n') : ''} onClick={() => go({ page: 'docs', sub: 'trust' })}>Local mode</button>
        <button className="story-btn" disabled={playing} onClick={() => dispatch({ type: 'start' })}>{playing ? `Story ${story.step}/4` : 'Play the demo story'}</button>
      </div>
      <main>
        {route.page === 'recipes' && <Recipes ticker={route.ticker} />}
        {route.page === 'quote' && <Quote key={route.ticker} ticker={route.ticker} />}
        {route.page === 'compose' && <Compose sub={route.sub} part={route.part} />}
        {route.page === 'wallet' && <Wallet />}
        {route.page === 'docs' && <Docs sub={route.sub} />}
      </main>
      {cap && (
        <div className="caption" role="status" aria-live="polite">
          <div className="stepno">{story.step}</div>
          <div><h3>{cap.title}</h3><p>{cap.body}</p></div>
          <button onClick={() => dispatch({ type: 'stop' })}>Stop</button>
        </div>
      )}
      {story.step === 5 && (
        <div className="caption" role="status">
          <div className="stepno">✓</div>
          <div><h3>That was one job, end to end</h3><p>Everything you saw is in the ledger. CLNP’s track record now shows one run that kept its promise; Wallet shows every party’s income, and Documentation › Trust & privacy shows the proofs.</p></div>
          <button onClick={() => { dispatch({ type: 'stop' }); go({ page: 'recipes', ticker: 'CLNP' }); }}>Open CLNP</button>
        </div>
      )}
      {toastMsg && <div className={'toast' + (toastMsg.err ? ' err' : '')} role="alert">{toastMsg.msg}</div>}
    </AppCtx.Provider>
  );
}

/** A recipe card closed with a wax seal: the product in one picture. */
export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect x="4" y="2.5" width="19" height="25" rx="2.5" fill="#fff" />
      <path d="M8 8h11M8 12h11M8 16h7" stroke="#15233F" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M23.5 15.2l1.7 1.3 2.1-.3.6 2 1.9 1-.5 2.1 1 1.9-1.7 1.3-.1 2.1-2.1.3-1.2 1.8-2-.7-2 .7-1.2-1.8-2.1-.3-.1-2.1-1.7-1.3 1-1.9-.5-2.1 1.9-1 .6-2 2.1.3z" fill="#F2C14E" stroke="#9A5F00" strokeWidth=".9" strokeLinejoin="round" />
      <circle cx="23.5" cy="22.6" r="3.6" fill="none" stroke="#9A5F00" strokeWidth="1" />
      <path d="M21.9 22.7l1.1 1.1 2.2-2.4" stroke="#5A3700" strokeWidth="1.3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
