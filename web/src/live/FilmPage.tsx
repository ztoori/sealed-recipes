/**
 * The guided demo: one film (components/DemoFilm.tsx) that tells the whole story, for people and AI agents, in
 * under three minutes. Prices, names and the payout split come from the live contract when the page has them.
 * Under the player: who the market is for, and what is live today next to what is still to come, so the film's
 * short lines never stand alone.
 *
 * For recording (scripts/record-film.mjs): /?record=1#/demo shows the picture only, filling the window, and
 * /?cut=x#/demo plays the shorter cut made for an X post.
 */
import { useMemo } from 'react';
import { DemoFilm, FALLBACK, type FilmData } from '../components/DemoFilm';
import { Icon } from '../icons';
import { useLive, type Listing, type LiveRoute } from './ctx';

const ORDER = ['CHECK', 'SAFE3', 'AUDIT3'];

function filmData(listings?: Listing[]): FilmData {
  if (!listings?.length) return FALLBACK;
  const live = [...listings].sort((a, b) => (ORDER.indexOf(a.ticker) + 1 || 99) - (ORDER.indexOf(b.ticker) + 1 || 99)).slice(0, 3);
  if (live.length < 3) return FALLBACK;
  const recipes = live.map((l) => ({
    ticker: l.ticker, name: l.name, price: Number(l.onchain?.price_per_run ?? l.price_per_run) / 1e6,
    runs: Number(l.onchain?.runs ?? 0), risk: l.risk, kind: l.output_type,
  }));
  const pr = live[0].record?.perRun as { price: number; protocol: number; runner: number; parts: { amount: number }[]; creator: number; reserve: number } | undefined;
  const split = pr ? { price: pr.price, parts: pr.parts.reduce((a, b) => a + b.amount, 0), runner: pr.runner, protocol: pr.protocol, creator: pr.creator, reserve: pr.reserve } : { ...FALLBACK.split, price: recipes[0].price };
  return { recipes, split };
}

const SEATS: { who: string; icon: string; line: string; go: () => LiveRoute; cta: string }[] = [
  { who: 'Users', icon: 'user', line: 'Pick a recipe, pay per run. A failed run is refunded.', go: () => ({ page: 'recipes' }), cta: 'Find a recipe' },
  { who: 'Creators', icon: 'compose', line: 'Compose recipes from parts, no code. Paid on every run.', go: () => ({ page: 'compose', sub: 'recipe' }), cta: 'Try the composer' },
  { who: 'Builders', icon: 'code', line: 'Write parts to the open spec, SRS-1. A fee each time one is used.', go: () => ({ page: 'compose', sub: 'part' }), cta: 'Build a part' },
  { who: 'Runners', icon: 'cpu', line: 'Run recipes inside sealed hardware. A fee on every run.', go: () => ({ page: 'docs', sub: 'runner' }), cta: 'How the runner works' },
];
/** what a careful viewer would ask after the film, answered plainly (README: Status, and Limitations) */
const TODAY: [string, string][] = [
  ['Live now', 'Three recipes on NEAR testnet, paid in a test token. One runner, in an Intel TDX machine, checked by your own browser before anything is sent.'],
  ['In the practice composer', 'Composing and publishing without code runs on simulated services. On testnet a creator publishes with their own key, from the command line.'],
  ['Not yet', 'Mainnet, a wallet connection, more than one runner, and a build anyone can reproduce from source. “Nobody can open it” holds as far as the hardware does.'],
];

export function FilmPage() {
  const { listings, go } = useLive();
  const data = useMemo(() => filmData(listings), [listings]);
  const q = useMemo(() => new URLSearchParams(location.search), []);
  const cut = q.get('cut') === 'x' ? 'x' : 'full';
  if (q.has('record')) return <div className="df-record"><DemoFilm bare cut={cut} data={FALLBACK} onTry={() => {}} onBrowse={() => {}} onSpec={() => {}} /></div>;
  return (
    <div className="df-page-wrap">
      <div className="df-page-head">
        <div><h1>The guided demo</h1><p>Why this market exists and how one run plays out, for people and for AI agents, in under three minutes.</p></div>
        <span className="spacer" />
        <button className="btn ghost sm" onClick={() => go({ page: 'recipes' })}>Skip to the recipes<Icon name="arrow" size={13} /></button>
      </div>
      <DemoFilm cut={cut} data={data} onTry={(t) => go({ page: 'quote', ticker: t })} onBrowse={() => go({ page: 'recipes' })} onSpec={() => go({ page: 'docs', sub: 'spec' })} />
      <div className="df-seats-row" aria-label="Who the market is for">
        {SEATS.map((s) => (
          <button key={s.who} className="df-seat-link" onClick={() => go(s.go())}>
            <span className="ic"><Icon name={s.icon} size={17} /></span>
            <b>{s.who}</b><span>{s.line}</span><em>{s.cta}<Icon name="arrow" size={12} /></em>
          </button>
        ))}
      </div>
      <dl className="df-today" aria-label="What is live today">
        {TODAY.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        <div><dt>The fine print</dt><dd>We read ours, and wrote it down: <button className="linkbtn" onClick={() => go({ page: 'docs', sub: 'trust' })}>Trust &amp; privacy</button> shows every check, and the README lists every limit.</dd></div>
      </dl>
    </div>
  );
}
