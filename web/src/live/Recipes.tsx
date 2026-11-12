import { useState } from 'react';
import { short } from '../api';
import { CAT, Icon, RESULT_LABEL, recipeLook } from '../icons';
import { partCat, prettyPart } from '../parts';
import { Empty, Head, Seal, Stat, Tip } from '../ui';
import { accUrl, tusdc, txUrl, useLive, type Listing } from './ctx';

/**
 * Recipes on the live contract, laid out like the guided demo's Recipes page (pages/Recipes.tsx): a searchable list
 * and the selected recipe's page. Every figure is the contract's own record (get_recipe on NEAR testnet).
 */
const RISK_TIP = 'Withdrawal risk: could this recipe be rebuilt if a part’s model or service disappeared? Open weights or bundled code: low. Remote services: medium. Closed models: high (SRS-1 §2.1).';
const price = (l: Listing) => l.onchain?.price_per_run ?? l.price_per_run;

export function Recipes({ ticker: wanted }: { ticker?: string }) {
  const { go, listings } = useLive();
  const [q, setQ] = useState('');
  const ticker = wanted && listings?.some((l) => l.ticker === wanted) ? wanted : listings?.[0]?.ticker;
  const s = q.trim().toLowerCase();
  const shown = (listings ?? []).filter((l) => !s || [l.ticker, l.name, l.description, l.creator, ...l.parts.map((p) => p.split('@')[0])].join(' ').toLowerCase().includes(s));
  const l = listings?.find((x) => x.ticker === ticker);
  return (
    <div className="grid ex">
      <section className="rail" aria-label="Find a recipe">
        <label className="search-wrap"><Icon name="search" size={16} /><input className="search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search recipes, creators, parts" aria-label="Search recipes" /></label>
        <div className="rail-scroll">
          <div className="listhead">{q ? `${shown.length} matching` : 'Live on testnet'}<span className="count">{listings?.length ?? 0}</span></div>
          {!listings && <div className="row muted small" style={{ padding: 10 }}><span className="spinner" />Reading the contract</div>}
          <ul className="rlist">
            {shown.map((x) => (
              <li key={x.ticker} className={'rcp' + (x.ticker === ticker ? ' sel' : '')}>
                <button className="pick" onClick={() => go({ page: 'recipes', ticker: x.ticker })} aria-current={x.ticker === ticker ? 'true' : undefined}>
                  <Seal ticker={x.ticker} kind={x.output_type} size={38} />
                  <span className="nm"><b>{x.name}</b><span className="sub"><span className="tk">{x.ticker}</span>by {x.creator.replace(/\.testnet$/, '')}</span></span>
                  <span className="px"><b>{tusdc(price(x))}</b><span className="trend flat">tUSDC</span></span>
                </button>
              </li>
            ))}
          </ul>
          {listings?.length === 0 && <Empty icon="market">No recipes are published on this contract yet.</Empty>}
          {listings && listings.length > 0 && !shown.length && <Empty icon="search">Nothing matches “{q}”.</Empty>}
        </div>
      </section>
      <section className="grid detail" style={{ minWidth: 0 }}>
        {l ? <RecipeDetail key={l.ticker} l={l} /> : listings && <div className="panel body muted">Pick a recipe.</div>}
      </section>
    </div>
  );
}

