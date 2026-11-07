/**
 * Navigation as one explicit state, mirrored in the URL hash so every page can be linked and the back button works.
 *   #/recipes[/TICKER]   #/quote/TICKER   #/compose/recipe   #/compose/part[/PART_ID]   #/wallet   #/docs/trust|landscape
 */
export type Route =
  | { page: 'recipes'; ticker?: string }
  | { page: 'quote'; ticker: string }
  | { page: 'compose'; sub: 'recipe' | 'part'; part?: string }
  | { page: 'wallet' }
  | { page: 'docs'; sub: 'trust' | 'landscape' };

export function parseRoute(hash: string): Route {
  const [page, a, ...rest] = hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  const b = rest.join('/');
  switch (page) {
    case 'quote': return a ? { page: 'quote', ticker: a.toUpperCase() } : { page: 'recipes' };
    case 'compose': return a === 'part' ? { page: 'compose', sub: 'part', ...(b ? { part: b } : {}) } : { page: 'compose', sub: 'recipe' };
    case 'wallet': return { page: 'wallet' };
    case 'docs': return { page: 'docs', sub: a === 'landscape' ? 'landscape' : 'trust' };
    default: return a ? { page: 'recipes', ticker: a.toUpperCase() } : { page: 'recipes' };
  }
}

export function routeHash(r: Route): string {
  switch (r.page) {
    case 'recipes': return r.ticker ? `#/recipes/${r.ticker}` : '#/recipes';
    case 'quote': return `#/quote/${r.ticker}`;
    case 'compose': return r.sub === 'part' ? `#/compose/part${r.part ? '/' + encodeURIComponent(r.part) : ''}` : '#/compose/recipe';
    case 'wallet': return '#/wallet';
    case 'docs': return `#/docs/${r.sub}`;
  }
}

/** which top-level menu item a route belongs to (Get a quote lives under Recipes) */
export const section = (r: Route): 'recipes' | 'compose' | 'wallet' | 'docs' => (r.page === 'quote' ? 'recipes' : r.page);
