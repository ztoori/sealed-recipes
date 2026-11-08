import recipeFigure from '../../../docs/media/srs-recipe.svg?raw';
import { useApp } from '../App';
import { Icon } from '../icons';
import { ForAgents, GuideHero, GuideSection, Steps, Tiles } from './guide-kit';

/** Documentation › Compose Recipe: how a creator builds, prices and seals a recipe, with no code. */
export function ComposeRecipeGuide() {
  const { go } = useApp();
  const open = () => go({ page: 'compose', sub: 'recipe' });
  return (
    <div className="grid">
      <GuideHero kicker="Compose Recipe" icon="compose" title="Build a workflow." accent="Write no code."
        lede="Pick parts, let the types wire them, decide the logic, set a price and seal it. The method stays yours, and every run pays you.">
        <button className="btn primary" onClick={open}><Icon name="compose" size={15} />Open the composer</button>
        <button className="btn ghost" onClick={() => go({ page: 'docs', sub: 'spec' })}><Icon name="docs" size={15} />The format behind it</button>
      </GuideHero>

      <GuideSection n={1} icon="sparkles" title="Why compose here" line="What you know is worth more when strangers can use it without seeing it.">
        <Tiles items={[
          { icon: 'lock', title: 'Your method stays secret', line: 'The recipe is encrypted in your browser. Only you and the sealed runner can ever read it.' },
          { icon: 'dollar', title: 'Paid on every run', line: 'Your cut arrives in the same receipt that pays everyone else.' },
          { icon: 'link', title: 'Built from proven parts', line: 'Use parts other people built, reviewed and priced. You assemble; they maintain.' },
          { icon: 'shieldCheck', title: 'Trusted from day one', line: 'Buyers get a signed quote and, when funds move, a guarantee you back with a deposit.' },
        ]} />
      </GuideSection>

      <GuideSection n={2} icon="compose" title="Six steps to a sealed recipe" line="About five minutes, start to finish.">
        <Steps items={[
          { icon: 'plus', title: 'Start', line: 'Open Compose › Recipe and choose New recipe, or reopen one of yours from the copy sealed to your wallet.' },
          { icon: 'box', title: 'Add parts', line: 'Press + or drag a part onto the canvas. It wires itself to the last matching output. A value nothing provides becomes a question on the buyer’s form.', detail: <>Start with a <b>Read</b> part, then <b>Check</b>, <b>Decide</b>, <b>Act</b> or <b>Report</b>. “Suggested next” shows what fits.</> },
          { icon: 'split', title: 'Shape the logic', line: 'Select a part to choose when it runs, what to use if it’s skipped, and whether a failure stops the run.', detail: <>Only if… · Fallback if this is skipped · If this part fails. Every menu is built from the types, so you can only pick logic that checks out.</> },
          { icon: 'lock', title: 'Add your edge', line: 'Fill in each part’s sealed settings: the prompt, the thresholds, the watch lists. This is what buyers pay for and nobody can copy.', detail: <>Drop-in alternatives lists every part that could replace the one selected, with its fee and risk.</> },
          { icon: 'ticket', title: 'Name and price it', line: 'A name, a 3–6 letter code, a price and an optional band that follows demand. Add a guarantee deposit if your recipe moves funds.', detail: <>The panel shows what you earn per run: the price minus part fees, the runner’s $0.03 and the protocol’s 2%.</> },
          { icon: 'lock', title: 'Seal and publish', line: 'Your browser checks the runner’s attestation, encrypts the recipe to it, commits its hash on-chain and lists it.' },
        ]} />
      </GuideSection>

      <GuideSection n={3} icon="eye" title="What it looks like" line="A real recipe from the examples: cheap rules first, a private AI only when they’re unsure.">
        <figure className="g-figure" dangerouslySetInnerHTML={{ __html: recipeFigure }} />
        <Tiles items={[
          { icon: 'eye', title: 'Buyers see', line: 'One question, four parts, a low-risk label, a report and a price.' },
          { icon: 'lock', title: 'Only you know', line: 'When the AI is asked, what it’s told, and which verdict the report prefers.' },
        ]} />
      </GuideSection>

      <GuideSection n={4} icon="check" title="Ready when every light is green" line="The Publish panel ticks these off as you go. The seal button waits for all of them.">
        <div className="g-checks">
          {[
            ['Parts added', 'at least one part on the canvas'],
            ['Every input has a value', 'from a part, the buyer or a fixed value'],
            ['A result for the buyer', 'one output chosen as what the buyer gets'],
            ['Short code and name', '3–6 capitals or digits, not taken'],
            ['Price covers the fees', 'the floor pays every part, the runner and the protocol'],
          ].map(([a, b]) => <div key={a}><span><Icon name="check" size={13} /></span><b>{a}</b><em>{b}</em></div>)}
        </div>
      </GuideSection>

      <GuideSection n={5} icon="refresh" title="After you publish" line="Improve it without breaking what buyers chose.">
        <Tiles tone="wax" items={[
          { icon: 'clock', title: 'Change the method', line: 'New wiring or settings publish as a new version, after an on-chain notice. Runs already paid keep the version they paid for.' },
          { icon: 'split', title: 'Change what buyers see', line: 'Different parts, questions or result make a new recipe with its own code. The old one stays listed.' },
          { icon: 'trend', title: 'Change the price band', line: 'Only you can, from the recipe’s page. Inside the band, demand sets the price.' },
        ]} />
      </GuideSection>

      <ForAgents rows={[
        ['Document', <>an SRS-1 recipe: <code>form</code>, <code>nodes</code>, <code>consts</code>, <code>output</code>, <code>listing</code> (Spec §3)</>],
        ['Check it', <><code>validateRecipe(recipe, catalog)</code> in <code>core/src/srs.ts</code>: the same checks the composer and the runner use</>],
        ['Build it from parts', <><code>blankRecipe</code>, <code>addPartAutoWired</code>, <code>compatibleSwaps</code> in <code>core/src/partkit.ts</code></>],
        ['Seal it', <><code>seal(recipe, runnerEncPk, 'recipe')</code>; only <code>sha256</code> of the envelope goes on-chain</>],
      ]} />
    </div>
  );
}
