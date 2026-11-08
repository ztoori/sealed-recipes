import { useState } from 'react';
import { useApp } from '../App';
import { Icon } from '../icons';
import { ForAgents, GuideHero, GuideSection, Steps, Tiles } from './guide-kit';

/** Documentation › Compose Part: how a builder writes, admits and earns from a part. */

/** a part, drawn: what goes in, what comes out, what it may reach, what it costs */
function Anatomy() {
  return (
    <div className="g-anatomy" role="img" aria-label="A part: typed inputs on the left, typed outputs on the right, declared capabilities above, a fee and limits below">
      <div className="ga-col ga-in">
        <span className="ga-label">inputs, typed</span>
        <div className="ga-port"><i />holdings<em>token.holdings</em></div>
      </div>
      <div className="ga-body">
        <div className="ga-caps"><span><Icon name="globe" size={12} />net:cloud-api.near.ai</span><span><Icon name="globe" size={12} />net:1click.chaindefuser.com</span></div>
        <div className="ga-core">
          <span className="ga-cat"><Icon name="shield" size={13} />Check</span>
          <b>AI Spam Shield</b>
          <span className="ga-id">ai.spam-shield@1.1.0</span>
          <div className="ga-secret"><Icon name="lock" size={12} />policy <em>secret: the creator’s prompt</em></div>
        </div>
        <div className="ga-foot"><span><Icon name="dollar" size={12} />$0.05 a call</span><span><Icon name="clock" size={12} />20 s · 12 calls · 2 model calls</span><span><Icon name="sparkles" size={12} />open-weights model</span></div>
      </div>
      <div className="ga-col ga-out">
        <span className="ga-label">outputs, typed</span>
        <div className="ga-port out">clean<em>token.holdings</em><i /></div>
        <div className="ga-port out">flags<em>token.flags</em><i /></div>
      </div>
    </div>
  );
}

function Earnings() {
  const [fee, setFee] = useState(0.02);
  const [runs, setRuns] = useState(400);
  const month = fee * runs * 30;
  return (
    <div className="g-earn">
      <label>Your fee per call <input type="range" min={0.005} max={0.2} step={0.005} value={fee} onChange={(e) => setFee(Number(e.target.value))} /><b>${fee.toFixed(3)}</b></label>
      <label>Runs a day, across every recipe that uses it <input type="range" min={10} max={5000} step={10} value={runs} onChange={(e) => setRuns(Number(e.target.value))} /><b>{runs.toLocaleString()}</b></label>
      <div className="g-earn-out"><span>about</span><b>${month.toLocaleString(undefined, { maximumFractionDigits: 0 })}</b><span>a month, paid run by run, in the same receipt as everyone else</span></div>
    </div>
  );
}

const TIERS = [
  { icon: 'check', name: 'Open', when: 'Pure code, or it only reads public NEAR data.', gate: 'The automated checks', runs: 'In a sandbox', tone: 'gain' },
  { icon: 'eye', name: 'Reviewed', when: 'It sends buyer data somewhere new: a model, a service, any other host.', gate: 'Checks and one reviewer', runs: 'In the runner', tone: 'wax' },
  { icon: 'key', name: 'Signing', when: 'It asks the buyer to sign transactions.', gate: 'Checks and two independent reviewers', runs: 'In the runner', tone: 'violet' },
];

