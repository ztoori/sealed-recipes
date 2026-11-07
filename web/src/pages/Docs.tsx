import { useApp } from '../App';
import { Trust } from './Trust';
import { Landscape } from './Landscape';

/** Documentation: how to trust what you see, and where this project sits. Features live in the other sections. */
export function Docs({ sub }: { sub: 'trust' | 'landscape' }) {
  const { go } = useApp();
  return (
    <div className="grid">
      <div className="subnav" role="tablist" aria-label="Documentation">
        <button role="tab" aria-selected={sub === 'trust'} onClick={() => go({ page: 'docs', sub: 'trust' })}>Trust &amp; privacy</button>
        <button role="tab" aria-selected={sub === 'landscape'} onClick={() => go({ page: 'docs', sub: 'landscape' })}>Landscape</button>
      </div>
      {sub === 'trust' ? <Trust /> : <Landscape />}
    </div>
  );
}
