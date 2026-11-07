import { useApp } from '../App';
import { Trust } from './Trust';
import { Landscape } from './Landscape';
import { Standard } from './Standard';
import { Icon } from '../icons';

/** Documentation: the standard everything is built on, how to trust what you see, and where this project sits. */
export function Docs({ sub }: { sub: 'standard' | 'trust' | 'landscape' }) {
  const { go } = useApp();
  return (
    <div className="grid">
      <div className="subnav" role="tablist" aria-label="Documentation">
        <button role="tab" aria-selected={sub === 'standard'} onClick={() => go({ page: 'docs', sub: 'standard' })}><Icon name="docs" size={16} />Standard (SRS-1)</button>
        <button role="tab" aria-selected={sub === 'trust'} onClick={() => go({ page: 'docs', sub: 'trust' })}><Icon name="shieldCheck" size={16} />Trust &amp; privacy</button>
        <button role="tab" aria-selected={sub === 'landscape'} onClick={() => go({ page: 'docs', sub: 'landscape' })}><Icon name="globe" size={16} />Landscape</button>
      </div>
      {sub === 'standard' ? <Standard /> : sub === 'trust' ? <Trust /> : <Landscape />}
    </div>
  );
}
