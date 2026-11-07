import { useApp } from '../App';
import { ComposeRecipe } from './ComposeRecipe';
import { ComposePart } from './ComposePart';
import { Icon } from '../icons';

/** Compose: build a recipe from parts (no code), or build a part (code, to the SRS-1 standard). */
export function Compose({ sub, part }: { sub: 'recipe' | 'part'; part?: string }) {
  const { go } = useApp();
  return (
    <div className="grid">
      <div className="subnav" role="tablist" aria-label="Compose">
        <button role="tab" aria-selected={sub === 'recipe'} onClick={() => go({ page: 'compose', sub: 'recipe' })} title="No code: combine parts"><Icon name="compose" size={16} />Recipe <span>no code</span></button>
        <button role="tab" aria-selected={sub === 'part'} onClick={() => go({ page: 'compose', sub: 'part' })} title="For developers: build a building block"><Icon name="code" size={16} />Part <span>for developers</span></button>
      </div>
      {sub === 'recipe' ? <ComposeRecipe /> : <ComposePart part={part} />}
    </div>
  );
}
