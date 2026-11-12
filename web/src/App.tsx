import { createContext, useCallback, useContext, useEffect, useReducer, useRef, useState } from 'react';
import { ACCOUNTS, BASE, setLedgerMode, usePoll } from './api';
import { parseRoute, routeHash, section, type Route } from './route';
import { Recipes } from './pages/Recipes';
import { Quote } from './pages/Quote';
import { Compose } from './pages/Compose';
import { Wallet } from './pages/Wallet';
import { Docs } from './pages/Docs';
import { Landing } from './pages/Landing';
import { Icon, ROLE_ICON } from './icons';
import { BrandMark } from './ui';

import { SpeedControl } from './components/SpeedControl';
import { demoMs } from './pace';
import { storyReducer, STORY_LAST, type StoryStep } from './story-machine';
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

/** the demo, in seven chapters: the loop itself (1–4), then why it holds together (5–7) */
const STEPS: Record<number, { kicker: string; icon: string; title: string; body: string }> = {
  1: { kicker: 'Compose', icon: 'compose', title: 'Build it, with no code', body: 'A creator snaps five parts together and the types do the wiring. Her prompt and thresholds stay sealed. The recipe is encrypted in her browser and backed by a $25 guarantee.' },
  2: { kicker: 'Quote', icon: 'receipt', title: 'Ask before you pay', body: 'Bob opens Clean up and protect, seals his answers once and gets a signed quote from a private dry run. He pays from Arbitrum through NEAR Intents.' },
  3: { kicker: 'Run', icon: 'cpu', title: 'It runs where nobody can look', body: 'Inside sealed hardware, a private AI quarantines the scam airdrops and the dust is swapped confidentially to a fresh address. The runner asks; only Bob’s wallet signs.' },
  4: { kicker: 'Settle', icon: 'pie', title: 'Everyone paid in one receipt', body: 'The protocol, the runner, five part builders and the creator settle together, and what arrived is checked against what was promised.' },
  5: { kicker: 'Price', icon: 'trend', title: 'Prices that listen', body: 'There is no price list. Each recipe’s price follows its own demand inside its creator’s band, and a quote locks the price you saw.' },
  6: { kicker: 'Proof', icon: 'shieldCheck', title: 'Proof, not promises', body: 'The marketplace holds ciphertext it can’t open, the chain holds hashes, and your browser checks the runner’s hardware attestation itself.' },
  7: { kicker: 'Your turn', icon: 'sparkles', title: 'One open format, three ways in', body: 'Run a recipe. Compose one with no code. Build a part and get paid every time it’s used. SRS-1 makes them all fit.' },
};

const MENU: [ReturnType<typeof section>, string, string, Route][] = [
  ['recipes', 'Recipes', 'market', { page: 'recipes' }],
  ['compose', 'Compose', 'compose', { page: 'compose', sub: 'recipe' }],
  ['wallet', 'Wallet', 'wallet', { page: 'wallet' }],
  ['docs', 'Documentation', 'docs', { page: 'docs', sub: 'spec' }],
];

