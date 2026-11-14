import { Icon } from '../icons';
import { Tip } from '../ui';

/**
 * Documentation › Landscape: what this project adds, then where it sits among comparable offerings and how it would
 * use each one. The full notes, with sources, are in docs/LANDSCAPE.md.
 */

// ---------------------------------------------------------------- what this project adds: three movements, three notes each

const MOVEMENTS: { icon: string; title: string; line: string; items: { icon: string; name: string; line: string; proof: string }[] }[] = [
  {
    icon: 'lock', title: 'Keep the method secret', line: 'Sell what you know without showing it.',
    items: [
      { icon: 'lock', name: 'Sealed recipes', line: 'Buyers run a method they never see. The marketplace holds only ciphertext.', proof: 'Intel TDX on the live site' },
      { icon: 'link', name: 'Typed, swappable parts', line: 'Parts snap together by type, and any one can be swapped for a peer.', proof: 'SRS-1' },
      { icon: 'clock', name: 'Versions with notice', line: 'Changes wait out an on-chain notice. Every run keeps the version it paid for.', proof: 'model-checked' },
    ],
  },
  {
    icon: 'shieldCheck', title: 'Keep the promise', line: 'Know the price and the outcome before you pay.',
    items: [
      { icon: 'receipt', name: 'Signed quotes', line: 'A dry run on your sealed inputs, signed for you alone and good for one use.', proof: 'checked on-chain' },
      { icon: 'shield', name: 'Guaranteed outcomes', line: 'If a run falls short of its promise, the creator’s deposit pays the difference.', proof: 'TLA+ · Z3' },
      { icon: 'trend', name: 'Prices that follow demand', line: 'Busy recipes get dearer and quiet ones cheaper, always inside the creator’s band.', proof: 'proved' },
    ],
  },
  {
    icon: 'users', title: 'Pay everyone', line: 'Every builder, every run, one transaction.',
    items: [
      { icon: 'pie', name: 'One receipt', line: 'Part builders, the runner and the creator are paid in the same settlement.', proof: 'conservation proved' },
      { icon: 'refresh', name: 'Runs that survive crashes', line: 'A restarted runner picks up where it stopped. Nobody signs twice.', proof: 'crash-tested' },
      { icon: 'scale', name: 'A service, not a security', line: 'No shares, no dividends, no trading. Any wallet, anywhere.', proof: 'by design' },
    ],
  },
];

// ---------------------------------------------------------------- the landscape

type Status = 'built' | 'partly' | 'path' | 'reference';
const STATUS: Record<Status, { label: string; icon: string; tone: string; tip: string }> = {
  built: { label: 'Built in', icon: 'check', tone: 'built', tip: 'In this repository and tested' },
  partly: { label: 'Partly built', icon: 'sliders', tone: 'partly', tip: 'Some of it is in this repository' },
  path: { label: 'Next to integrate', icon: 'arrow', tone: 'path', tip: 'A designed integration, not built yet' },
  reference: { label: 'Reference', icon: 'flag', tone: 'reference', tip: 'Studied for its design; not used' },
};
type Layer = 'rails' | 'ai' | 'execution' | 'markets';
const LAYERS: { id: Layer; icon: string; name: string; line: string }[] = [
  { id: 'rails', icon: 'zap', name: 'NEAR rails', line: 'how money and calls move' },
  { id: 'ai', icon: 'sparkles', name: 'Private AI', line: 'models nobody can watch' },
  { id: 'execution', icon: 'cpu', name: 'Execution', line: 'where code runs' },
  { id: 'markets', icon: 'market', name: 'Agent markets', line: 'where agents buy' },
];

const OFFERINGS: { name: string; layer: Layer; status: Status; what: string; shares: string[]; use: string }[] = [
  { name: 'NEAR Intents', layer: 'rails', status: 'built', what: 'Cross-chain swaps, settled in batches by one verifier contract. Mainnet only.', shares: ['infrastructure we use'], use: 'In the local demo it pays for every run, carries the confidential swaps and settles atomic bundles. It has no testnet, so runs on the live site are paid directly.' },
  { name: 'NEAR AI Cloud', layer: 'ai', status: 'built', what: 'Private models in TEEs, attested on every request. In beta.', shares: ['private model calls'], use: 'The model behind every AI part. Each answer’s signature is checked before it’s used.' },
  { name: 'Phala Cloud (dstack)', layer: 'execution', status: 'built', what: 'Confidential VMs on Intel TDX, with a key service inside the VM and a hardware quote for every attestation.', shares: ['attested execution'], use: 'Hosts the live runner. Its keys never leave the VM, and each buyer’s browser verifies its TDX quote with Intel and checks the image it runs before sealing anything.' },
  { name: 'Shade Agents', layer: 'execution', status: 'partly', what: 'TEE agents that an on-chain contract admits after checking their attestation.', shares: ['attested runner'], use: 'The live runner uses the same stack (dstack on Intel TDX). Next, runners register the same way, with the contract checking the attestation instead of the owner.' },
  { name: 'Chainlink CRE', layer: 'execution', status: 'path', what: 'Workflows run by a network of nodes on cron, HTTP or chain events. EVM and Solana; confidential mode in private beta.', shares: ['triggers', 'confidential execution', 'agent payments'], use: 'A recipe could run as a confidential CRE workflow while quotes, guarantees and settlement stay here.' },
  { name: 'OutLayer', layer: 'execution', status: 'path', what: 'Attested Rust and WASM in Intel TDX, callable from NEAR contracts.', shares: ['attested execution', 'secrets'], use: 'Run closed-source parts as attested jobs, using its secrets for parts with API keys.' },
  { name: 'IronClaw', layer: 'execution', status: 'path', what: 'NEAR AI’s agent runtime, with a WASM sandbox and cron, event and webhook routines.', shares: ['triggers'], use: 'A buyer’s agent that asks for quotes and runs recipes on a schedule.' },
  { name: 'NEAR AI Agent Market', layer: 'markets', status: 'path', what: 'Agents bid on tasks; escrowed payment settles in NEAR.', shares: ['escrowed payment'], use: 'List recipes as services its agents can buy.' },
  { name: 'Venice', layer: 'ai', status: 'path', what: 'Private AI. Staked VVV buys capacity; DIEM is a dollar a day of credit.', shares: ['paying for compute'], use: 'Prepaid run credits, instead of paying run by run.' },
  { name: 'NEAR yield/resume', layer: 'rails', status: 'reference', what: 'A contract pauses for off-chain work, for up to about four minutes.', shares: ['waiting on off-chain work'], use: 'Too short for long runs, so runs checkpoint on-chain instead.' },
  { name: 'Olas Mech Marketplace', layer: 'markets', status: 'reference', what: 'Agents hire other agents’ tools, paid per request.', shares: ['pay-per-request services'], use: 'A model for agent-to-agent payment, on other chains.' },
  { name: 'Gelato Web3 Functions', layer: 'execution', status: 'reference', what: 'Serverless functions on time, event or webhook triggers, on EVM chains.', shares: ['scheduled automation'], use: 'A model for triggers. Not on NEAR.' },
];
const ORDER: Status[] = ['built', 'partly', 'path', 'reference'];

