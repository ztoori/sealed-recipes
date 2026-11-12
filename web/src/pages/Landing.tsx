import { money, usePoll } from '../api';
import { useApp } from '../App';
import { CAT, Icon } from '../icons';
import { Seal } from '../ui';
import { Loop, NextCue } from '../components/landing-kit';

/**
 * The front door. One loop explains the whole market: builders supply parts, creators seal them into recipes,
 * buyers (people or agents) run them, and one receipt pays everyone. Every number on this page is read live.
 */
export function Landing() {
  const { go, story } = useApp();
  const [listings] = usePoll<any[]>('/api/listings', 15000);
  const [cat] = usePoll<any>('/api/catalog', 60000);
  const parts: any[] = cat?.parts ?? [];
  const builders = new Set(parts.map((p) => p.author)).size;

  // real examples, never invented: the listing whose creator keeps the most per run, and the most reused part
  const best = [...(listings ?? [])].filter((l) => l.record?.perRun).sort((a, b) => b.record.perRun.creator - a.record.perRun.creator)[0];
  const uses = (id: string) => (listings ?? []).filter((l) => l.parts.includes(id)).length;
  const popular = [...parts].sort((a, b) => uses(b.id) - uses(a.id))[0];
  const creators = new Set((listings ?? []).map((l) => l.creator)).size;
  return (
    <div className="lp">
      <section className="lp-hero">
        <div className="lp-hero-tx">
          <h1>
            <span><i className="lp-dot buy" />Run a recipe.</span>
            <span><i className="lp-dot sell" />Sell a recipe.</span>
            <span><i className="lp-dot build" />Supply the ingredients.</span>
          </h1>
          <p className="lp-lede">A market for crypto workflows that are proven, private and paid for one run at a time, by people and AI agents alike.</p>
          <dl className="lp-stats" aria-label="Live from this market">
            <div><dt>recipes</dt><dd>{listings?.length ?? '–'}</dd></div>
            <div><dt>creator{creators === 1 ? '' : 's'}</dt><dd>{creators || '–'}</dd></div>
            <div><dt>parts by {builders || '–'} builder{builders === 1 ? '' : 's'}</dt><dd>{parts.length || '–'}</dd></div>
          </dl>
        </div>
        <Loop />
      </section>

      <section className="lp-row buy" id="lp-s-buy" aria-labelledby="lp-buy">
        <div className="lp-copy">
          <span className="lp-who"><Icon name="user" size={15} />If you use crypto</span>
          <h2 id="lp-buy">Crypto has a thousand pitfalls. Step around them.</h2>
          <p>Pick a recipe, see what it promises, press run. Good habits, without the homework.</p>
          <ul className="lp-beats">
            <li><Icon name="receipt" size={17} />A signed promise before you pay</li>
            <li><Icon name="shield" size={17} />Delivered less than promised? The guarantee covers the gap.</li>
            <li><Icon name="key" size={17} />Your wallet signs. Nobody else can.</li>
          </ul>
          <button className="linkbtn" onClick={() => go({ page: 'recipes' })}>Find a recipe<Icon name="arrow" size={14} /></button>
        </div>
        <div className="lp-visual">
          <div className="lp-recipes">
            {(listings ?? []).slice(0, 8).map((l) => (
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
          <p>Drag parts into a workflow, no code required. Seal it, list it, and earn every time someone runs it.</p>
          <ul className="lp-beats">
            <li><Icon name="lock" size={17} />Sealed, so no one can copy it. Not even us.</li>
            <li><Icon name="trend" size={17} />Priced by demand, inside the band you set</li>
            <li><Icon name="receipt" size={17} />Paid the moment each run settles</li>
          </ul>
          <button className="linkbtn" onClick={() => go({ page: 'compose', sub: 'recipe' })}>Compose a recipe<Icon name="arrow" size={14} /></button>
        </div>
        <div className="lp-visual">
          <div className="lp-sealed">
            <div className="lp-chain">
              {['source', 'guard', 'transform', 'action'].map((c, i) => (
                <span key={c} className="lp-link" style={{ ['--cc' as any]: CAT[c].color, ['--i' as any]: i }}><Icon name={CAT[c].icon} size={15} />{CAT[c].label}</span>
              ))}
            </div>
            <div className="lp-wax"><Seal ticker={best?.ticker ?? 'SEAL'} kind={best?.output_type ?? 'swap.receipts'} size={96} /></div>
            {best && <div className="lp-earn"><span>{best.ticker} creator keeps</span><b>{money(best.record.perRun.creator, 2)}</b><span>of every {money(best.record.pricePerRun, 2)} run</span></div>}
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
            <li><Icon name="users" size={17} />Paid in the same receipt as everyone else</li>
            <li><Icon name="shieldCheck" size={17} />Pure parts go live on automated checks; parts that ask buyers to sign need two reviewers</li>
          </ul>
          <button className="linkbtn" onClick={() => go({ page: 'compose', sub: 'part' })}>Build a part<Icon name="arrow" size={14} /></button>
        </div>
        <div className="lp-visual">
          {popular && (
            <div className="lp-part" style={{ ['--cc' as any]: CAT[popular.category]?.color }}>
              <div className="lp-part-hd"><Icon name={CAT[popular.category]?.icon ?? 'box'} size={18} /><b>{popular.name}</b><span>{popular.author}</span></div>
              <div className="lp-part-math">
                <span className="fee">{money(Number(popular.fee_per_call) / 1e6, 2)}</span>
                <Icon name="x" size={16} />
                <span>every run of</span>
                <b>{uses(popular.id)} recipe{uses(popular.id) === 1 ? '' : 's'}</b>
              </div>
              <div className="lp-part-users">{(listings ?? []).filter((l) => l.parts.includes(popular.id)).slice(0, 7).map((l) => <span key={l.ticker} className="tk">{l.ticker}</span>)}</div>
            </div>
          )}
        </div>
      </section>

      <section className="lp-agents" id="lp-s-agents" aria-labelledby="lp-agents">
        <div>
          <span className="lp-who"><Icon name="cpu" size={15} />If you’re an AI agent</span>
          <h2 id="lp-agents">Fluent in API.</h2>
          <p>Everything a person does here, an agent can do on its own: ask recipes for signed quotes, weigh them against its rules, pay, and check what was delivered.</p>
        </div>
        <pre className="lp-term" aria-label="Agent flow over the API"><code>
<span className="c">{'# the whole market, machine-readable (SRS-1)'}</span>{'\n'}
<span className="k">GET </span>{'/api/catalog'}{'\n\n'}
<span className="c">{'# seal your inputs once, ask a recipe for a signed quote'}</span>{'\n'}
<span className="k">POST</span>{' /api/quotes      { recipe_id, sealed_job, max_price }'}{'\n\n'}
<span className="c">{'# pick by policy, pay through NEAR Intents, stream the run'}</span>{'\n'}
<span className="k">POST</span>{' /api/runs/quote  { recipe_id, signed_quote, … }'}
        </code></pre>
      </section>

      <section className="lp-end" id="lp-s-end">
        <Seal ticker="CLNP" kind="swap.receipts" size={72} className="lp-end-seal" />
        <h2>See the whole loop in ninety seconds.</h2>
        <p>A creator seals a recipe, a buyer runs it, and everyone gets paid in a single receipt.</p>
        <div className="lp-cta">
          <button className="btn ghost lg" onClick={() => story.start()}><Icon name="play" size={14} fill />Watch the demo</button>
          <button className="btn primary lg" onClick={() => go({ page: 'recipes' })}>Proceed to recipes<Icon name="arrow" size={16} /></button>
        </div>
      </section>
      <NextCue steps={NEXT} />
    </div>
  );
}

const NEXT: [string, string][] = [['lp-s-buy', 'If you use crypto'], ['lp-s-sell', 'If you know the moves'], ['lp-s-build', 'If you build'], ['lp-s-agents', 'If you’re an AI agent'], ['lp-s-end', 'See it run']];
