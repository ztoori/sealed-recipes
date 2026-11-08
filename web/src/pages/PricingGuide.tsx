import { useEffect, useMemo, useRef, useState } from 'react';
import { demoMs } from '../pace';
import { nextPrice } from '../../../core/src/pricing';
import { useApp } from '../App';
import { Icon } from '../icons';
import { ForAgents, GuideHero, GuideSection, Tiles } from './guide-kit';

/**
 * Documentation › Price & demand: how a recipe's price per run follows its own demand inside the creator's band.
 * The playground runs the contract's own rule (core/src/pricing.ts, the mirror of pricing.rs, proved in verification/smt).
 */
const PATTERNS: Record<string, { label: string; icon: string; runs: number[] }> = {
  rush: { label: 'A rush, then quiet', icon: 'zap', runs: [3, 6, 6, 6, 5, 4, 3, 1, 0, 0, 0, 2] },
  steady: { label: 'Steady demand', icon: 'refresh', runs: [3, 3, 4, 3, 3, 2, 3, 3, 4, 3, 3, 3] },
  launch: { label: 'Slow launch', icon: 'trend', runs: [0, 0, 1, 1, 2, 3, 4, 5, 6, 6, 6, 6] },
  idle: { label: 'Nobody comes', icon: 'clock', runs: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
};
const FLOOR = 300_000n, CEIL = 1_500_000n, START = 700_000n;
const $ = (u: bigint | number) => '$' + (Number(u) / 1e6).toFixed(2);

function Playground() {
  const [pattern, setPattern] = useState<keyof typeof PATTERNS>('rush');
  const [target, setTarget] = useState(3);
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const { story } = useApp();
  // demo story, chapter 5: a rush, a slow launch, then nobody comes
  useEffect(() => {
    if (story.step !== 5) return;
    const seq: (keyof typeof PATTERNS)[] = ['rush', 'launch', 'idle'];
    const ts = [setTimeout(() => box.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), demoMs(1200)),
      ...seq.map((k, i) => setTimeout(() => { setPattern(k); setHover(null); }, demoMs(2200 + i * 3200)))];
    return () => ts.forEach(clearTimeout);
  }, [story.step, story.run]);
  const runs = PATTERNS[pattern].runs;
  const prices = useMemo(() => {
    const out: bigint[] = [START];
    for (const r of runs) out.push(nextPrice(out[out.length - 1], BigInt(r), target, FLOOR, CEIL) ?? out[out.length - 1]);
    return out;
  }, [pattern, target]);
  const W = 1000, H = 280, L = 70, R = 20, T = 22, B = 34, n = runs.length;
  const x = (i: number) => L + ((W - L - R) * (i + 0.5)) / n;
  const yP = (p: bigint) => T + (H - T - B) * (1 - (Number(p) - 200_000) / (1_600_000 - 200_000));
  const maxRuns = 8, yR = (r: number) => H - B - ((H - T - B) * 0.45 * r) / maxRuns;
  const i = hover ?? n - 1;
  const change = Number(prices[i + 1] - prices[i]) / Number(prices[i]);
  return (
    <div className="pg" ref={box}>
      <div className="pg-controls">
        <div className="pg-patterns" role="radiogroup" aria-label="Demand">
          {Object.entries(PATTERNS).map(([k, p]) => <button key={k} role="radio" aria-checked={k === pattern} className={k === pattern ? 'on' : ''} onClick={() => { setPattern(k as keyof typeof PATTERNS); setHover(null); }}><Icon name={p.icon} size={14} />{p.label}</button>)}
        </div>
        <label className="pg-target">Target runs a period <input type="range" min={1} max={6} value={target} onChange={(e) => setTarget(Number(e.target.value))} /><b>{target}</b></label>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="pg-chart" role="img" aria-label={`Price over ${n} periods with ${PATTERNS[pattern].label.toLowerCase()}`} onMouseLeave={() => setHover(null)}>
        <rect x={L} y={yP(CEIL)} width={W - L - R} height={yP(FLOOR) - yP(CEIL)} fill="rgba(240,180,76,.06)" />
        <line x1={L} x2={W - R} y1={yP(CEIL)} y2={yP(CEIL)} stroke="#7a5a22" strokeDasharray="4 4" /><text x={L - 6} y={yP(CEIL) + 4} textAnchor="end" className="pg-ax">{$(CEIL)}</text>
        <line x1={L} x2={W - R} y1={yP(FLOOR)} y2={yP(FLOOR)} stroke="#7a5a22" strokeDasharray="4 4" /><text x={L - 6} y={yP(FLOOR) + 4} textAnchor="end" className="pg-ax">{$(FLOOR)}</text>
        <text x={L - 6} y={yP(CEIL) + 17} textAnchor="end" className="pg-ax">ceiling</text><text x={L - 6} y={yP(FLOOR) + 17} textAnchor="end" className="pg-ax">floor</text>
        <line x1={L} x2={W - R} y1={yR(target)} y2={yR(target)} stroke="#3ccb9a" strokeDasharray="2 4" opacity={0.7} />
        <text x={L + 4} y={yR(target) - 4} className="pg-ax" fill="#3ccb9a">target</text>
        {runs.map((r, k) => {
          const bw = ((W - L - R) / n) * 0.5;
          return (
            <g key={k} onMouseEnter={() => setHover(k)}>
              <rect x={x(k) - bw} y={T} width={bw * 2} height={H - T - B} fill="transparent" />
              <rect x={x(k) - bw / 2} y={yR(r)} width={bw} height={H - B - yR(r)} rx={3} fill={r > target ? '#f0b44c' : r < target ? '#56658a' : '#3ccb9a'} opacity={hover === null || hover === k ? 0.85 : 0.35} />
              <text x={x(k)} y={H - 14} textAnchor="middle" className="pg-ax">{k + 1}</text>
            </g>
          );
        })}
        <polyline fill="none" stroke="#ffd58a" strokeWidth={2.4} strokeLinejoin="round" points={prices.slice(1).map((p, k) => `${x(k)},${yP(p)}`).join(' ')} />
        {prices.slice(1).map((p, k) => <circle key={k} cx={x(k)} cy={yP(p)} r={hover === k ? 5 : 3} fill="#ffd58a" />)}
        <text x={L} y={H - 2} className="pg-ax">period</text>
      </svg>
      <div className="pg-read">
        <span>Period {i + 1}</span>
        <b>{runs[i]} paid run{runs[i] === 1 ? '' : 's'}</b><span>against a target of {target}</span>
        <Icon name="arrow" size={14} />
        <b className={change > 0 ? 'up' : change < 0 ? 'down' : ''}>{change > 0 ? '+' : ''}{(change * 100).toFixed(1)}%</b>
        <span>{$(prices[i])} → {$(prices[i + 1])}{prices[i + 1] === FLOOR ? ' (the floor)' : prices[i + 1] === CEIL ? ' (the ceiling)' : ''}</span>
      </div>
      <p className="pg-note">This chart runs the contract’s own pricing function. Bars are paid runs; the line is the price the next period starts at. Point at a period to read it.</p>
    </div>
  );
}

