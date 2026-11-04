/** Where this project sits next to comparable offerings: overlap, integration path, status. Source: docs/LANDSCAPE.md */
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
  { name: 'IronClaw', what: "NEAR AI's agent runtime: WASM tool sandbox, routines (cron, events, webhooks), deployable in TEEs.", overlap: 'Triggers for a single agent.', integrate: 'Buyer-side trigger that posts jobs on a schedule.', status: 'path' },
  { name: 'NEAR AI Agent Market', what: 'Agents bid on tasks; escrowed payment settles in NEAR; built on NEAR Intents.', overlap: 'Post a job, providers compete, escrowed payment.', integrate: 'Distribution channel: list recipes as services; this contract handles sealed recipes, bonded quotes and per-part settlement.', status: 'path' },
  { name: 'NEAR Intents', what: 'Cross-chain swaps settled by the verifier contract, which applies a batch of intents together.', overlap: 'None: infrastructure used here.', integrate: 'Payment rail (1Click delivers the run price), confidential swaps, and atomic swap bundles (one signed batch: every swap and the payout, or nothing; local stand-in of the Verifier, npm run test:atomic).', status: 'built' },
  { name: 'NEAR yield/resume', what: 'Contracts pause until an external service resumes them, up to about 200 blocks (~4 min).', overlap: 'Waiting on off-chain work.', integrate: 'Fine for short calls; long workflows here use durable runs with on-chain checkpoints.', status: 'n/a' },
  { name: 'Olas Mech Marketplace', what: 'Agents hire other agents’ tools per request (native token, OLAS, USDC or subscription).', overlap: 'Pay-per-request agent services.', integrate: 'Different chains; reference design for agent-to-agent payment.', status: 'n/a' },
  { name: 'Gelato Web3 Functions', what: 'Serverless functions on time, on-chain event or webhook triggers, with secrets and state; EVM chains.', overlap: 'Triggers and scheduled automation.', integrate: 'Not on NEAR; reference for the trigger model.', status: 'n/a' },
  { name: 'Venice (VVV / DIEM)', what: 'Private AI platform. Staking VVV grants inference capacity; DIEM = $1/day of API credit. Strongest privacy mode uses TEEs, including via NEAR AI.', overlap: 'Paying for compute; private inference.', integrate: 'Prepaid run credits for a recipe instead of paying per run.', status: 'path' },
];

const VALUE = [
  ['Sealed recipes sold to third parties', 'Buyers pay to run a workflow they never see; the marketplace stores only ciphertext. (Requires the runner in a TEE; local mode has none.)'],
  ['Competing signed quotes', 'Recipes implementing a job type quote from dry runs; quotes are signed, bound to buyer, job and version, and single use.'],
  ['Bonded outcome guarantees', 'The bond pays any shortfall up to the quoted cover. Bond safety is model-checked (TLA+) and its arithmetic proved (Z3), on models tied to the code by conformance tests.'],
  ['One receipt, every contributor', 'Part authors, runner, creator and shareholders paid in the same settlement, with conservation proved.'],
  ['FRS-1 typed parts', 'Swappable parts with typed ports, capability and resource limits, and model/harness disclosure with a withdrawal-risk label.'],
  ['Revenue shares', 'Optional creator funding, traded in uniform-price batch auctions.'],
  ['Durable runs, partial settlement', 'Runs survive runner crashes with exactly-once deposits; in checkpoint mode each part is paid when it finishes.'],
  ['Versions with notice', 'Updates take effect after an on-chain notice period; each run executes the version it paid for.'],
];

const AHEAD = [
  ['Chainlink CRE', 'Decentralized execution with DON consensus (this project uses one attested runner), many triggers, a secrets vault, and far greater maturity.'],
  ['NEAR AI Agent Market', 'A live network of agents and jobs; this project runs against a local mirror of its contract and is not deployed.'],
  ['IronClaw', 'Routines (cron, events, webhooks) and a WASM sandbox for untrusted tools; this project has no triggers and runs parts as reviewed in-process code.'],
  ['OutLayer', 'Production attested execution with secrets, key derivation and a WASM sandbox, callable from NEAR contracts today.'],
];

export function Landscape() {
  return (
    <div className="grid">
      <div className="panel">
        <header><h2>Landscape</h2><span className="small muted">comparable offerings, how this project would use them, and what is built here · docs/LANDSCAPE.md</span></header>
        <div className="body small" style={{ paddingBottom: 0 }}>
          Fungible Recipes is not a workflow engine. It is the market and settlement layer for sealed workflows that other people pay to run. Where others already provide a piece, the plan is to integrate, not compete.
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
          <header><h2>Where this project adds value</h2><span className="small muted">as far as the others' public docs show</span></header>
          <div className="body">
            <dl className="kv">{VALUE.map(([k, v]) => [<dt key={k + 't'} style={{ color: 'var(--ink)', fontWeight: 600 }}>{k}</dt>, <dd key={k + 'd'} className="small" style={{ textAlign: 'left', fontWeight: 400 }}>{v}</dd>])}</dl>
          </div>
        </div>
        <div className="panel">
          <header><h2>Where others are ahead</h2><span className="small muted">stated plainly</span></header>
          <div className="body">
            <dl className="kv">{AHEAD.map(([k, v]) => [<dt key={k + 't'} style={{ color: 'var(--ink)', fontWeight: 600 }}>{k}</dt>, <dd key={k + 'd'} className="small" style={{ textAlign: 'left', fontWeight: 400 }}>{v}</dd>])}</dl>
          </div>
        </div>
      </div>
    </div>
  );
}
