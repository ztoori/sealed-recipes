/**
 * The guided demo on the live site: the shared film page (components/FilmPage.tsx). Prices, names and the payout split
 * come from the live contract when the page has them.
 */
import { useMemo } from 'react';
import { FALLBACK, type FilmData } from '../components/DemoFilm';
import { FilmPageView } from '../components/FilmPage';
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

/** what a careful viewer would ask after the film, answered plainly (README: Status) */
const TODAY: [string, string][] = [
  ['Live now', 'Three recipes on NEAR testnet, paid in a test token. One runner, in an Intel TDX machine, checked by your own browser before anything is sent.'],
  ['In the practice composer', 'Composing and publishing without code runs on simulated services. On testnet a creator publishes with their own key, from the command line.'],
  ['Not yet', 'Mainnet, a wallet connection, more than one runner, and a build anyone can reproduce from source. “Nobody can open it” holds as far as the hardware does.'],
];

export function FilmPage() {
  const { listings, go } = useLive();
  const data = useMemo(() => filmData(listings), [listings]);
  return (
    <FilmPageView data={data} today={TODAY} links={{
      quote: (t) => go({ page: 'quote', ticker: t }), recipes: () => go({ page: 'recipes' }), spec: () => go({ page: 'docs', sub: 'spec' }),
      composeRecipe: () => go({ page: 'compose', sub: 'recipe' }), composePart: () => go({ page: 'compose', sub: 'part' }),
      runner: () => go({ page: 'docs', sub: 'runner' }), trust: () => go({ page: 'docs', sub: 'trust' }),
    }} />
  );
}
