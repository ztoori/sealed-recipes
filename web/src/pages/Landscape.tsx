import { Icon } from '../icons';
import { Tip } from '../ui';
/** Where this project sits
 next to comparable offerings: overlap, integration path, status. Source: docs/LANDSCAPE.md */
type Status = 'built' | 'partly' | 'path' | 'n/a';
const STATUS: Record<Status, [string, string]> = {
  built: ['built', 'ok'],
  partly: ['partly', 'warn'],
  path: ['integration path (not built)', ''],
  'n/a': ['reference only', ''],
};

const ROWS: { name: string; what: string; overlap: string; integrate: string; status: Status }[] = [
  { name: 'Chainlink CRE', what: 'Workflows run by a Workflow DON on triggers (cron, HTTP, chain events), with consensus on results. Confidential Workflows (TEE) in private beta. EVM chains and Solana; no NEAR support announced.', overlap: 'Triggers, confidential execution, secrets, agents paying per workflow (x402).', integrate: 'Pluggable execution backend: a recipe runs as a CRE confidential workflow; quotes, bonds and settlement stay in this contract.', status: 'path' },
  { name: 'OutLayer (FastNEAR)', what: 'Rust/WASM in Intel TDX with attestation, called from NEAR contracts via yield/resume or over HTTPS. Secrets, key derivation, payment keys. Third-party platform.', overlap: 'Attested execution and secrets for single functions.', integrate: 'Run untrusted or closed-source parts as attested OutLayer jobs; use its secrets for parts with API keys.', status: 'path' },
  { name: 'Shade Agents', what: 'TEE agents (dstack, Phala by default) registered by an agent contract that checks attestation on-chain; multichain signing via Chain Signatures.', overlap: 'The attested-runner pattern used here.', integrate: 'Register runners through on-chain attestation instead of owner approval; Chain Signatures for multichain parts.', status: 'partly' },
  { name: 'NEAR AI Cloud', what: 'Private inference in TEEs (Intel TDX + NVIDIA) with per-request attestation. Beta.', overlap: 'Private model calls.', integrate: 'Already the model backend for AI parts; responses are signature-checked.', status: 'built' },
  { name: 'IronClaw', what: "NEAR AI's agent runtime: WASM tool sandbox, routines (cron, events, webhooks), deployable in TEEs.", overlap: 'Triggers for a single agent.', integrate: 'Buyer-side trigger that asks for quotes and runs recipes on a schedule.', status: 'path' },
  { name: 'NEAR AI Agent Market', what: 'Agents bid on tasks; escrowed payment settles in NEAR; built on NEAR Intents.', overlap: 'Escrowed payment for an agent’s service.', integrate: 'List recipes as Agent Market services so its agents can buy runs.', status: 'path' },
  { name: 'NEAR Intents', what: 'Cross-chain swaps settled by the verifier contract, which applies a batch of intents together.', overlap: 'None: infrastructure used here.', integrate: 'Payment rail (1Click delivers the run price), confidential swaps, and atomic swap bundles (one signed batch: every swap and the payout, or nothing; local stand-in of the Verifier, npm run test:atomic).', status: 'built' },
  { name: 'NEAR yield/resume', what: 'Contracts pause until an external service resumes them, up to about 200 blocks (~4 min).', overlap: 'Waiting on off-chain work.', integrate: 'Fine for short calls; long workflows here use durable runs with on-chain checkpoints.', status: 'n/a' },
  { name: 'Olas Mech Marketplace', what: 'Agents hire other agents’ tools per request (native token, OLAS, USDC or subscription).', overlap: 'Pay-per-request agent services.', integrate: 'Different chains; reference design for agent-to-agent payment.', status: 'n/a' },
  { name: 'Gelato Web3 Functions', what: 'Serverless functions on time, on-chain event or webhook triggers, with secrets and state; EVM chains.', overlap: 'Triggers and scheduled automation.', integrate: 'Not on NEAR; reference for the trigger model.', status: 'n/a' },
  { name: 'Venice (VVV / DIEM)', what: 'Private AI platform. Staking VVV grants inference capacity; DIEM = $1/day of API credit. Strongest privacy mode uses TEEs, including via NEAR AI.', overlap: 'Paying for compute; private inference.', integrate: 'Prepaid run credits for a recipe instead of paying per run.', status: 'path' },
];

