import { useApp } from '../App';
import { Trust } from './Trust';
import { Landscape } from './Landscape';
import { Spec } from './Spec';
import { Icon } from '../icons';

/** Documentation: the spec everything is built on, how to trust what you see, and where this project sits. */
export function Docs({ sub }: { sub: 'spec' | 'trust' | 'landscape' }) {
  const { go } = useApp();
  return (
    <div className="grid">
      <div className="subnav" role="tablist" aria-label="Documentation">
        <button role="tab" aria-selected={sub === 'spec'} onClick={() => go({ page: 'docs', sub: 'spec' })}><Icon name="docs" size={16} />Spec (SRS-1)</button>
        <button role="tab" aria-selected={sub === 'trust'} onClick={() => go({ page: 'docs', sub: 'trust' })}><Icon name="shieldCheck" size={16} />Trust &amp; privacy</button>
        <button role="tab" aria-selected={sub === 'landscape'} onClick={() => go({ page: 'docs', sub: 'landscape' })}><Icon name="globe" size={16} />Landscape</button>
      </div>
      {sub === 'spec' ? <Spec /> : sub === 'trust' ? <Trust /> : <Landscape />}
    </div>
  );
}