export function Landscape() {
  return (
    <div className="grid ls">
      <section className="panel ls-hero" aria-labelledby="ls-adds">
        <div className="body">
          <div className="ls-kicker"><Icon name="sparkles" size={14} />Where this project adds value</div>
          <h2 id="ls-adds" className="ls-title">Others run workflows. <em>We make them safe to sell.</em></h2>
          <p className="ls-lede">The place a sealed workflow is bought, guaranteed and paid for, built on infrastructure that already works.</p>
          <div className="ls-moves">
            {MOVEMENTS.map((m, i) => (
              <div key={m.title} className="ls-move">
                <div className="ls-move-hd"><span className="ls-num">{String(i + 1).padStart(2, '0')}</span><span className="ls-move-ic"><Icon name={m.icon} size={18} /></span><div><b>{m.title}</b><span>{m.line}</span></div></div>
                {m.items.map((it) => (
                  <div key={it.name} className="ls-item">
                    <Icon name={it.icon} size={16} />
                    <div><b>{it.name}</b><p>{it.line}</p></div>
                    <span className="ls-proof">{it.proof}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="panel" aria-labelledby="ls-map">
        <header><Icon name="globe" size={16} className="hd-ic" /><h2 id="ls-map">Landscape</h2><Tip wide>Comparable offerings, what each shares with this project, and how this project would use it. Sources and details: docs/LANDSCAPE.md.</Tip></header>
        <div className="body grid" style={{ gap: 18 }}>
          <p className="ls-lede" style={{ margin: 0 }}>Not another workflow engine. A layer on top of the ones that exist: <b>integrate, don’t compete.</b></p>

          <div className="ls-stack" role="img" aria-label="Sealed Recipes sits on top of payment rails, private AI, execution and agent markets, and uses them">
            <div className="ls-top">
              <span className="ls-top-ic"><Icon name="vault" size={18} /></span>
              <div><b>Sealed Recipes</b><span>the market and settlement layer for sealed workflows</span></div>
              <div className="ls-top-pills"><span>quotes</span><span>guarantees</span><span>one receipt</span></div>
            </div>
            <div className="ls-lanes">
              {LAYERS.map((ly) => (
                <div key={ly.id} className="ls-lane">
                  <div className="ls-lane-hd"><Icon name={ly.icon} size={15} /><b>{ly.name}</b><span>{ly.line}</span></div>
                  {OFFERINGS.filter((o) => o.layer === ly.id).sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status)).map((o) => (
                    <a key={o.name} href={'#ls-' + o.name.replace(/\W+/g, '-')} className={'ls-chip ' + STATUS[o.status].tone} onClick={(e) => { e.preventDefault(); document.getElementById('ls-' + o.name.replace(/\W+/g, '-'))?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }}>
                      <i />{o.name}
                    </a>
                  ))}
                </div>
              ))}
            </div>
            <div className="ls-legend">{ORDER.map((s) => <span key={s} className={'ls-chip static ' + STATUS[s].tone} title={STATUS[s].tip}><i />{STATUS[s].label}</span>)}</div>
          </div>

          {ORDER.map((st) => {
            const list = OFFERINGS.filter((o) => o.status === st);
            return (
              <div key={st} className="ls-group">
                <div className={'ls-group-hd ' + STATUS[st].tone}><span><Icon name={STATUS[st].icon} size={14} /></span><b>{STATUS[st].label}</b><em>{STATUS[st].tip}</em></div>
                <div className="ls-cards">
                  {list.map((o) => {
                    const ly = LAYERS.find((l) => l.id === o.layer)!;
                    return (
                      <article key={o.name} id={'ls-' + o.name.replace(/\W+/g, '-')} className={'ls-card ' + STATUS[st].tone}>
                        <div className="ls-card-hd"><span className="ls-card-ic"><Icon name={ly.icon} size={16} /></span><b>{o.name}</b><span className="ls-layer">{ly.name}</span></div>
                        <p className="ls-what">{o.what}</p>
                        <div className="ls-shares"><span>shares</span>{o.shares.map((x) => <em key={x}>{x}</em>)}</div>
                        <div className="ls-use" title="How this project uses it"><Icon name="arrow" size={13} /><p>{o.use}</p></div>
                      </article>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
