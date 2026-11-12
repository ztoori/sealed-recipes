import { CAT, Icon } from '../icons';
import { Seal } from '../ui';
import { Loop, NextCue } from '../components/landing-kit';
import { partCat, prettyPart } from '../parts';
import { DEMO, accUrl, tusdc, useLive } from './ctx';

/**
 * The front door of the live page: the guided demo's landing (pages/Landing.tsx), with every number read from the
 * contract on NEAR testnet. Composing and building parts are shown in the guided demo; the live page runs recipes.
 */
const NEXT: [string, string][] = [['lp-s-buy', 'If you use crypto'], ['lp-s-sell', 'If you know the moves'], ['lp-s-build', 'If you build'], ['lp-s-agents', 'If you’re an AI agent'], ['lp-s-end', 'Run one for real']];

export function Home() {
  const { go, listings, mode } = useLive();
  const ls = listings ?? [];
  const runs = ls.reduce((a, l) => a + Number(l.onchain?.runs ?? 0), 0);
  const parts = [...new Set(ls.flatMap((l) => l.parts))];
  const uses = (id: string) => ls.filter((l) => l.parts.includes(id)).length;
  const popular = [...parts].sort((a, b) => uses(b) - uses(a))[0];
  const busiest = [...ls].sort((a, b) => Number(b.onchain?.runs ?? 0) - Number(a.onchain?.runs ?? 0))[0];
  return (
    <div className="lp">
      <section className="lp-hero">
        <div className="lp-hero-tx">
          <h1>
            <span><i className="lp-dot buy" />Run a recipe.</span>
            <span><i className="lp-dot sell" />Sell a recipe.</span>
            <span><i className="lp-dot build" />Supply the ingredients.</span>
          </h1>
          <p className="lp-lede">A market for crypto workflows that are proven, private and paid for one run at a time, by people and AI agents alike. This is the live one, on NEAR testnet: no login, test tokens only.</p>
          <dl className="lp-stats" aria-label="Live from the contract on NEAR testnet">
            <div><dt>recipes live</dt><dd>{listings ? ls.length : '–'}</dd></div>
            <div><dt>runs settled on-chain</dt><dd>{listings ? runs : '–'}</dd></div>
            <div><dt>parts in use</dt><dd>{listings ? parts.length : '–'}</dd></div>
          </dl>
          <div className="lp-cta" style={{ justifyContent: 'flex-start', marginTop: 22 }}>
            <button className="btn primary lg" onClick={() => go({ page: 'recipes' })}>Proceed to recipes<Icon name="arrow" size={16} /></button>
            <a className="btn ghost lg" href={`${DEMO}/?story=1`}><Icon name="play" size={14} fill />Guided demo</a>
          </div>
        </div>
        <Loop />
      </section>

      <section className="lp-row buy" id="lp-s-buy" aria-labelledby="lp-buy">
        <div className="lp-copy">
          <span className="lp-who"><Icon name="user" size={15} />If you use crypto</span>
          <h2 id="lp-buy">Crypto has a thousand pitfalls. Step around them.</h2>
          <p>Pick a recipe, type the account you want checked, get a signed quote. Pay with a guest account made in your browser and read the sealed result.</p>
          <ul className="lp-beats">
            <li><Icon name="receipt" size={17} />A signed quote from a sealed dry run before you pay</li>
            <li><Icon name="lock" size={17} />Your inputs and the result are sealed to this browser</li>
            <li><Icon name="key" size={17} />Your guest key signs here. Nobody else can.</li>
          </ul>
          <button className="linkbtn" onClick={() => go({ page: 'recipes' })}>Find a recipe<Icon name="arrow" size={14} /></button>
        </div>
        <div className="lp-visual">
          <div className="lp-recipes">
            {ls.slice(0, 8).map((l) => (
              <button key={l.ticker} className="lp-recipe" onClick={() => go({ page: 'recipes', ticker: l.ticker })} title={l.description}>
                <Seal ticker={l.ticker} kind={l.output_type} size={34} />
                <span>{l.name}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="lp-row sell flip" id="lp-s-sell" aria-labelledby="lp-sell">
        <div className="lp-copy">
          <span className="lp-who"><Icon name="compose" size={15} />If you know the moves</span>
          <h2 id="lp-sell">You know what works. Get paid for it.</h2>
          <p>Drag parts into a workflow, no code required. Seal it, list it, and earn every time someone runs it. The composer is in the guided demo; on testnet, a recipe is published with the creator’s own key.</p>
          <ul className="lp-beats">
            <li><Icon name="lock" size={17} />Sealed, so no one can copy it. Not even us.</li>
            <li><Icon name="vault" size={17} />Only its hash and part list go on-chain</li>
            <li><Icon name="receipt" size={17} />Paid the moment each run settles</li>
          </ul>
          <a className="linkbtn" href={`${DEMO}/#/compose/recipe`}>Compose a recipe in the guided demo<Icon name="arrow" size={14} /></a>
        </div>
        <div className="lp-visual">
          <div className="lp-sealed">
            <div className="lp-chain">
              {['source', 'guard', 'transform', 'action'].map((c, i) => (
                <span key={c} className="lp-link" style={{ ['--cc' as any]: CAT[c].color, ['--i' as any]: i }}><Icon name={CAT[c].icon} size={15} />{CAT[c].label}</span>
              ))}
            </div>
            <div className="lp-wax"><Seal ticker={busiest?.ticker ?? 'SEAL'} kind={busiest?.output_type ?? 'report'} size={96} /></div>
            {busiest && <div className="lp-earn"><span>{busiest.ticker} has settled</span><b>{String(busiest.onchain?.runs ?? 0)} runs</b><span>at {tusdc(busiest.onchain?.price_per_run ?? busiest.price_per_run)} tUSDC each</span></div>}
          </div>
        </div>
      </section>

      <section className="lp-row build" id="lp-s-build" aria-labelledby="lp-build">
        <div className="lp-copy">
          <span className="lp-who"><Icon name="code" size={15} />If you build</span>
          <h2 id="lp-build">You make the tools. Earn every time they’re used.</h2>
          <p>Publish a part once. Every recipe that includes it pays your fee, run after run.</p>
          <ul className="lp-beats">
            <li><Icon name="link" size={17} />Built to an open spec, so it fits anywhere</li>
            <li><Icon name="vault" size={17} />Registered on-chain with your fee</li>
            <li><Icon name="users" size={17} />Paid in the same settlement as everyone else</li>
          </ul>
          <a className="linkbtn" href={`${DEMO}/#/compose/part`}>Build a part in the guided demo<Icon name="arrow" size={14} /></a>
        </div>
        <div className="lp-visual">
          {popular && (
            <div className="lp-part" style={{ ['--cc' as any]: CAT[partCat(popular)]?.color }}>
              <div className="lp-part-hd"><Icon name={CAT[partCat(popular)]?.icon ?? 'box'} size={18} /><b>{prettyPart(popular)}</b><span>{popular.split('@')[1] ? 'v' + popular.split('@')[1] : ''}</span></div>
              <div className="lp-part-math">
                <span>used by</span>
                <b>{uses(popular)} live recipe{uses(popular) === 1 ? '' : 's'}</b>
              </div>
              <div className="lp-part-users">{ls.filter((l) => l.parts.includes(popular)).slice(0, 7).map((l) => <span key={l.ticker} className="tk">{l.ticker}</span>)}</div>
            </div>
          )}
        </div>
      </section>

      <section className="lp-agents" id="lp-s-agents" aria-labelledby="lp-agents">
        <div>
          <span className="lp-who"><Icon name="cpu" size={15} />If you’re an AI agent</span>
          <h2 id="lp-agents">Fluent in API.</h2>
          <p>Everything this page does, an agent can do on its own: read the listings, seal its inputs, ask for a signed quote, pay with its own key, and follow the run.</p>
        </div>
        <pre className="lp-term" aria-label="Agent flow over the live API"><code>
<span className="c">{'# recipes on the contract, with their on-chain record'}</span>{'\n'}
<span className="k">GET </span>{'/api/listings'}{'\n\n'}
<span className="c">{'# seal your inputs to the attested runner, ask for a signed quote'}</span>{'\n'}
<span className="k">POST</span>{' /api/quotes        { recipe_id, sealed_job, job_hash, buyer }'}{'\n\n'}
<span className="c">{'# get the payment to sign (ft_transfer_call), then stream the run'}</span>{'\n'}
<span className="k">POST</span>{' /api/runs/prepare  { recipe_id, buyer, sealed_inputs, signed_quote }'}
        </code></pre>
      </section>

      <section className="lp-end" id="lp-s-end">
        <Seal ticker={busiest?.ticker ?? 'RUN'} kind={busiest?.output_type ?? 'report'} size={72} className="lp-end-seal" />
        <h2>Run one for real, on testnet.</h2>
        <p>A sealed quote in seconds, a payment you sign in this browser, and every step on <a href={accUrl(mode?.contract_id ?? '')} target="_blank" rel="noreferrer">{mode?.contract_id ?? 'the contract'}</a>.</p>
        <div className="lp-cta">
          <a className="btn ghost lg" href={`${DEMO}/?story=1`}><Icon name="play" size={14} fill />Watch the guided demo</a>
          <button className="btn primary lg" onClick={() => go({ page: 'recipes' })}>Proceed to recipes<Icon name="arrow" size={16} /></button>
        </div>
      </section>
      <NextCue steps={NEXT} />
    </div>
  );
}
