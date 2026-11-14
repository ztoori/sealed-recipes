import { useApp } from '../App';
import { Icon } from '../icons';
import { ForAgents, GuideHero, GuideSection, Steps, Tiles } from './guide-kit';

/** Documentation › Runner · TEE: where a recipe is opened, how its parts and services run, and why the result can be trusted. */

/** the boundary, drawn: what lives inside the confidential VM, and the little that crosses it */
function Boundary() {
  const out: [string, string, string][] = [
    ['market', 'Marketplace', 'relays ciphertext it can’t open'],
    ['vault', 'Contract', 'gets hashes and signed reports'],
    ['globe', 'Services', 'see only what a part sends them'],
  ];
  const inside: [string, string, string][] = [
    ['key', 'Keys', 'born here, never exported'],
    ['lock', 'Recipe and inputs', 'opened in memory, never stored'],
    ['box', 'Parts', 'each on a short leash'],
    ['receipt', 'Report signer', 'one signed line per run'],
  ];
  return (
    <div className="rb" role="img" aria-label="Inside the confidential VM: keys, the opened recipe, the parts and the report signer. Outside: the marketplace, the contract and services see only ciphertext, hashes and what parts send. The buyer's browser receives the sealed result.">
      <div className="rb-side">
        <span className="rb-label">outside, untrusted</span>
        {out.map(([ic, h, p]) => <div key={h} className="rb-node"><Icon name={ic} size={15} /><div><b>{h}</b><span>{p}</span></div></div>)}
      </div>
      <div className="rb-arrows" aria-hidden><span>ciphertext in</span><i /><span>signed report out</span></div>
      <div className="rb-cvm">
        <div className="rb-cvm-hd"><Icon name="cpu" size={16} />Intel TDX confidential VM<span><Icon name="lock" size={12} />memory encrypted by the CPU</span></div>
        <div className="rb-inside">{inside.map(([ic, h, p]) => <div key={h}><Icon name={ic} size={16} /><b>{h}</b><span>{p}</span></div>)}</div>
        <div className="rb-hash"><Icon name="shieldCheck" size={13} />its code hash is pinned on-chain and proved in every attestation</div>
      </div>
      <div className="rb-arrows" aria-hidden><span>sealed to you</span><i /></div>
      <div className="rb-side">
        <span className="rb-label">yours</span>
        <div className="rb-node you"><Icon name="user" size={15} /><div><b>Your browser</b><span>the only place your result opens</span></div></div>
        <div className="rb-node you"><Icon name="wallet" size={15} /><div><b>Your wallet</b><span>signs, when you say so</span></div></div>
      </div>
    </div>
  );
}

/** a part's leash: the rings every part runs inside, from the outside in */
function Leash() {
  const rings: [string, string, string][] = [
    ['shieldCheck', 'Admitted', 'Its manifest and code match a signed release record, or it doesn’t load.'],
    ['box', 'Isolated', 'Open parts run in their own sandboxed process: they can read only their own file, with no writes, no child processes and no network of their own.'],
    ['globe', 'Fenced', 'Its only network is ctx.http, and it refuses every host the manifest didn’t declare.'],
    ['clock', 'Metered', 'Time, HTTP calls, model calls and output size are counted. Past a limit, it stops.'],
    ['check', 'Checked', 'Every value it returns must match its declared type before the next part sees it.'],
  ];
  return (
    <div className="leash">
      <div className="leash-rings" aria-hidden>
        {rings.map((r, i) => <div key={r[1]} className="leash-ring" style={{ inset: `${i * 9}%` }}><span>{r[1]}</span></div>)}
        <div className="leash-core"><Icon name="code" size={18} /><b>part code</b></div>
      </div>
      <ol className="leash-list">
        {rings.map(([ic, h, p], i) => <li key={h}><span className="leash-n">{i + 1}</span><Icon name={ic} size={15} /><div><b>{h}</b><p>{p}</p></div></li>)}
      </ol>
    </div>
  );
}

