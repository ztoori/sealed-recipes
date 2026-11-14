/**
 * The guided demo page, shared by the live site (live/FilmPage.tsx) and the local demo (pages/Film.tsx): the film
 * (DemoFilm.tsx, with its narration, score, captions and speed control), then who the market is for, and what is real
 * where you are watching, so the film's short lines never stand alone. Each shell passes its own links and its own
 * "what is real here" notes; the film itself is the same everywhere.
 *
 * For recording (scripts/record-film.mjs): ?record=1 shows the picture only, filling the window, and ?cut=x plays the
 * shorter cut made for an X post.
 */
import { useMemo, type ReactNode } from 'react';
import { DemoFilm, FALLBACK, type FilmData } from './DemoFilm';
import { Icon } from '../icons';

export interface FilmLinks {
  quote: (ticker: string) => void;
  recipes: () => void;
  spec: () => void;
  composeRecipe: () => void;
  composePart: () => void;
  runner: () => void;
  trust: () => void;
}

export function FilmPageView({ data = FALLBACK, links, today, tryLabel, after }: {
  data?: FilmData; links: FilmLinks;
  /** what is real where the film is watched: [heading, text] */
  today: [string, string][];
  /** the end card's first button (default: Try CHECK live) */
  tryLabel?: string;
  /** anything to show under the notes */
  after?: ReactNode;
}) {
  const q = useMemo(() => new URLSearchParams(location.search), []);
  const cut = q.get('cut') === 'x' ? 'x' : 'full';
  if (q.has('record')) return <div className="df-record"><DemoFilm bare cut={cut} data={FALLBACK} onTry={() => {}} onBrowse={() => {}} onSpec={() => {}} /></div>;
  const seats: { who: string; icon: string; line: string; go: () => void; cta: string }[] = [
    { who: 'Users', icon: 'user', line: 'Pick a recipe, pay per run. A failed run is refunded.', go: links.recipes, cta: 'Find a recipe' },
    { who: 'Creators', icon: 'compose', line: 'Compose recipes from parts, no code. Paid on every run.', go: links.composeRecipe, cta: 'Try the composer' },
    { who: 'Builders', icon: 'code', line: 'Write parts to the open spec, SRS-1. A fee each time one is used.', go: links.composePart, cta: 'Build a part' },
    { who: 'Runners', icon: 'cpu', line: 'Run recipes inside sealed hardware. A fee on every run.', go: links.runner, cta: 'How the runner works' },
  ];
  return (
    <div className="df-page-wrap">
      <div className="df-page-head">
        <div><h1>The guided demo</h1><p>Why this market exists and how one run plays out, for people and for AI agents, in under three minutes.</p></div>
        <span className="spacer" />
        <button className="btn ghost sm" onClick={links.recipes}>Skip to the recipes<Icon name="arrow" size={13} /></button>
      </div>
      <DemoFilm cut={cut} data={data} tryLabel={tryLabel} onTry={links.quote} onBrowse={links.recipes} onSpec={links.spec} />
      <div className="df-seats-row" aria-label="Who the market is for">
        {seats.map((s) => (
          <button key={s.who} className="df-seat-link" onClick={s.go}>
            <span className="ic"><Icon name={s.icon} size={17} /></span>
            <b>{s.who}</b><span>{s.line}</span><em>{s.cta}<Icon name="arrow" size={12} /></em>
          </button>
        ))}
      </div>
      <dl className="df-today" aria-label="What is real here">
        {today.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        <div><dt>The fine print</dt><dd>We read ours, and wrote it down: <button className="linkbtn" onClick={links.trust}>Trust &amp; privacy</button> shows every check, and the README lists every limit.</dd></div>
      </dl>
      {after}
    </div>
  );
}
