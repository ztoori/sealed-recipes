import { useApp } from '../App';
import { ComposeRecipe } from './ComposeRecipe';
import { ComposePart } from './ComposePart';

/** Compose: build a recipe from parts (no code), or build a part (code, to the SRS-1 standard). */
export function Compose({ sub, part }: { sub: 'recipe' | 'part'; part?: string }) {
  const { go } = useApp();
  return (
    <div className="grid">
      <div className="subnav" role="tablist" aria-label="Compose">
        <button role="tab" aria-selected={sub === 'recipe'} onClick={() => go({ page: 'compose', sub: 'recipe' })}>Recipe <span>no code: combine parts</span></button>
        <button role="tab" aria-selected={sub === 'part'} onClick={() => go({ page: 'compose', sub: 'part' })}>Part <span>for developers: build a building block</span></button>
      </div>
      {sub === 'recipe' ? <ComposeRecipe /> : <ComposePart part={part} />}
    </div>
  );
}