function RecipeDetail({ l }: { l: Listing }) {
  const { go, mode } = useLive();
  const c = l.onchain;
  const runs = Number(c?.runs ?? 0), failed = Number(c?.failed ?? 0), aborted = Number(c?.aborted ?? 0);
  const promised = Number(c?.promised_total ?? 0), delivered = Number(c?.delivered_total ?? 0);
  const kept = promised > 0 ? delivered / promised : null;
  const fixed = !c?.price_floor || c.price_floor === c.price_ceiling;
  return (
    <>
      <div className="panel hero">
        <div className="hero-main">
          <Seal ticker={l.ticker} kind={l.output_type} size={112} className="hero-seal" />
          <div className="hero-tx">
            <div className="hero-meta"><span className="tk lg">{l.ticker}</span><span>by <a href={accUrl(l.creator)} target="_blank" rel="noreferrer"><b>{l.creator}</b></a></span><span className="ver">v{c?.version ?? 1}</span></div>
            <h1 className="listing-name">{l.name}</h1>
            <p className="lede">{l.description}</p>
            <div className="tags">
              {RESULT_LABEL[l.output_type] && <span className="tag"><Icon name={recipeLook(l.ticker, l.output_type).icon} size={13} />{RESULT_LABEL[l.output_type]}</span>}
              <span className={'tag risk-' + l.risk}><i className="dot" />{l.risk} risk<Tip>{RISK_TIP}</Tip></span>
              {l.privacy === 'confidential' && <span className="tag sealed"><Icon name="lock" size={13} />Confidential</span>}
              <span className="tag"><Icon name="eye" size={13} />Reads mainnet, read-only</span>
            </div>
          </div>
          <div className="hero-buy">
            <div className="bigpx">{tusdc(price(l))}</div>
            <div className="per">tUSDC per run <Tip>{fixed ? 'Fixed by the creator.' : `Follows demand inside ${tusdc(c!.price_floor)}–${tusdc(c!.price_ceiling)} tUSDC. A quote locks it.`} tUSDC is a test token with no value.</Tip></div>
            <button id="get-quote" className="btn primary lg" onClick={() => go({ page: 'quote', ticker: l.ticker })}><Icon name="lock" size={16} />Get a quote</button>
          </div>
        </div>
        <div className="stats">
          <Stat icon="check" value={runs} label={runs === 1 ? 'paid run' : 'paid runs'} tip="Settled on-chain by the contract." />
          <Stat icon="target" value={kept == null ? 'n/a' : `${Math.round(kept * 100)}%`} label="of promise kept" tone={kept == null ? undefined : kept >= 1 ? 'gain' : 'loss'} tip="Value delivered against the value promised in signed quotes. Reports promise no amount, so this is n/a for them." />
          <Stat icon="shield" value={tusdc(c?.bond_available, 2)} label="guarantee" tone="wax" tip="The creator’s collateral, in tUSDC. If a run delivers less than its signed promise, the buyer is paid the shortfall from it, in the same settlement." />
          <Stat icon="receipt" value={tusdc(c?.revenue, 2)} label="billed (tUSDC)" />
        </div>
      </div>

      <div className="panel">
        <Head icon="box" title="Inside" tip="Everyone sees which parts a recipe uses and what the buyer fills in. How they are wired, their settings and prompts are sealed to the runner.">
          <span className="spacer" /><span className="pill sealed"><Icon name="lock" size={12} />wiring sealed</span>
        </Head>
        <div className="body grid" style={{ gap: 12 }}>
          <div className="pipeline">
            <span className="pipe-form" title={'Buyer fills in: ' + l.form.map((f) => f.label).join(', ')}><Icon name="user" size={15} />{l.form.length} input{l.form.length === 1 ? '' : 's'}</span>
            {l.parts.map((b, i) => {
              const cc = CAT[partCat(b)] ?? CAT.transform;
              return <span key={b + i} className="blk" style={{ ['--cc' as any]: cc.color }} title={`${cc.label} · ${b}`}><Icon name={cc.icon} size={15} /><span>{prettyPart(b)}</span></span>;
            })}
            <span className="pipe-out" title="Result for the buyer"><Icon name="check" size={15} /></span>
          </div>
          {c?.sealed_hash && <div className="sealed-box"><Icon name="lock" size={14} /><span>On-chain commitment</span><span className="hash">{short(c.sealed_hash, 14, 8)}</span></div>}
        </div>
      </div>

      <div className="grid cards">
        <div className="panel">
          <Head icon="clock" title="Track record" tip="Read from the contract on NEAR testnet." />
          <dl className="kv body">
            <dt><Icon name="check" size={14} />Successful</dt><dd>{runs}</dd>
            <dt><Icon name="refresh" size={14} />Refunded</dt><dd>{failed}</dd>
            <dt><Icon name="x" size={14} />Aborted</dt><dd>{aborted}</dd>
            <dt><Icon name="shield" size={14} />Paid to buyers</dt><dd>{tusdc(c?.compensated_total, 2)}</dd>
            <dt><Icon name="receipt" size={14} />Settles</dt><dd>{c?.settle_mode === 'checkpoint' ? 'per part' : 'once per run'}</dd>
          </dl>
        </div>
        <div className="panel">
          <Head icon="trend" title="Price" tip={fixed ? 'A fixed price set by the creator.' : 'More paid runs than the target in a period raise the price up to 12.5%, fewer lower it, always inside the band.'} />
          <dl className="kv body">
            <dt>Now</dt><dd><b>{tusdc(price(l), 4)}</b> tUSDC</dd>
            <dt>Band</dt><dd>{fixed ? 'fixed' : `${tusdc(c!.price_floor)}–${tusdc(c!.price_ceiling)}`}</dd>
            {!fixed && <><dt>This period</dt><dd>{String(c?.period_runs ?? 0)} of {c?.target_runs ?? '–'} runs</dd></>}
          </dl>
        </div>
        <div className="panel">
          <Head icon="vault" title="On-chain" tip="Open any of these on the testnet explorer." />
          <dl className="kv body">
            <dt>Contract</dt><dd><a className="hash" href={accUrl(mode?.contract_id ?? '')} target="_blank" rel="noreferrer">{mode?.contract_id}</a></dd>
            <dt>Runner</dt><dd><a className="hash" href={accUrl(mode?.runner_id ?? '')} target="_blank" rel="noreferrer">{mode?.runner_id}</a></dd>
            <dt>Paid in</dt><dd><a className="hash" href={accUrl(mode?.payment_token ?? '')} target="_blank" rel="noreferrer">{mode?.payment_token}</a></dd>
            {l.publish_tx && <><dt>Published</dt><dd><a className="hash" href={txUrl(l.publish_tx)} target="_blank" rel="noreferrer">{short(l.publish_tx, 8, 6)}</a></dd></>}
          </dl>
        </div>
      </div>
    </>
  );
}