const VALUE = [
  ['Sealed recipes sold to third parties', 'Buyers pay to run a workflow they never see; the marketplace stores only ciphertext. (Requires the runner in a TEE; local mode has none.)'],
  ['Signed quotes', 'A recipe quotes from a dry run on the buyer’s sealed inputs; quotes are signed, bound to buyer, inputs and version, and single use.'],
  ['Guaranteed outcomes', 'The creator’s guarantee deposit pays any shortfall up to the quoted cover. Deposit safety is model-checked (TLA+) and its arithmetic proved (Z3), on models tied to the code by conformance tests.'],
  ['One receipt, every contributor', 'Part authors, runner and creator paid in the same settlement, with conservation proved.'],
  ['SRS-1 typed parts', 'Swappable parts with typed ports, capability and resource limits, and model/harness disclosure with a withdrawal-risk label.'],
  ['Market-driven prices', 'Each recipe’s price per run follows its own demand inside a creator-set band (EIP-1559 rule, proved); quotes lock the price.'],
  ['No investment features', 'Buyers pay for a service, creators post collateral. No shares, dividends or trading, so any wallet anywhere can use it.'],
  ['Durable runs, partial settlement', 'Runs survive runner crashes with exactly-once deposits; in checkpoint mode each part is paid when it finishes.'],
  ['Versions with notice', 'Updates take effect after an on-chain notice period; each run executes the version it paid for.'],
];

const AHEAD = [
  ['Chainlink CRE', 'Decentralized execution with DON consensus (this project uses one attested runner), many triggers, a secrets vault, and far greater maturity.'],
  ['IronClaw', 'Routines (cron, events, webhooks) and a WASM sandbox for untrusted tools; this project has no triggers and runs parts as reviewed in-process code.'],
  ['OutLayer', 'Production attested execution with secrets, key derivation and a WASM sandbox, callable from NEAR contracts today.'],
];

export function Landscape() {
  return (
    <div className="grid">
      <div className="panel">
        <header><Icon name="globe" size={16} className="hd-ic" /><h2>Landscape</h2><Tip wide>Comparable offerings, how this project would use them, and what is built here (docs/LANDSCAPE.md).</Tip></header>
        <div className="body" style={{ paddingBottom: 0 }}>
          <p className="lede" style={{ margin: 0 }}>Not a workflow engine: the market and settlement layer for sealed workflows others pay to run. Integrate, don’t compete.</p>
        </div>
        <div className="body" style={{ overflowX: 'auto' }}>
          <table className="small landscape">
            <thead><tr><th style={{ width: '13%' }}>Offering</th><th style={{ width: '30%' }}>What it does</th><th style={{ width: '18%' }}>Overlap</th><th style={{ width: '27%' }}>How this project would use it</th><th>Status here</th></tr></thead>
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.name} style={{ verticalAlign: 'top' }}>
                  <td><b>{r.name}</b></td>
                  <td>{r.what}</td>
                  <td className="muted">{r.overlap}</td>
                  <td>{r.integrate}</td>
                  <td><span className={'pill ' + STATUS[r.status][1]}>{STATUS[r.status][0]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', alignItems: 'start' }}>
        <div className="panel">
          <header><Icon name="sparkles" size={16} className="hd-ic" /><h2>Where this project adds value</h2></header>
          <div className="body">
            <div className="value-list">{VALUE.map(([k, v]) => <div key={k}><Icon name="check" size={16} /><div><b>{k}</b><p>{v}</p></div></div>)}</div>
          </div>
        </div>
        <div className="panel">
          <header><Icon name="flag" size={16} className="hd-ic" /><h2>Where others are ahead</h2></header>
          <div className="body">
            <div className="value-list ahead">{AHEAD.map(([k, v]) => <div key={k}><Icon name="arrow" size={16} /><div><b>{k}</b><p>{v}</p></div></div>)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
