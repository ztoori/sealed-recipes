/**
 * The building blocks every guide page in Documentation shares, so each one reads the same way:
 * a hero that says why, numbered movements that say how, and a short block for agents that says exactly what to call.
 */
import type { ReactNode } from 'react';
import { Icon } from '../icons';

export function GuideHero({ kicker, icon, title, accent, lede, children }: { kicker: string; icon: string; title: string; accent: string; lede: ReactNode; children?: ReactNode }) {
  return (
    <section className="panel g-hero">
      <div className="body">
        <div className="g-kicker"><Icon name={icon} size={14} />{kicker}</div>
        <h2 className="g-title">{title} <em>{accent}</em></h2>
        <p className="g-lede">{lede}</p>
        {children && <div className="g-actions">{children}</div>}
      </div>
    </section>
  );
}

export function GuideSection({ n, icon, title, line, children, id }: { n: number; icon: string; title: string; line?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="panel g-sec" id={id}>
      <div className="body">
        <div className="g-sec-hd">
          <span className="g-num">{String(n).padStart(2, '0')}</span>
          <span className="g-ic"><Icon name={icon} size={18} /></span>
          <div><h3>{title}</h3>{line && <p>{line}</p>}</div>
        </div>
        {children}
      </div>
    </section>
  );
}

/** a numbered path, one step per line, with an optional detail under each */
export function Steps({ items }: { items: { icon: string; title: string; line: ReactNode; detail?: ReactNode }[] }) {
  return (
    <ol className="g-steps">
      {items.map((s, i) => (
        <li key={s.title}>
          <span className="g-step-n">{i + 1}</span>
          <div className="g-step-body">
            <div className="g-step-hd"><Icon name={s.icon} size={15} /><b>{s.title}</b></div>
            <p>{s.line}</p>
            {s.detail && <div className="g-step-detail">{s.detail}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** short side-by-side ideas: an icon, a few words, one line */
export function Tiles({ items, tone }: { items: { icon: string; title: string; line: ReactNode; tag?: string }[]; tone?: 'gain' | 'wax' }) {
  return (
    <div className={'g-tiles' + (tone ? ' ' + tone : '')}>
      {items.map((t) => (
        <div key={t.title} className="g-tile">
          <span className="g-tile-ic"><Icon name={t.icon} size={17} /></span>
          <b>{t.title}</b>
          <p>{t.line}</p>
          {t.tag && <em>{t.tag}</em>}
        </div>
      ))}
    </div>
  );
}

/** the same facts, for an AI agent or a developer: fields and calls, no prose */
export function ForAgents({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <div className="g-agents">
      <div className="g-agents-hd"><Icon name="cpu" size={14} />For agents and developers</div>
      <dl>{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
    </div>
  );
}
