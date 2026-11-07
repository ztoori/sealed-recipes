import { useEffect, useState } from 'react';
import { verifyRunnerAttestation } from '../../../core/src/attestation';
import type { Check } from '../../../core/src/nearai';
import { api, runnerAttestation, short, usePoll } from '../api';
import { useApp } from '../App';

const rand = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');

export function Trust() {
  const { mode } = useApp();
  const [att, setAtt] = useState<{ checks: Check[]; a: any; onchain: any } | null>(null);
  const [listings] = usePoll<any[]>('/api/listings', 10000);
  const [pick, setPick] = useState('');
  const t = listings?.some((l) => l.ticker === pick) ? pick : listings?.find((l) => l.ticker === 'CLNP')?.ticker ?? listings?.[0]?.ticker;
  const [vault] = usePoll<any>(t ? `/api/vault/${t}` : null, 30000, [t]);
  const [chainRecipe] = usePoll<any>(t ? `/api/chain/recipes/${t}` : null, 30000, [t]);
  const [events] = usePoll<any>('/api/chain/events?last=150', 3000);
  const [ilog] = usePoll<any[]>('/api/intents/log', 3000);
  const verify = async () => {
    const nonce = rand();
    const { attestation, onchain } = await runnerAttestation(nonce);
    setAtt({ checks: verifyRunnerAttestation(attestation, { nonce, signing_pk: onchain.signing_pk, enc_pk_hex: onchain.enc_pk_hex, codehash: onchain.codehash }).checks, a: attestation, onchain });
  };
  useEffect(() => { verify(); }, []);

  return (
    <div className="grid">
      <div className="panel">
        <header><h2>Who can see what</h2><span className="small muted">for one recipe</span><span className="spacer" />
          <select aria-label="Recipe" value={t ?? ''} onChange={(e) => setPick(e.target.value)}>{(listings ?? []).map((l) => <option key={l.ticker} value={l.ticker}>{l.ticker} · {l.name}</option>)}</select></header>
        <div className="body grid xray">
          <div><h3 className="serif" style={{ fontWeight: 500, fontSize: 19 }}>The marketplace stores</h3>
            <p className="small muted">A ciphertext it cannot open, sealed in the creator's browser.</p>
            <pre className="codebox">{vault ? JSON.stringify({ ...vault.envelope, ct: vault.envelope.ct.slice(0, 220) + '…' }, null, 1) : '—'}</pre></div>
          <div><h3 className="serif" style={{ fontWeight: 500, fontSize: 19 }}>The contract stores</h3>
            <p className="small muted">The commitment, the billable parts and the economics. Enough to settle, not enough to copy.</p>
            <pre className="codebox">{chainRecipe ? JSON.stringify({ id: chainRecipe.id, sealed_hash: chainRecipe.sealed_hash, runner_id: chainRecipe.runner_id, parts: chainRecipe.parts, price_per_run: chainRecipe.price_per_run, reserve_bps: chainRecipe.reserve_bps, guarantee_deposit: chainRecipe.bond_available }, null, 1) : '—'}</pre></div>
          <div><h3 className="serif" style={{ fontWeight: 500, fontSize: 19 }}>Only the runner sees</h3>
            <p className="small muted">The wiring, parameters and prompts, plus the buyer's inputs, for the duration of one run.</p>
            <div className="sealed-box">Decrypted in memory inside runner/src/main.ts, never logged or stored. Everything derived from it (part logs, wallet requests, the result) is sealed to the buyer's one-time browser key before it leaves the runner. The demo's plaintext seeds are in seed/recipes/ so you can read what was sealed.</div></div>
        </div>
      </div>

      <div className="grid trust-grid">
        <div className="panel">
          <header><h2>Runner attestation</h2><button className="btn ghost sm" onClick={verify}>Verify with a new nonce</button></header>
          <div className="body">
            {att?.checks.map((c) => <div key={c.id} className={'check ' + c.status}><span className="i">{c.status === 'pass' ? '✓' : c.status === 'skip' ? '○' : '✕'}</span><span>{c.label}</span><span className="d">{c.detail}</span></div>)}
            {att && <dl className="kv small" style={{ marginTop: 10 }}>
              <dt>TEE</dt><dd>{att.a.tee}</dd>
              <dt>Signing key</dt><dd className="hash">{short(att.a.signing_pk, 14, 6)}</dd>
              <dt>Encryption key</dt><dd className="hash">{short(att.a.enc_pk_hex, 10, 6)}</dd>
              <dt>Code hash</dt><dd className="hash">{short(att.a.codehash, 10, 6)}</dd>
              <dt>Compose hash</dt><dd className="hash">{short(att.a.compose_hash, 10, 6)}</dd>
            </dl>}
            <p className="small muted">The owner pins the audited release in AUDITED_CODEHASH and registers it on-chain. Edit a file under runner/src or core/src and restart without re-pinning: this check turns red. In local-dev the code hash is self-reported; inside a TDX CVM it is only meaningful together with a DCAP-verified quote.</p>
          </div>
        </div>
        <div className="panel">
          <header><h2>What is real in local mode</h2></header>
          <div className="body small grid" style={{ gap: 6 }}>
            <div><span className="pill ok">real</span> SRS-1 validation, sealing (X25519/XSalsa20-Poly1305), ed25519 run reports, settlement math, guarantee-deposit accounting and market-driven pricing (same vectors as the Rust contract)</div>
            <div><span className="pill ok">real</span> the runner's HTTP calls use the exact request shapes of FastNEAR, NEAR RPC, 1Click and NEAR AI Cloud</div>
            <div><span className="pill ok">real</span> NEAR AI chat signatures: secp256k1, EIP-191, recovered and matched to the attested address</div>
            {mode && Object.entries(mode.services).map(([k, v]) => <div key={k}><span className="pill warn">local</span> {k}: {String(v)}</div>)}
            <div><span className="pill warn">local</span> the contract runs as an in-process mirror; the Rust contract in contracts/ passes the same vectors with cargo test</div>
          </div>
        </div>
        <div className="panel">
          <header><h2>What the 1Click service sees</h2><span className="small muted">exact request bodies</span></header>
          <div className="body"><p className="small muted" style={{ marginTop: 0 }}>Confidential intents hide the deposit-to-payout link from chain observers. The 1Click service itself still sees each request, including the fresh recipient.</p>{(ilog ?? []).some((l) => l.path === '/v0/quote') ? <pre className="codebox">{JSON.stringify((ilog ?? []).filter((l) => l.path === '/v0/quote').slice(-3).map((l) => l.body), null, 1)}</pre> : <div className="small muted">No swap has been quoted yet. Get a quote for a recipe that swaps (e.g. SWPR or CLNP) and the exact request bodies appear here.</div>}</div>
        </div>
        <div className="panel">
          <header><h2>Contract events</h2><span className="small muted">NEP-297 · block {events?.height}</span></header>
          <table className="small fixed"><thead><tr><th style={{ width: '38%' }}>Event</th><th>Signer</th><th style={{ width: '22%' }} className="r">Tx</th></tr></thead><tbody>
            {(events?.events ?? []).filter((e: any) => e.event !== 'order_placed' && e.event !== 'order_cancelled' && !(e.event === 'batch_cleared' && e.data[0].price === null)).slice(-14).reverse().map((e: any) => (
              <tr key={e.idx}><td>{e.event}</td><td className="muted" title={e.signer}>{e.signer.length > 28 ? short(e.signer, 10, 8) : e.signer}</td><td className="hash r" title={e.tx_hash}>{short(e.tx_hash, 6, 4)}</td></tr>
            ))}
          </tbody></table>
        </div>
      </div>
    </div>
  );
}
