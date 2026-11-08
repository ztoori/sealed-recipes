/**
 * One icon set for the whole app: 24px grid, 1.75 stroke, round joins. Each icon names a thing the user sees,
 * so a glance replaces a label.
 */
const P: Record<string, string> = {
  market: 'M3.5 9.5 5 4h14l1.5 5.5M3.5 9.5h17M3.5 9.5a2.8 2.8 0 0 0 5.6 0 2.8 2.8 0 0 0 5.8 0 2.8 2.8 0 0 0 5.6 0M5 12.5V20h14v-7.5M10 20v-4.5h4V20',
  compose: 'M4 4h6v6H4zM14 14h6v6h-6zM10 7h3.5A3.5 3.5 0 0 1 17 10.5V14',
  wallet: 'M19 8V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-4M3 7h16a1 1 0 0 1 1 1v3M20 11h-4a2 2 0 0 0 0 4h4z',
  docs: 'M4 19.5V5a2 2 0 0 1 2-2h14v15H6.5A2.5 2.5 0 0 0 4 20.5 2.5 2.5 0 0 0 6.5 23H20v-5M8 7h8M8 11h5',
  play: 'M7 4.5v15l12.5-7.5z',
  stop: 'M6.5 6.5h11v11h-11z',
  search: 'M10.5 17.5a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20.5 20.5l-5-5',
  star: 'm12 3.5 2.6 5.3 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z',
  shield: 'M12 3 4.5 6v5.5c0 4.6 3.1 8.2 7.5 9.5 4.4-1.3 7.5-4.9 7.5-9.5V6z',
  shieldCheck: 'M12 3 4.5 6v5.5c0 4.6 3.1 8.2 7.5 9.5 4.4-1.3 7.5-4.9 7.5-9.5V6zM8.8 12l2.2 2.2 4.3-4.4',
  sparkles: 'M10 3.5 11.7 8 16 9.7l-4.3 1.7L10 16l-1.7-4.6L4 9.7 8.3 8zM18 14l.9 2.1 2.1.9-2.1.9L18 20l-.9-2.1L15 17l2.1-.9z',
  dollar: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM15 9.2c-.5-.9-1.6-1.5-3-1.5-1.7 0-3 .9-3 2.1 0 2.9 6 1.4 6 4.3 0 1.2-1.3 2.1-3 2.1-1.4 0-2.5-.6-3-1.5M12 6v1.7M12 16.3V18',
  gift: 'M3.5 8h17v4h-17zM5 12v8.5h14V12M12 8v12.5M12 8c-1.5-3.5-5.5-4.5-6-2.2C5.6 7.7 9 8 12 8zm0 0c1.5-3.5 5.5-4.5 6-2.2.4 1.9-3 2.2-6 2.2z',
  key: 'M8 20a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM11.2 12.3 20 3.5M16.5 7l2.8 2.8M14 9.5l2 2',
  layers: 'm12 3 9 4.8-9 4.8-9-4.8zM3 12.2 12 17l9-4.8M3 16.6l9 4.8 9-4.8',
  fileSearch: 'M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h6M14 3l5 5M14 3v5h5v3M16.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM18.3 19.8 20.5 22',
  pie: 'M20.5 13.5A8.5 8.5 0 1 1 10.5 3.5v10zM14 3.6a8.5 8.5 0 0 1 6.4 6.4H14z',
  lock: 'M5.5 11h13v9.5h-13zM8.5 11V7.5a3.5 3.5 0 0 1 7 0V11M12 15v2',
  unlock: 'M5.5 11h13v9.5h-13zM8.5 11V7.5a3.5 3.5 0 0 1 6.8-1.2',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  trend: 'm3 17 6-6 4 4 8-8M15 7h6v6',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  x: 'M6 6l12 12M18 6 6 18',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5.5M12 7.8v.1',
  alert: 'M12 3.5 2.5 20h19zM12 10v4.5M12 17.3v.1',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5V12l3 2',
  receipt: 'M5.5 3h13v18l-2.6-1.6-2.3 1.6-2.3-1.6-2.3 1.6-2.3-1.6-1.2.8zM9 8h6M9 12h6M9 16h3',
  cpu: 'M7 7h10v10H7zM10 10h4v4h-4zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
  chevron: 'm9 6 6 6-6 6',
  back: 'M15 6l-6 6 6 6',
  arrow: 'M4 12h15M13 6l6 6-6 6',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13',
  download: 'M12 4v11M7 10.5l5 5 5-5M5 20h14',
  refresh: 'M20 11a8 8 0 0 0-14.5-4.5L4 8.5M4 4v4.5h4.5M4 13a8 8 0 0 0 14.5 4.5L20 15.5M20 20v-4.5h-4.5',
  zap: 'M13 2.5 4.5 13.5H12l-1 8 8.5-11H12z',
  sliders: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4',
  code: 'm8.5 7-5 5 5 5M15.5 7l5 5-5 5M13.5 4.5l-3 15',
  box: 'm12 3 8.5 4.5v9L12 21l-8.5-4.5v-9zM3.5 7.5 12 12l8.5-4.5M12 12v9',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5a7.5 7.5 0 0 1 15 0',
  users: 'M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.5a6.5 6.5 0 0 1 3.5 5.5',
  database: 'M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3zM4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  fileText: 'M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5M8.5 13h7M8.5 17h5',
  split: 'M4 12h6l6-6h4M10 12l6 6h4M17 3.5 20 6l-3 2.5M17 15.5l3 2.5-3 2.5',
  vault: 'M3.5 4h17v15h-17zM6 19v2M18 19v2M12 15a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM12 8V6.5M15.5 11.5H17',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9S9.5 5.5 12 3z',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  bolt: 'M13 2.5 4.5 13.5H12l-1 8 8.5-11H12z',
  scale: 'M12 3.5v17M7 20.5h10M4.5 7.5h15M4.5 7.5 2 14a3 3 0 0 0 5 0zM19.5 7.5 17 14a3 3 0 0 0 5 0z',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM12 12.5v-1',
  ticket:'M3.5 7.5a2 2 0 0 0 0 4v5h17v-5a2 2 0 0 1 0-4v-3h-17zM14 4.5v12',
};