/**
 * What is the real thing and what is not: on the live site, what runs for real and what is not there yet; in the
 * local demo, what is real code and which services are stand-ins (moved here from Trust & privacy).
 */
function Realness() {
  const { mode, go } = useApp();
  const live = !!mode && mode.mode !== 'local';
  if (live) {
    const here = [
      `the contract: ${mode.contract_id} on NEAR testnet; every payment and settlement is a transaction you can look up`,
      `the runner: ${mode.runner_id}, in an Intel TDX confidential VM (dstack on Phala Cloud); your browser verifies its quote against Intel’s root and checks the image it runs`,
      'NEAR AI Cloud private models, each answer’s signature recovered and matched to the attested address',
      'FastNEAR and NEAR RPC on mainnet, read-only: recipes look at real accounts and contracts',
      'sealing (X25519 · XSalsa20-Poly1305), signed quotes, ed25519 run reports, escrow and one-receipt settlement',
    ];
    const notHere = [
      'NEAR Intents: it has no testnet, so runs are paid directly in tUSDC, a test token with no value; payment through 1Click and confidential swaps run in the local demo only',
      'recipes that ask you to sign: the runner here is read-only on mainnet and refuses them',
      'a reproducible build: the image is checked, but nothing yet proves it was built from the public source',
      'more than one runner: this one is approved by the contract owner',
      'publishing from the composer: Compose is a practice composer on simulated services; on testnet a creator publishes with their own key',
    ];
    return (
      <div className="real">
        <div className="real-col"><b><Icon name="check" size={14} />Real on this site</b>{here.map((r) => <p key={r}>{r}</p>)}</div>
        <div className="real-col local"><b><Icon name="sliders" size={14} />Not on this site yet</b>{notHere.map((r) => <p key={r}>{r}</p>)}</div>
        <div className="real-proof">
          <div><b>Don’t take our word for it</b><span>Trust &amp; privacy checks the runner’s attestation live, in your browser, next to the real ciphertext and on-chain record.</span></div>
          <button className="btn primary" onClick={() => { go({ page: 'docs', sub: 'trust' }); setTimeout(() => document.getElementById('trust-attestation')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 400); }}><Icon name="shieldCheck" size={15} />See the live attestation</button>
        </div>
      </div>
    );
  }
  const real = [
    'SRS-1 validation, sealing (X25519 · XSalsa20-Poly1305), ed25519 run reports, settlement, guarantee deposits and market pricing, on the same test vectors as the Rust contract',
    'every HTTP call a part makes, in the exact shape FastNEAR, NEAR RPC, 1Click and NEAR AI Cloud expect',
    'NEAR AI chat signatures: secp256k1, EIP-191, recovered and matched to the attested address',
  ];
  const local = [...Object.entries(mode?.services ?? {}).map(([k, v]) => `${k}: ${String(v)}`), 'the contract runs as an in-process mirror; the Rust contract passes the same vectors with cargo test'];
  return (
    <div className="real">
      <div className="real-col"><b><Icon name="check" size={14} />Real in this demo</b>{real.map((r) => <p key={r}>{r}</p>)}</div>
      <div className="real-col local"><b><Icon name="sliders" size={14} />Standing in locally</b>{local.map((r) => <p key={r}>{r}</p>)}</div>
      <div className="real-proof">
        <div><b>Don’t take our word for it</b><span>Trust &amp; privacy checks the runner’s attestation live, in your browser, next to the real ciphertext and on-chain record.</span></div>
        <button className="btn primary" onClick={() => { go({ page: 'docs', sub: 'trust' }); setTimeout(() => document.getElementById('trust-attestation')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 400); }}><Icon name="shieldCheck" size={15} />See the live attestation</button>
      </div>
    </div>
  );
}

