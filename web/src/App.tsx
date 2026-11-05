import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { ACCOUNTS, usePoll } from './api';
import { Recipes } from './pages/Recipes';
import { Compose } from './pages/Compose';
import { Run } from './pages/Run';
import { Trust } from './pages/Trust';
import { Landscape } from './pages/Landscape';
import { Wallet } from './pages/Wallet';

export type Tab = 'recipes' | 'compose' | 'run' | 'trust' | 'wallet' | 'landscape';
export interface Story { step: number; next: () => void; stop: () => void }
interface Ctx {
  acting: string; setActing: (a: string) => void;
  tab: Tab; go: (t: Tab, ticker?: string) => void;
  ticker: string; setTicker: (t: string) => void;
  story: Story;
  onlyTicker: string; setOnlyTicker: (t: string) => void;
  toast: (msg: string, err?: boolean) => void;
  mode: any;
}
const AppCtx = createContext<Ctx>(null as unknown as Ctx);
export const useApp = () => useContext(AppCtx);

const STEPS = [
  null,
  { title: 'A creator chains parts into “Clean up and protect” and publishes it privately', body: 'Five parts from five authors, type-checked as they snap together. The recipe is sealed in the browser to the attested runner key and backed by a $25 guarantee deposit.' },
  { title: 'A buyer posts a job, recipes compete, and the buyer pays per run through Intents', body: 'One short form, sealed once. Every recipe that does this job quotes from a sealed dry run, at its current market price. SWPR promises more USDC but routes publicly and also sweeps your wNEAR; Bob picks CLNP and pays from Arbitrum.' },
  { title: 'The workflow sweeps dust and swaps privately to a fresh address', body: 'The runner verifies the on-chain commitments, decrypts, quarantines scam airdrops with a signed private-AI verdict, then routes confidential 1Click swaps to a never-used address.' },
  { title: 'The creator and every part author are paid in the same settlement', body: 'One signed report, one receipt: protocol, runner, five part authors and the creator, with 10% of the creator’s cut topping up the recipe’s guarantee deposit. Delivery is checked against the signed promise.' },
];

