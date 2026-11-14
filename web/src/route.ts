/**
 * Navigation as one explicit state, mirrored in the URL hash so every page can be linked and the back button works.
 *   #/ (landing)   #/demo (the guided demo film)   #/recipes[/TICKER]   #/quote/TICKER   #/compose/recipe   #/compose/part[/PART_ID]   #/compose/review[/SUBMISSION_ID]   #/wallet   #/docs/spec|landscape|trust|pricing|compose-recipe|compose-part|runner (#/docs/standard still opens the spec)
 */
export type Route =
  | { page: 'home' }
  | { page: 'film' }
  | { page: 'recipes'; ticker?: string }
  | { page: 'quote'; ticker: string }
  | { page: 'compose'; sub: 'recipe' | 'part' | 'review'; part?: string }
  | { page: 'wallet' }
  | { page: 'docs'; sub: DocsSub };

export const DOCS_SUBS = ['spec', 'landscape', 'trust', 'pricing', 'compose-recipe', 'compose-part', 'runner'] as const;
export type DocsSub = (typeof DOCS_SUBS)[number];

export function parseRoute(hash: string): Route {
  const [page, a, ...rest] = hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  const b = rest.join('/');
  switch (page) {
    case '': return { page: 'home' };
    case 'demo': case 'film': return { page: 'film' };
    case 'quote': return a ? { page: 'quote', ticker: a.toUpperCase() } : { page: 'recipes' };
    case 'compose': return a === 'part' || a === 'review' ? { page: 'compose', sub: a, ...(b ? { part: b } : {}) } : { page: 'compose', sub: 'recipe' };
    case 'wallet': return { page: 'wallet' };
    case 'docs': return { page: 'docs', sub: (DOCS_SUBS as readonly string[]).includes(a) ? (a as DocsSub) : 'spec' };
    default: return a ? { page: 'recipes', ticker: a.toUpperCase() } : { page: 'recipes' };
  }
}

export function routeHash(r: Route): string {
  switch (r.page) {
    case 'home': return '#/';
    case 'film': return '#/demo';
    case 'recipes': return r.ticker ? `#/recipes/${r.ticker}` : '#/recipes';
    case 'quote': return `#/quote/${r.ticker}`;
    case 'compose': return r.sub === 'recipe' ? '#/compose/recipe' : `#/compose/${r.sub}${r.part ? '/' + encodeURIComponent(r.part) : ''}`;
    case 'wallet': return '#/wallet';
    case 'docs': return `#/docs/${r.sub}`;
  }
}

/** which top-level menu item a route belongs to (Get a quote lives under Recipes) */
export const section = (r: Route): 'home' | 'recipes' | 'compose' | 'wallet' | 'docs' => (r.page === 'quote' ? 'recipes' : r.page === 'film' ? 'home' : r.page);
