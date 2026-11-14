/**
 * The guided demo: one film (components/DemoFilm.tsx) that tells the whole story, people and AI agents, in about
 * two and a half minutes. Prices, names and the payout split come from the live contract when the page has them.
 */
import { useMemo } from 'react';
import { DemoFilm, FALLBACK, type FilmData } from '../components/DemoFilm';
import { Icon } from '../icons';
import { useLive, type Listing } from './ctx';

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

export function FilmPage() {
  const { listings, go } = useLive();
  const data = useMemo(() => filmData(listings), [listings]);
  return (
    <div className="df-page-wrap">
      <div className="df-page-head">
        <div><h1>The guided demo</h1><p>Everything Sealed Recipes does, for people and for AI agents, in one short film.</p></div>
        <span className="spacer" />
        <button className="btn ghost sm" onClick={() => go({ page: 'recipes' })}>Skip to the recipes<Icon name="arrow" size={13} /></button>
      </div>
      <DemoFilm data={data} onTry={(t) => go({ page: 'quote', ticker: t })} onBrowse={() => go({ page: 'recipes' })} onSpec={() => go({ page: 'docs', sub: 'spec' })} />
    </div>
  );
}