export function RunnerGuide() {
  const { go, mode } = useApp();
  const live = !!mode && mode.mode !== 'local';
  return (
    <div className="grid">
      <GuideHero kicker="Runner · TEE" icon="cpu" title="It runs where nobody can look." accent="And proves what it ran."
        lede="How it works, for every recipe. The runner is the only place a recipe is ever opened: inside sealed hardware, with keys that never leave it. Every part runs on a short leash, and every run ends in a signed report the contract checks before anyone is paid.">
        <button className="btn ghost" onClick={() => go({ page: 'docs', sub: 'trust' })}><Icon name="play" size={15} />Watch a run, step by step</button>
      </GuideHero>

      <GuideSection n={1} icon="sparkles" title="Why trust a machine you can’t see" line="Because you can check it, before you send it anything.">
        <Tiles items={[
          { icon: 'cpu', title: 'Sealed hardware', line: 'An Intel TDX confidential VM. The CPU encrypts its memory, so even the machine’s host can’t read it.' },
          { icon: 'key', title: 'Keys born inside', line: 'Its signing and encryption keys are derived inside the VM. Nobody, us included, ever holds a copy.' },
          { icon: 'shieldCheck', title: 'Code you can verify', line: 'The hash of its code, its parts and their review records is pinned on-chain. Your browser checks a fresh attestation before sealing.' },
          { icon: 'eye', title: 'Nothing leaves in the clear', line: 'Results and logs are sealed to a key your browser made for this run. The world sees step counts and a signed report.' },
        ]} />
      </GuideSection>

      <GuideSection n={2} icon="lock" title="The boundary" line="Everything that matters stays inside. Three things cross, and all three are safe to see.">
        <Boundary />
        <button className="linkbtn small" style={{ justifySelf: 'start' }} onClick={() => go({ page: 'docs', sub: 'trust' })}>See the real ciphertext and on-chain record for any recipe<Icon name="arrow" size={12} /></button>
      </GuideSection>

      <GuideSection n={3} icon="refresh" title="A run, from the inside" line="Seven moves, from a paid run to a signed receipt.">
        <Steps items={[
          { icon: 'vault', title: 'Check the chain first', line: 'A paid run arrives as ciphertext. The runner reads the contract itself: the recipe’s hash, your inputs’ hash, the parts list, and that the run is paid and pending.' },
          { icon: 'unlock', title: 'Open in memory', line: 'Recipe and inputs are decrypted inside the VM, never logged, never written down, and dropped when the run ends.' },
          { icon: 'receipt', title: 'Re-check the quote', line: 'Just before running, it prices the run again. If your wallet changed since the quote, it stops and you’re refunded.' },
          { icon: 'box', title: 'Run each part on its leash', line: 'Parts run in dependency order. Conditions decide which run, fallbacks fill gaps, and each one stays inside its limits.' },
          { icon: 'wallet', title: 'Ask, never sign', line: live ? 'When a part needs a transaction, the request is sealed to your browser and your wallet signs it. The runner can’t. On this site the runner is read-only and refuses recipes that ask.' : 'When a part needs a transaction, the request is sealed to your browser and your wallet signs it. The runner can’t.' },
          { icon: 'clock', title: 'Checkpoint as it goes', line: 'Progress is sealed to the runner’s own key and signed. If it restarts, it picks up exactly where it was, and you never sign twice.' },
          { icon: 'check', title: 'Sign one line', line: 'The run ends in a single signed report: outcome, result hash, value delivered, parts used. The contract checks the signature and settles.' },
        ]} />
      </GuideSection>

      <GuideSection n={4} icon="box" title="How a part runs" line="Every part, from every builder, lives inside the same five rings.">
        <Leash />
      </GuideSection>

      <GuideSection n={5} icon="globe" title="How services are reached" line="Parts never get the open internet. They get a short list, written in their manifest.">
        <Tiles tone="wax" items={[
          { icon: 'database', title: 'FastNEAR', line: 'Public NEAR data: balances, keys, stakes, contract code. Read-only; your secrets never ride along.', tag: 'read-only' },
          { icon: 'zap', title: '1Click and the solver relay', line: 'Prices, quotes and swaps through NEAR Intents, including confidential and all-or-nothing bundles.', tag: live ? 'local demo only' : 'NEAR Intents' },
          { icon: 'sparkles', title: 'NEAR AI Cloud', line: 'Private models in their own TEEs. Each answer’s signature and the GPU’s attestation are checked before a verdict is used.', tag: 'TEE to TEE' },
          { icon: 'wallet', title: 'Your wallet', line: 'Not a service the runner calls: it asks, you approve. Exactly these transfers, nothing else.', tag: 'you decide' },
        ]} />
      </GuideSection>

      <GuideSection n={6} icon="shield" title="When something goes wrong" line="Every failure has an owner, and it’s never the buyer.">
        <Tiles tone="gain" items={[
          { icon: 'x', title: 'A part fails', line: 'The run fails and you’re refunded, unless the creator planned a fallback for that part.', tag: 'refund' },
          { icon: 'clock', title: 'A part runs away', line: 'It hits its limit and stops. The price was fixed before the run, so there’s no surprise bill.', tag: 'bounded' },
          { icon: 'refresh', title: 'The runner crashes', line: 'It resumes from its last signed checkpoint. Deposits happen exactly once.', tag: 'crash-tested' },
          { icon: 'alert', title: 'The runner goes silent', line: 'After the timeout you reclaim the run on-chain, and your payment comes back.', tag: 'reclaim_run' },
        ]} />
      </GuideSection>

      <GuideSection n={7} icon="flag" title={live ? 'Here, and on your machine' : 'Here, and in production'} line="The same code, two homes.">
        <div className="homes">
          {live ? <>
          <div><b><Icon name="cpu" size={15} />This site</b><p>The runner is {mode.runner_id}, a container in an Intel TDX confidential VM (dstack on Phala Cloud). Its keys come from the VM’s key service and never leave it. Before sealing anything, your browser verifies its hardware quote against Intel’s root (DCAP) and checks which image it runs.</p></div>
          <div><b><Icon name="code" size={15} />The local demo</b><p><code>npm run demo</code> runs the same runner code as a local process: real keys, real sealing, signed quotes and reports, enforced limits. There’s no hardware there, so the hardware quote shows as skipped, never as passed.</p></div>
          </> : <>
          <div><b><Icon name="code" size={15} />This demo</b><p>The runner is a local process: real keys, real sealing, signed quotes and reports, enforced limits. There’s no hardware here, so the hardware quote shows as skipped, never as passed.</p></div>
          <div><b><Icon name="cpu" size={15} />The live site</b><p>The same container in an Intel TDX confidential VM (dstack on Phala Cloud) at sealedrecipes.xyz. Keys come from the VM’s key service, and each buyer’s browser checks the hardware quote with Intel’s DCAP verification.</p></div>
          </>}
          <div><b><Icon name="layers" size={15} />Other backends</b><p>Anything that can keep the keys in attested hardware and sign the same three messages can run recipes. Chainlink CRE and OutLayer are designed paths.</p></div>
        </div>
        <Realness />
      </GuideSection>

      <ForAgents rows={[
        ['Attestation', <><code>GET {'<runner>'}/attestation?nonce=…</code>; check it with <code>verifyRunnerAttestation</code> against the runner registered on-chain</>],
        ['Registered keys', <><code>signing_pk</code> (ed25519), <code>enc_pk_hex</code> (X25519), <code>codehash</code></>],
        ['Signed messages', <><code>srs-quote-v3</code> (quotes), <code>srs-ckpt-v1</code> (checkpoints), <code>srs-run-v3</code> (the report)</>],
        ['Code', <><code>runner/src/main.ts</code> (the run), <code>executor.ts</code> (parts), <code>sandbox.ts</code>, <code>limits.ts</code>, <code>admission.ts</code></>],
        ['Reproduce it', <><code>npm run test:durable</code> kills the runner twice mid-run and checks nothing is paid or signed twice</>],
      ]} />
    </div>
  );
}
