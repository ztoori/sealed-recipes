import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { ACCOUNTS, pct, px, usePoll } from './api';
import { Exchange } from './pages/Exchange';
import { Compose } from './pages/Compose';
import { Run } from './pages/Run';
import { Trust } from './pages/Trust';
import { Wallet } from './pages/Wallet';

export type Tab = 'exchange' | 'compose' | 'run' | 'trust' | 'wallet';
export interface Story { step: number; next: () => void; stop: () => void }
interface Ctx {
  acting: string; setActing: (a: string) => void;
  tab: Tab; go: (t: Tab, ticker?: string) => void;
  ticker: string; setTicker: (t: string) => void;
  story: Story;
  toast: (msg: string, err?: boolean) => void;
  mode: any;
}
const AppCtx = createContext<Ctx>(null as unknown as Ctx);
export const useApp = () => useContext(AppCtx);

const STEPS = [
  null,
  { title: 'A creator chains blocks into “Clean up and protect” and publishes it privately', body: 'Five blocks from five authors, type-checked as they snap together. The recipe is sealed in the browser to the attested runner key; the market only ever sees the listing.' },
  { title: 'A buyer pays per run through Intents and fills one short form', body: 'Pay with USDC from Arbitrum; a 1Click EXACT_OUTPUT quote delivers exactly the run price to the contract with the run ticket attached. No chat, four fields.' },
  { title: 'The workflow sweeps dust and swaps privately to a fresh address', body: 'The runner verifies the on-chain commitments, decrypts, quarantines scam airdrops with a signed private-AI verdict, then routes confidential 1Click swaps to a never-used address.' },
  { title: 'The creator and every block author are paid in the same settlement', body: 'One signed report, one receipt: protocol, runner, five block authors, the creator’s royalty and every shareholder’s dividend.' },
];

export function App() {
  const [acting, setActing] = useState('chef.testnet');
  const [tab, setTab] = useState<Tab>('exchange');
  const [ticker, setTicker] = useState('SWPR');
  const [step, setStep] = useState(0);
  const [toastMsg, setToast] = useState<{ msg: string; err?: boolean } | null>(null);
  const [mode] = usePoll<any>('/api/mode', 30000);
  const [tickers] = usePoll<any[]>('/api/tickers', 2000);

  const toast = useCallback((msg: string, err?: boolean) => { setToast({ msg, err }); setTimeout(() => setToast(null), 4200); }, []);
  const go = useCallback((t: Tab, tk?: string) => { setTab(t); if (tk) setTicker(tk); window.scrollTo({ top: 0 }); }, []);
  const story: Story = {
    step,
    next: () => setStep((s) => (s >= 4 ? 5 : s + 1)),
    stop: () => setStep(0),
  };
  useEffect(() => {
    if (step === 1) { setActing('chef.testnet'); setTab('compose'); }
    if (step === 2) { setActing('bob.testnet'); setTicker('CLNP'); setTab('run'); }
  }, [step]);
  useEffect(() => { const s = new URLSearchParams(location.search); if (s.get('story') === '1') setTimeout(() => setStep(1), 800); }, []);

  const cap = step >= 1 && step <= 4 ? STEPS[step] : null;
  return (
    <AppCtx.Provider value={{ acting, setActing, tab, go, ticker, setTicker, story, toast, mode }}>
      <div className="top">
        <a className="brand" href="/" onClick={(e) => { e.preventDefault(); go('exchange'); }}>
          <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden><circle cx="16" cy="16" r="14" fill="#F2C14E" /><circle cx="16" cy="16" r="10" fill="none" stroke="#9A5F00" strokeWidth="1.5" /><path d="M11 16.5l3.5 3.5 7-8" stroke="#15233F" strokeWidth="2.6" fill="none" strokeLinecap="round" /></svg>
          <b>Fungible Recipes</b>
        </a>
        <nav className="nav" aria-label="Sections">
          {([['exchange', 'Exchange'], ['compose', 'Compose'], ['run', 'Run a recipe'], ['wallet', 'Wallet'], ['trust', 'Trust & privacy']] as [Tab, string][]).map(([t, l]) => (
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
      <div className="tape" aria-label="Ticker tape">
        {(tickers ?? []).map((t) => (
          <button key={t.ticker} onClick={() => go('exchange', t.ticker)}>
            <b>{t.ticker}</b><span>{px(t.last)}</span><span className={t.change24h >= 0 ? 'gain' : 'loss'}>{pct(t.change24h)}</span><span className="muted">{t.runs} runs</span>
          </button>
        ))}
        {!tickers?.some((t) => t.ticker === 'CLNP') && <span className="muted">CLNP not listed yet — compose it, or play the demo story</span>}
      </div>
      <main>
        {tab === 'exchange' && <Exchange />}
        {tab === 'compose' && <Compose />}
        {tab === 'run' && <Run />}
        {tab === 'wallet' && <Wallet />}
        {tab === 'trust' && <Trust />}
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
          <div><h3>That was one complete run</h3><p>Everything you saw is in the ledger: open Exchange → CLNP for the settlement, Wallet to claim dividends as chef.testnet, Trust & privacy for the proofs.</p></div>
          <button onClick={() => { setStep(0); go('exchange', 'CLNP'); }}>Open CLNP</button>
        </div>
      )}
      {toastMsg && <div className={'toast' + (toastMsg.err ? ' err' : '')} role="alert">{toastMsg.msg}</div>}
    </AppCtx.Provider>
  );
}