export function PricingGuide() {
  const { go } = useApp();
  return (
    <div className="grid">
      <GuideHero kicker="Price & demand" icon="trend" title="Prices that listen." accent="Quotes that hold."
        lede="There is no price list. Each recipe’s price follows its own demand, inside a band its creator sets, and the quote you accept locks the price you saw.">
        <button className="btn primary" onClick={() => go({ page: 'recipes' })}><Icon name="market" size={15} />See live prices</button>
      </GuideHero>

      <GuideSection n={1} icon="scale" title="The rule, in one breath" line="At the end of every period, the contract compares paid runs with the creator’s target.">
        <Tiles items={[
          { icon: 'zap', title: 'Busier than the target', line: 'The price rises, by up to 12.5% a period.', tag: 'up' },
          { icon: 'check', title: 'Right on target', line: 'The price stays where it is.', tag: 'steady' },
          { icon: 'clock', title: 'Quieter than the target', line: 'The price falls, by up to 12.5% a period.', tag: 'down' },
          { icon: 'shield', title: 'Always inside the band', line: 'Never below the floor, never above the ceiling.', tag: 'bounded' },
        ]} />
        <div className="g-formula">
          <code>used = min(runs, 2 × target)</code>
          <code>next price = price × (1 ± |used − target| ÷ (8 × target))</code>
          <code>then kept between floor and ceiling</code>
          <span>Ethereum’s base-fee rule (EIP-1559), applied per recipe, on-chain.</span>
        </div>
      </GuideSection>

      <GuideSection n={2} icon="sliders" title="Try it" line="Pick a demand pattern and a target, and watch the price find its level.">
        <Playground />
      </GuideSection>

      <GuideSection n={3} icon="users" title="Who decides what" line="Three parties, three different levers. Nobody can move a price they don’t own.">
        <Tiles tone="wax" items={[
          { icon: 'compose', title: 'The creator', line: 'Sets the starting price, the floor, the ceiling and the target. Only the creator can change the band, on-chain.' },
          { icon: 'market', title: 'The market', line: 'Paid runs are the only input. Quotes that nobody pays for don’t count.' },
          { icon: 'vault', title: 'The contract', line: 'Applies the rule when a period ends: an hour on mainnet, two minutes in this demo. Idle periods catch up on the next run.' },
          { icon: 'user', title: 'The buyer', line: 'Sees the price before asking, can cap it with a max price, and gets it locked in a signed quote.' },
        ]} />
      </GuideSection>

      <GuideSection n={4} icon="shieldCheck" title="What a buyer can count on" line="Prices move. Promises don’t.">
        <Tiles tone="gain" items={[
          { icon: 'receipt', title: 'The quote locks it', line: 'Pay with a signed quote and you pay its price, even if the market moves before you do.', tag: 'signed' },
          { icon: 'sliders', title: 'Your cap is law', line: 'Set a max price and recipes above it aren’t even asked. The contract refuses to charge more.', tag: 'enforced on-chain' },
          { icon: 'pie', title: 'Every price settles', line: 'The floor must cover every part fee, the runner and the protocol, so any price the market reaches still pays everyone.', tag: 'checked at publish' },
          { icon: 'check', title: 'Proved, not promised', line: 'Bounds, direction and monotonicity are proved with Z3 for every input; the contract and this page share the same test vectors.', tag: 'Z3' },
        ]} />
      </GuideSection>

      <ForAgents rows={[
        ['Listing fields', <><code>price_per_run</code>, <code>pricing.price_floor</code>, <code>pricing.price_ceiling</code>, <code>pricing.target_runs</code> (USDC, 6 decimals)</>],
        ['Live price', <><code>GET /api/listings</code> → <code>record.pricePerRun</code>, with this period’s runs and history</>],
        ['Cap the price', <><code>max_price</code> on a quote request; recipes above it don’t quote</>],
        ['Lock the price', <>the signed quote carries <code>price</code>; the contract checks it against the band and your cap</>],
        ['Reproduce it', <><code>npm run test:pricing</code>: four buyers in one period lift the price 12.5%; idle periods bring it back</>],
      ]} />
    </div>
  );
}