export function App() {
  const [acting, setActing] = useState('chef.testnet');
  const [tab, setTab] = useState<Tab>('run');
  const [onlyTicker, setOnlyTicker] = useState('');
  const [ticker, setTicker] = useState('SWPR');
  const [step, setStep] = useState(0);
  const [toastMsg, setToast] = useState<{ msg: string; err?: boolean } | null>(null);
  const [mode] = usePoll<any>('/api/mode', 30000);
  const [tickers] = usePoll<any[]>('/api/recipes/summary', 2000);

  const toast = useCallback((msg: string, err?: boolean) => { setToast({ msg, err }); setTimeout(() => setToast(null), 4200); }, []);
  const go = useCallback((t: Tab, tk?: string) => { setTab(t); if (tk) setTicker(tk); setOnlyTicker(t === 'run' && tk ? tk : ''); window.scrollTo({ top: 0 }); }, []);
  const story: Story = {
    step,
    next: () => setStep((s) => (s >= 4 ? 5 : s + 1)),
    stop: () => setStep(0),
  };
  useEffect(() => {
    if (step === 1) { setActing('chef.testnet'); setTab('compose'); }
    if (step === 2) { setActing('bob.testnet'); setOnlyTicker(''); setTab('run'); }
  }, [step]);
  useEffect(() => { const s = new URLSearchParams(location.search); if (s.get('story') === '1') setTimeout(() => setStep(1), 800); }, []);

  const cap = step >= 1 && step <= 4 ? STEPS[step] : null;
  return (
    <AppCtx.Provider value={{ acting, setActing, tab, go, ticker, setTicker, story, onlyTicker, setOnlyTicker, toast, mode }}>
      <div className="top">
        <a className="brand" href="/" onClick={(e) => { e.preventDefault(); go('run'); }}>
          <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden><circle cx="16" cy="16" r="14" fill="#F2C14E" /><circle cx="16" cy="16" r="10" fill="none" stroke="#9A5F00" strokeWidth="1.5" /><path d="M11 16.5l3.5 3.5 7-8" stroke="#15233F" strokeWidth="2.6" fill="none" strokeLinecap="round" /></svg>
          <b>Fungible Recipes</b>
        </a>
        <nav className="nav" aria-label="Sections">
          {([['run', 'Post a job'], ['compose', 'Compose'], ['wallet', 'Wallet'], ['recipes', 'Recipes'], ['trust', 'Trust & privacy'], ['landscape', 'Landscape']] as [Tab, string][]).map(([t, l]) => (
            <button key={t} aria-current={tab === t ? 'page' : undefined} onClick={() => go(t)}>{l}</button>
          ))}
        </nav>
        <div className="spacer" />
        <label className="acting"><span>Acting as</span>
          <select value={acting} onChange={(e) => setActing(e.target.value)} aria-label="Acting as account">
            {ACCOUNTS.map((a) => <option key={a.id} value={a.id}>{a.id} ({a.role})</option>)}
          </select>
        </label>
        <button className="mode" title={mode ? Object.entries(mode.services).map(([k, v]) => `${k}: ${v}`).join('\n') : ''} onClick={() => go('trust')}>Local mode</button>
        <button className="story-btn" disabled={step > 0 && step < 5} onClick={() => setStep(1)}>{step > 0 && step < 5 ? `Story ${step}/4` : 'Play the demo story'}</button>
      </div>
      <div className="tape" aria-label="Recipe activity">
        {(tickers ?? []).map((t) => (
          <button key={t.ticker} onClick={() => go('recipes', t.ticker)}>
            <b>{t.ticker}</b><span>${t.pricePerRun.toFixed(2)} per run</span>{(() => { const h = t.history ?? []; if (h.length < 2) return null; const a = h[h.length - 2].price, b = h[h.length - 1].price; return a === b ? null : <span className={b > a ? 'gain' : 'loss'}>{b > a ? '▲' : '▼'}{Math.abs((b - a) / a * 100).toFixed(1)}%</span>; })()}<span className="muted">{t.runs} {t.runs === 1 ? 'run' : 'runs'}</span>{t.keptPromise != null && <span className={t.keptPromise >= 1 ? 'gain' : 'loss'}>{Math.round(t.keptPromise * 100)}% of promise</span>}<span className="muted">${t.deposit.available.toFixed(0)} deposit</span>
          </button>
        ))}
        {!tickers?.some((t) => t.ticker === 'CLNP') && <span className="muted">CLNP not listed yet — compose it, or play the demo story</span>}
      </div>
      <main>
        {tab === 'recipes' && <Recipes />}
        {tab === 'compose' && <Compose />}
        {tab === 'run' && <Run />}
        {tab === 'wallet' && <Wallet />}
        {tab === 'trust' && <Trust />}
        {tab === 'landscape' && <Landscape />}
      </main>
      {cap && (
        <div className="caption" role="status" aria-live="polite">
          <div className="stepno">{step}</div>
          <div><h3>{cap.title}</h3><p>{cap.body}</p></div>
          <button onClick={() => setStep(0)}>Stop</button>
        </div>
      )}
      {step === 5 && (
        <div className="caption" role="status">
          <div className="stepno">✓</div>
          <div><h3>That was one job, end to end</h3><p>Everything you saw is in the ledger. CLNP’s track record now shows one run that kept its promise; Wallet, Recipes and Trust & privacy show the money, the guarantee deposit and the proofs.</p></div>
          <button onClick={() => { setStep(0); go('recipes', 'CLNP'); }}>Open CLNP</button>
        </div>
      )}
      {toastMsg && <div className={'toast' + (toastMsg.err ? ' err' : '')} role="alert">{toastMsg.msg}</div>}
    </AppCtx.Provider>
  );
}
