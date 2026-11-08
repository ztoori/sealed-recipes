import { useApp } from '../App';
import type { DocsSub } from '../route';
import { Trust } from './Trust';
import { Landscape } from './Landscape';
import { Spec } from './Spec';
import { PricingGuide } from './PricingGuide';
import { ComposeRecipeGuide } from './ComposeRecipeGuide';
import { ComposePartGuide } from './ComposePartGuide';
import { RunnerGuide } from './RunnerGuide';
import { Icon } from '../icons';

/** Documentation: the spec, where the project sits, how to trust it, how prices move, and how to build recipes and parts, and how the runner runs them. */
const TABS: [DocsSub, string, string][] = [
  ['spec', 'docs', 'Spec (SRS-1)'],
  ['landscape', 'globe', 'Landscape'],
  ['trust', 'shieldCheck', 'Trust & privacy'],
  ['pricing', 'trend', 'Price & demand'],
  ['compose-recipe', 'compose', 'Compose Recipe'],
  ['compose-part', 'box', 'Compose Part'],
  ['runner', 'cpu', 'Runner · TEE'],
];

export function Docs({ sub }: { sub: DocsSub }) {
  const { go } = useApp();
  return (
    <div className="grid">
      <div className="subnav" role="tablist" aria-label="Documentation">
        {TABS.map(([id, icon, label]) => <button key={id} role="tab" aria-selected={sub === id} onClick={() => go({ page: 'docs', sub: id })}><Icon name={icon} size={16} />{label}</button>)}
      </div>
      {sub === 'spec' ? <Spec /> : sub === 'landscape' ? <Landscape /> : sub === 'trust' ? <Trust /> : sub === 'pricing' ? <PricingGuide /> : sub === 'compose-recipe' ? <ComposeRecipeGuide /> : sub === 'compose-part' ? <ComposePartGuide /> : <RunnerGuide />}
    </div>
  );
}
