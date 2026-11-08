import { useApp } from '../App';
import { ComposeRecipe } from './ComposeRecipe';
import { ComposePart } from './ComposePart';
import { ComposeReview } from './ComposeReview';
import { usePoll } from '../api';
import { Icon } from '../icons';

/** Compose: build a recipe from parts (no code), build a part (code, to the SRS-1 spec), or review submitted parts. */
export function Compose({ sub, part }: { sub: 'recipe' | 'part' | 'review'; part?: string }) {
  const { go } = useApp();
  const [subs] = usePoll<{ status: string }[]>('/api/parts/submissions', 5000);
  const waiting = (subs ?? []).filter((s) => s.status === 'in_review').length;
  return (
    <div className="grid">
      <div className="subnav" role="tablist" aria-label="Compose">
        <button role="tab" aria-selected={sub === 'recipe'} onClick={() => go({ page: 'compose', sub: 'recipe' })} title="No code: combine parts"><Icon name="compose" size={16} />Recipe <span>no code</span></button>
        <button role="tab" aria-selected={sub === 'part'} onClick={() => go({ page: 'compose', sub: 'part' })} title="For developers: build a building block"><Icon name="code" size={16} />Part <span>for developers</span></button>
        <button role="tab" aria-selected={sub === 'review'} onClick={() => go({ page: 'compose', sub: 'review' })} title="Admission of submitted parts, by tier"><Icon name="shieldCheck" size={16} />Review <span>{waiting ? `${waiting} waiting` : 'admission'}</span></button>
      </div>
      {sub === 'recipe' ? <ComposeRecipe /> : sub === 'review' ? <ComposeReview id={part} /> : <ComposePart part={part} />}
    </div>
  );
}
