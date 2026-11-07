/**
 * Get a quote from one recipe, pay, and watch it run. The page is one explicit state machine:
 *
 *   form ──quote──▶ quoting ──▶ quoted ──choose──▶ preparing ──▶ ready ──pay──▶ paying ──▶ running ──▶ finished
 *     ▲               │  └──▶ unquotable            │                 │                    │
 *     └──── edit ─────┴──────────── (inputs changed: the sealed job no longer matches, the quote is dropped) ─┘
 *
 * Inputs are locked from the moment a payment is being prepared; "Get another quote" starts over from `form`.
 */
type Q = any;
type Phase =
  | { name: 'form' }
  | { name: 'quoting' }
  | { name: 'quoted'; q: Q }
  | { name: 'unquotable'; error: string }
  | { name: 'preparing'; q: Q; guaranteed: boolean }
  | { name: 'ready'; q: Q; guaranteed: boolean; pay: any }
  | { name: 'paying'; q: Q; guaranteed: boolean; pay: any }
  | { name: 'running'; q: Q; guaranteed: boolean; pay: any }
  | { name: 'finished'; q: Q; guaranteed: boolean; pay: any; ok: boolean };
type Act =
  | { t: 'edit' } | { t: 'quote' } | { t: 'quoted'; q: Q } | { t: 'unquotable'; error: string } | { t: 'quote_failed' }
  | { t: 'choose'; guaranteed: boolean } | { t: 'prepared'; pay: any } | { t: 'prepare_failed' }
  | { t: 'pay' } | { t: 'paid' } | { t: 'pay_failed' } | { t: 'ended'; ok: boolean } | { t: 'again' };

export function quoteReducer(p: Phase, a: Act): Phase {
  switch (a.t) {
    case 'edit': return ['form', 'quoted', 'unquotable', 'ready'].includes(p.name) ? { name: 'form' } : p;
    case 'quote': return p.name === 'form' || p.name === 'quoted' || p.name === 'unquotable' ? { name: 'quoting' } : p;
    case 'quoted': return p.name === 'quoting' ? { name: 'quoted', q: a.q } : p;
    case 'unquotable': return p.name === 'quoting' ? { name: 'unquotable', error: a.error } : p;
    case 'quote_failed': return p.name === 'quoting' ? { name: 'form' } : p;
    case 'choose': return p.name === 'quoted' ? { name: 'preparing', q: p.q, guaranteed: a.guaranteed } : p;
    case 'prepared': return p.name === 'preparing' ? { name: 'ready', q: p.q, guaranteed: p.guaranteed, pay: a.pay } : p;
    case 'prepare_failed': return p.name === 'preparing' ? { name: 'quoted', q: p.q } : p;
    case 'pay': return p.name === 'ready' ? { ...p, name: 'paying' } : p;
    case 'paid': return p.name === 'paying' ? { ...p, name: 'running' } : p;
    case 'pay_failed': return p.name === 'paying' ? { ...p, name: 'ready' } : p;
    case 'ended': return p.name === 'running' ? { ...p, name: 'finished', ok: a.ok } : p;
    case 'again': return p.name === 'finished' ? { name: 'form' } : p;
  }
}
export const LOCKED = new Set(['quoting', 'preparing', 'paying', 'running']);
