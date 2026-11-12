import { useEffect, useState } from 'react';
import { Icon } from '../icons';
import { Seal } from '../ui';

/** Landing-page pieces shared by the guided demo (pages/Landing.tsx) and the live page (live/Home.tsx). */

/**
 * A first-time visitor needs to know the story continues. One cue floats at the bottom and always names the next
 * section; clicking it moves there. At the end of the page it steps aside.
 */
export function NextCue({ steps }: { steps: [string, string][] }) {
  const [next, setNext] = useState<[string, string] | null>(steps[0]);
  useEffect(() => {
    const on = () => {
      const line = innerHeight * 0.62; // a section counts as reached once its top passes this line
      const n = steps.find(([id]) => (document.getElementById(id)?.getBoundingClientRect().top ?? 0) > line);
      const atEnd = innerHeight + scrollY >= document.documentElement.scrollHeight - 40;
      setNext(atEnd ? null : n ?? null);
    };
    on(); addEventListener('scroll', on, { passive: true }); addEventListener('resize', on);
    return () => { removeEventListener('scroll', on); removeEventListener('resize', on); };
  }, [steps]);
  return (
    <button className={'lp-next' + (next ? '' : ' gone')} tabIndex={next ? 0 : -1} aria-label={next ? `Next: ${next[1]}` : 'End of page'}
      onClick={() => next && document.getElementById(next[0])?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
      <span key={next?.[0]}>{next?.[1] ?? steps[steps.length - 1][1]}</span>
      <span className="lp-chev"><Icon name="chevron" size={16} /></span>
    </button>
  );
}

/** The market in one picture: parts flow to creators, recipes flow to buyers, and one receipt pays everyone. */
export function Loop() {
  return (
    <div className="lp-loop" aria-hidden>
      <svg viewBox="0 0 480 440" className="lp-arcs">
        <defs>
          <marker id="lp-ah" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1 9 5 1 9" fill="none" stroke="#8592ae" strokeWidth="1.6" strokeLinecap="round" /></marker>
        </defs>
        <path className="arc build" d="M118 96 Q240 18 362 96" markerEnd="url(#lp-ah)" />
        <path className="arc sell" d="M392 150 Q420 300 300 362" markerEnd="url(#lp-ah)" />
        <path className="arc buy" d="M180 362 Q60 300 88 150" markerEnd="url(#lp-ah)" />
        <circle cx="240" cy="220" r="118" className="orbit" />
      </svg>
      <span className="lp-arc-lbl t">parts</span>
      <span className="lp-arc-lbl r">sealed recipes</span>
      <span className="lp-arc-lbl l">one receipt pays all</span>
      <div className="lp-node build" style={{ left: '14%', top: '20%' }}><span className="ring"><Icon name="box" size={22} /></span><b>Builders</b><small>make parts</small></div>
      <div className="lp-node sell" style={{ left: '86%', top: '20%' }}><span className="ring"><Icon name="compose" size={22} /></span><b>Creators</b><small>seal recipes</small></div>
      <div className="lp-node buy" style={{ left: '50%', top: '86%' }}><span className="ring"><Icon name="user" size={22} /></span><b>Buyers</b><small>people or agents</small></div>
      <div className="lp-core"><Seal ticker="RUN" kind="swap.receipts" size={132} /></div>
    </div>
  );
}