export function ComposePartGuide() {
  const { go } = useApp();
  return (
    <div className="grid">
      <GuideHero kicker="Compose Part" icon="box" title="Build it once." accent="Get paid every run."
        lede="A part is one skill, typed and priced. Every recipe that uses it pays you, on every run, in the same receipt, on any market that speaks SRS-1.">
        <button className="btn primary" onClick={() => go({ page: 'compose', sub: 'part' })}><Icon name="code" size={15} />Open the part builder</button>
        <button className="btn ghost" onClick={() => go({ page: 'compose', sub: 'review' })}><Icon name="shieldCheck" size={15} />See the review queue</button>
      </GuideHero>

      <GuideSection n={1} icon="sparkles" title="Why build a part" line="Write the hard thing once. Let other people turn it into products.">
        <Tiles items={[
          { icon: 'users', title: 'Creators do the selling', line: 'Recipe creators put your part in front of buyers. You never need a customer of your own.' },
          { icon: 'dollar', title: 'Paid per call, forever', line: 'Your fee is paid in every settlement of every recipe that uses the part.' },
          { icon: 'split', title: 'Win on merit', line: 'A part that fits the same types can replace a rival in one click, so better and cheaper parts spread.' },
          { icon: 'shieldCheck', title: 'Trusted by design', line: 'Buyers trust your part because the manifest says what it can touch, and the runner enforces it.' },
        ]} />
      </GuideSection>

      <GuideSection n={2} icon="box" title="Anatomy of a part" line="Everything a buyer, a creator or a reviewer needs to know fits on one card.">
        <Anatomy />
      </GuideSection>

      <GuideSection n={3} icon="code" title="Six steps from idea to income" line="The builder checks your work live, at every step.">
        <Steps items={[
          { icon: 'docs', title: 'Describe it', line: 'Name, category and a one-line summary. Typed inputs and outputs, and the settings creators can fill in, marked secret if they’re a creator’s edge.' },
          { icon: 'globe', title: 'Declare what it may touch', line: 'List every host it calls. Only an Act part may ask the buyer to sign. Set limits on time, calls and output size.', detail: <>The runner hands your code a network function that refuses every host you didn’t declare.</> },
          { icon: 'eye', title: 'Disclose what it runs on', line: 'Plain code, an open-weights model or a closed one, and whether prompts, tools and checks are open, sealed or closed.', detail: <>That decides the withdrawal-risk label buyers see: low, medium or high.</> },
          { icon: 'code', title: 'Write the code', line: 'Start from the template the builder writes from your manifest. Use ctx.http, handle quote mode, and save state before anything irreversible.', detail: <>Conformance, lint and security checks run as you type.</> },
          { icon: 'vault', title: 'Register and submit', line: 'Register the id, fee and manifest hash on-chain, then submit the code, signed by your wallet. The automated checks run it in a sandbox, as a quote and as a run.' },
          { icon: 'dollar', title: 'Get admitted, then earn', line: 'Admitted parts ship in the next runner release. From then on, creators can add it, and every run that uses it pays you.' },
        ]} />
      </GuideSection>

      <GuideSection n={4} icon="shield" title="The more it can do, the more it proves" line="Admission depends on what your manifest lets the part do. The builder shows your tier as you go.">
        <div className="g-tiers">
          {TIERS.map((t, i) => (
            <div key={t.name} className={'g-tier ' + t.tone}>
              <div className="g-tier-hd"><span><Icon name={t.icon} size={16} /></span><b>{t.name}</b><em>{'●'.repeat(i + 1)}{'○'.repeat(2 - i)}</em></div>
              <p>{t.when}</p>
              <div><span>Admitted by</span><b>{t.gate}</b></div>
              <div><span>Runs</span><b>{t.runs}</b></div>
            </div>
          ))}
        </div>
      </GuideSection>

      <GuideSection n={5} icon="dollar" title="What it could earn" line="An example, not a forecast. Move the sliders.">
        <Earnings />
      </GuideSection>

      <ForAgents rows={[
        ['Manifest', <>SRS-1 §2: <code>id</code>, <code>category</code>, <code>inputs</code>, <code>outputs</code>, <code>params</code>, <code>capabilities</code>, <code>fee_per_call</code>, <code>disclosure</code>, <code>limits</code></>],
        ['Check it', <><code>validatePartManifest</code>, <code>lintPartSource</code> (<code>core/src/partkit.ts</code>) and <code>securityScan</code> (<code>core/src/review.ts</code>)</>],
        ['Code shape', <><code>{'export const myPart: PartHandler = async (inputs, ctx) => ({ … })'}</code>; network only through <code>ctx.http</code></>],
        ['Get it running', <>register on-chain, submit signed code, pass the tier’s review, ship in a runner release (Spec §11)</>],
      ]} />
    </div>
  );
}