export function App() {
  const [acting, setActing] = useState('bob.testnet');
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  const [story, dispatch] = useReducer(storyReducer, { run: 0, step: 0 });
  const [toastMsg, setToast] = useState<{ msg: string; err?: boolean; id: number } | null>(null);
  const [mode] = usePoll<any>('/api/mode', 30000);
  setLedgerMode(mode?.mode);

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
    if (story.step === 5) go({ page: 'docs', sub: 'pricing' });
    if (story.step === 6) go({ page: 'docs', sub: 'trust' });
    if (story.step === 7) go({ page: 'docs', sub: 'spec' });
    // chapters 5–7 are tours of a page: the page animates itself, the clock here moves on
    const hold: Record<number, number> = { 5: 15000, 6: 13000, 7: 11000 };
    if (hold[story.step]) { const from = story.step; const t = setTimeout(() => dispatch({ type: 'advance', from }), demoMs(hold[from])); return () => clearTimeout(t); }
  }, [story.step, story.run]);
  useEffect(() => { if (new URLSearchParams(location.search).get('story') === '1') setTimeout(() => dispatch({ type: 'start' }), 800); }, []);

  const playing = story.step >= 1 && story.step <= STORY_LAST;
  const home = route.page === 'home';
  const chapters = Array.from({ length: STORY_LAST }, (_, i) => i + 1);
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
        {!home && <>
        <nav className="nav" aria-label="Sections">
          {MENU.map(([s, label, icon, r]) => <button key={s} aria-label={label} aria-current={current === s ? 'page' : undefined} onClick={() => go(r)}><Icon name={icon} size={17} /><span>{label === 'Documentation' ? 'Docs' : label}</span></button>)}
        </nav>
        <div className="spacer" />
        {BASE === '/demo' && <a className="mode on-chain" href="/" title="Back to the live marketplace on NEAR testnet"><i className="dot" />Live site</a>}
        <button className="mode" title={mode ? 'Offline demo\n' + Object.entries(mode.services).map(([k, v]) => `${k}: ${v}`).join('\n') : ''} onClick={() => go({ page: 'docs', sub: 'trust' })}><i className="dot" />Local</button>
        <label className="acting" title="Switch who you are acting as">
          <span className="avatar"><Icon name={ROLE_ICON[actor?.role ?? ''] ?? 'user'} size={15} /></span>
          <span className="who"><b>{acting.replace('.testnet', '')}</b><small>{actor?.role}</small></span>
          <Icon name="chevron" size={14} className="caret" />
          <select value={acting} onChange={(e) => setActing(e.target.value)} aria-label="Acting as account" disabled={playing}>
            {ACCOUNTS.map((a) => <option key={a.id} value={a.id}>{a.id} ({a.role})</option>)}
          </select>
        </label>
        <button className="story-btn" aria-label={playing ? `Story chapter ${story.step} of ${STORY_LAST}` : 'Play the demo story'} disabled={playing} onClick={() => dispatch({ type: 'start' })}>
          <Icon name="play" size={15} fill />{playing ? `Chapter ${story.step}/${STORY_LAST}` : 'Play demo'}
        </button>
        </>}
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
          <div className="cap-steps" aria-hidden>{chapters.map((n) => <i key={n} className={n < story.step ? 'done' : n === story.step ? 'now' : ''} />)}</div>
          <div className="stepno">{story.step}</div>
          <div><div className="cap-kicker"><Icon name={cap.icon} size={12} />Chapter {story.step} of {STORY_LAST} · {cap.kicker}</div><h3>{cap.title}</h3><p>{cap.body}</p></div>
          <div className="cap-actions"><SpeedControl kind="demo" /><button onClick={() => dispatch({ type: 'stop' })} aria-label="Stop the story"><Icon name="stop" size={14} fill />Stop</button></div>
        </div>
      )}
      {story.step === STORY_LAST + 1 && (
        <div className="caption done" role="status">
          <div className="cap-steps" aria-hidden>{chapters.map((n) => <i key={n} className="done" />)}</div>
          <div className="stepno"><Icon name="check" size={22} /></div>
          <div><h3>That was the whole loop</h3><p>Every step is on the record: CLNP’s track record, everyone’s income in Wallet, the proofs in Docs. Where to next?</p></div>
          <div className="cap-actions">
            <button onClick={() => { dispatch({ type: 'stop' }); go({ page: 'recipes', ticker: 'CLNP' }); }}>Run a recipe</button>
            <button className="ghost" onClick={() => { dispatch({ type: 'stop' }); go({ page: 'docs', sub: 'compose-recipe' }); }}>Compose one</button>
          </div>
        </div>
      )}
      {toastMsg && <div key={toastMsg.id} className={'toast' + (toastMsg.err ? ' err' : '')} role="alert"><Icon name={toastMsg.err ? 'alert' : 'check'} size={16} />{toastMsg.msg}</div>}
    </AppCtx.Provider>
  );
}

export { BrandMark };