export type IconName = keyof typeof P;
export function Icon({ name, size = 18, className, title, fill }: { name: IconName | string; size?: number; className?: string; title?: string; fill?: boolean }) {
  return (
    <svg className={'ic' + (className ? ' ' + className : '')} width={size} height={size} viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d={P[name] ?? P.box} />
    </svg>
  );
}

/** What a recipe hands the buyer, by result type: the icon on its seal. */
const RESULT_ICON: Record<string, string> = {
  'swap.receipts': 'sparkles', 'swap.plan': 'dollar', report: 'fileSearch', 'key.list': 'key', 'stake.list': 'layers',
  'contract.verdict': 'shieldCheck', 'token.flags': 'shieldCheck', 'token.holdings': 'pie',
};
/** What a recipe hands the buyer, in words. */
export const RESULT_LABEL: Record<string, string> = { 'swap.receipts': 'Delivers funds', report: 'Report' };

/** A recipe's seal: its icon comes from its result type, its wax hue from its short code, so every recipe has its own. */
export const recipeLook = (ticker?: string | null, resultType?: string | null): { icon: string; hue: number } => {
  let h = 40;
  if (ticker) { h = 0; for (const c of ticker) h = (h * 31 + c.charCodeAt(0)) % 360; }
  return { icon: RESULT_ICON[resultType ?? ''] ?? 'box', hue: h };
};

/** Part categories: the five kinds of step in a recipe. */
export const CAT: Record<string, { icon: string; label: string; color: string }> = {
  source: { icon: 'database', label: 'Read', color: 'var(--c-source)' },
  guard: { icon: 'shield', label: 'Check', color: 'var(--c-guard)' },
  transform: { icon: 'split', label: 'Decide', color: 'var(--c-transform)' },
  action: { icon: 'zap', label: 'Act', color: 'var(--c-action)' },
  sink: { icon: 'fileText', label: 'Report', color: 'var(--c-sink)' },
};

export const ROLE_ICON: Record<string, string> = {
  Creator: 'compose', Buyer: 'user', 'Part author': 'box', Trader: 'trend', Reviewer: 'shieldCheck', 'TEE runner': 'cpu', Protocol: 'vault',
};
