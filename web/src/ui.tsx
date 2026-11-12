import { useId, useRef, useState, type ReactNode } from 'react';
import { Icon, recipeLook } from './icons';

/**
 * The recipe's seal: a wax medallion with a guilloché rosette, like the security printing on a banknote.
 * Its hue comes from the recipe's short code and its icon from what the recipe hands the buyer (its result type);
 * large seals also print the short code.
 */
export function Seal({ ticker, kind, size = 40, className }: { ticker?: string | null; kind?: string | null; size?: number; className?: string }) {
  const id = useId().replace(/:/g, '');
  const { icon, hue } = recipeLook(ticker, kind);
  const big = size >= 72;
  const N = big ? 30 : 18;
  const edge = Array.from({ length: 241 }, (_, i) => {
    const t = (i / 240) * Math.PI * 2;
    const r = 46 + 2.4 * Math.sin(N * t);
    return `${i ? 'L' : 'M'}${(r * Math.cos(t)).toFixed(2)},${(r * Math.sin(t)).toFixed(2)}`;
  }).join('') + 'Z';
  const rose = (k: number) => Array.from({ length: 361 }, (_, i) => {
    const t = (i / 360) * Math.PI * 2;
    const r = 31 + 5 * Math.sin(11 * t + k);
    return `${i ? 'L' : 'M'}${(r * Math.cos(t)).toFixed(2)},${(r * Math.sin(t)).toFixed(2)}`;
  }).join('') + 'Z';
  return (
    <svg className={'seal' + (className ? ' ' + className : '')} width={size} height={size} viewBox="-50 -50 100 100" aria-hidden>
      <defs>
        <radialGradient id={'w' + id} cx="35%" cy="30%" r="80%">
          <stop offset="0" stopColor={`hsl(${hue} 85% 72%)`} />
          <stop offset=".45" stopColor={`hsl(${hue} 70% 52%)`} />
          <stop offset="1" stopColor={`hsl(${hue} 70% 26%)`} />
        </radialGradient>
        <radialGradient id={'d' + id} cx="50%" cy="40%" r="70%">
          <stop offset="0" stopColor={`hsl(${hue} 80% 62%)`} />
          <stop offset="1" stopColor={`hsl(${hue} 70% 36%)`} />
        </radialGradient>
      </defs>
      <path d={edge} fill={`url(#w${id})`} />
      <circle r="39.5" fill="none" stroke={`hsl(${hue} 70% 22%)`} strokeOpacity=".55" strokeWidth="1.4" />
      {big && [0, 0.9, 1.8].map((k) => <path key={k} d={rose(k)} fill="none" stroke={`hsl(${hue} 100% 88%)`} strokeOpacity=".38" strokeWidth=".55" />)}
      <circle r={big ? 22 : 30} fill={`url(#d${id})`} stroke={`hsl(${hue} 70% 22%)`} strokeOpacity=".5" strokeWidth="1" />
      <g transform={big ? 'translate(-9.5 -18) scale(.8)' : 'translate(-14.4 -14.4) scale(1.2)'} color={`hsl(${hue} 60% 14%)`}>
        <Icon name={icon} size={24} />
      </g>
      {big && ticker && <text y="14.5" textAnchor="middle" className="seal-tk" fill={`hsl(${hue} 60% 14%)`}>{ticker}</text>}
    </svg>
  );
}

/**
 * A small ⓘ that holds the explanation, so the page shows the fact and keeps the reasoning one hover away.
 * The popover is fixed to the viewport, so a scrolling list or a clipped panel never cuts it off.
 */
export function Tip({ children, wide }: { children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; below: boolean } | null>(null);
  const show = () => {
    const r = ref.current?.getBoundingClientRect(); if (!r) return;
    const half = wide ? 200 : 150, below = r.top < 150;
    setPos({ x: Math.min(Math.max(r.left + r.width / 2, half + 8), innerWidth - half - 8), y: below ? r.bottom + 10 : r.top - 10, below });
  };
  const hide = () => setPos(null);
  return (
    <span className="tip" tabIndex={0} ref={ref} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} onKeyDown={(e) => e.key === 'Escape' && hide()} aria-label="More information">
      <Icon name="info" size={14} />
      {pos && <span role="tooltip" className={'tip-pop' + (wide ? ' wide' : '') + (pos.below ? ' below' : '')} style={{ left: pos.x, top: pos.y }}>{children}</span>}
    </span>
  );
}

export function Stat({ icon, value, label, tone, tip }: { icon: string; value: ReactNode; label: ReactNode; tone?: 'gain' | 'loss' | 'wax'; tip?: ReactNode }) {
  return (
    <div className={'stat' + (tone ? ' ' + tone : '')}>
      <span className="stat-ic"><Icon name={icon} size={17} /></span>
      <div><b>{value}</b><span>{label}{tip && <Tip>{tip}</Tip>}</span></div>
    </div>
  );
}

export function Empty({ icon, children, action }: { icon: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty"><span className="empty-ic"><Icon name={icon} size={22} /></span><div>{children}</div>{action}</div>;
}

/** Panel header: an icon, a title and, if needed, a tip. */
export function Head({ icon, title, tip, children }: { icon?: string; title: ReactNode; tip?: ReactNode; children?: ReactNode }) {
  return <header>{icon && <Icon name={icon} size={16} className="hd-ic" />}<h2>{title}</h2>{tip && <Tip>{tip}</Tip>}{children}</header>;
}

/** A recipe card closed with a wax seal: the product in one picture. */
export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="brandmark">
      <defs><radialGradient id="bm-wax" cx="35%" cy="30%" r="80%"><stop offset="0" stopColor="#FFE3A3" /><stop offset=".5" stopColor="#F0B44C" /><stop offset="1" stopColor="#8A5A0E" /></radialGradient></defs>
      <rect x="3" y="2.5" width="18" height="24" rx="3" fill="#E9EDF6" opacity=".14" stroke="#E9EDF6" strokeOpacity=".5" />
      <path d="M7 8h10M7 12h10M7 16h6" stroke="#E9EDF6" strokeOpacity=".7" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M23 14.6l1.8 1.3 2.2-.3.7 2.1 2 1-.5 2.2 1 2-1.8 1.3-.1 2.2-2.2.3-1.2 1.9-2.1-.7-2.1.7-1.2-1.9-2.2-.3-.1-2.2-1.8-1.3 1-2-.5-2.2 2-1 .7-2.1 2.2.3z" fill="url(#bm-wax)" />
      <path d="M21.2 22.4l1.3 1.3 2.6-2.8" stroke="#4A3000" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
