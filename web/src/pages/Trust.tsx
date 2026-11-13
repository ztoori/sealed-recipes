import { useEffect, useState } from 'react';
import { verifyRunnerAttestation } from '../../../core/src/attestation';
import type { Check } from '../../../core/src/nearai';
import { api, runnerAttestation, short, usePoll } from '../api';
import { useApp } from '../App';
import { checkWithIntel } from '../tdx';
import { demoMs } from '../pace';
import { Icon } from '../icons';
import { Seal, Tip } from '../ui';
import type { Catalog } from '../../../core/src/srs';
import { RecipeFilm, type FilmListing } from '../components/RecipeFilm';

const rand = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');

export function Trust() {
  const { go, story } = useApp();
  const [cat] = usePoll<Catalog>('/api/catalog', 60000);
  const [film, setFilm] = useState('');
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
    // a hardware quote: check Intel's signature chain in this browser (web/src/tdx.ts), then show the result in place of "not verified here"
    if (attestation.tee === 'dstack-tdx' && attestation.quote) {
      const setChain = (status: Check['status'], detail: string) => setAtt((p) => p && p.a === attestation ? { ...p, checks: p.checks.map((c) => (c.id === 'tdx.chain' ? { ...c, label: 'Intel signature chain, checked in this browser (DCAP)', status, detail } : c)) } : p);
      setChain('skip', 'checking with Intel…');
      const i = await checkWithIntel(attestation.quote, attestation.report_data);
      setChain(i.ok ? 'pass' : 'fail', i.ok ? `TCB ${i.status}${i.advisories?.length ? ' · advisories ' + i.advisories.join(', ') : ''}` : i.error ?? 'failed');
    }
  };
  useEffect(() => { verify(); }, []);
  // demo story, step 6: the ciphertext and the on-chain record for CLNP, then the runner's attestation
  useEffect(() => {
    if (story.step !== 6) return;
    setPick('CLNP');
    const t1 = setTimeout(() => document.getElementById('trust-see')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), demoMs(900));
    const t2 = setTimeout(() => document.getElementById('trust-attestation')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), demoMs(5500));
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [story.step, story.run]);

  const filmTicker = listings?.some((l) => l.ticker === film) ? film : listings?.[0]?.ticker;
  const filmListing = listings?.find((l) => l.ticker === filmTicker) as FilmListing | undefined;

  return (
    <div className="grid">
      <div className="purpose-line"><Icon name="shieldCheck" size={16} /><p><b>Proof, live, for each recipe.</b> Watch it run, see the ciphertext the market holds and the record on-chain, and check the runner yourself.</p><button className="linkbtn small" onClick={() => go({ page: 'docs', sub: 'runner' })}>How it works: Runner · TEE<Icon name="arrow" size={12} /></button></div>
      <div className="panel">
        <header><Icon name="play" size={16} className="hd-ic" /><h2>Every recipe, start to finish</h2><Tip wide>Each film is drawn live from the recipe’s public listing and the part catalog: its form, its parts, the services they may reach, and how the price is split. It can’t show anything a buyer couldn’t already see, which is why the order the parts run in stays hidden. The answers and results are an example run.</Tip></header>
        <div className="body grid" style={{ gap: 12 }}>
          <p className="small muted" style={{ margin: 0 }}>How a buyer uses each recipe, every part of the stack it touches, in order, and who gets paid. About 45 seconds each.</p>
          <div className="film-picker" role="tablist" aria-label="Recipe films">
            {(listings ?? []).map((l) => (
              <button key={l.ticker} role="tab" aria-selected={l.ticker === filmTicker} className={l.ticker === filmTicker ? 'on' : ''} onClick={() => setFilm(l.ticker)} title={l.name}>
                <Seal ticker={l.ticker} kind={l.output_type} size={22} /><b>{l.ticker}</b>{l.name}
              </button>
            ))}
          </div>
          {filmListing && cat && <RecipeFilm listing={filmListing} catalog={cat} onQuote={() => go({ page: 'quote', ticker: filmListing.ticker })} />}
        </div>
      </div>
      <div className="panel" id="trust-see">
        <header><Icon name="eye" size={16} className="hd-ic" /><h2>Who can see what</h2><button className="linkbtn small" onClick={() => go({ page: 'docs', sub: 'runner' })}>How the runner keeps it this way<Icon name="arrow" size={12} /></button><span className="spacer" />
          <select aria-label="Recipe" value={t ?? ''} onChange={(e) => setPick(e.target.value)}>{(listings ?? []).map((l) => <option key={l.ticker} value={l.ticker}>{l.ticker} · {l.name}</option>)}</select></header>
        <div className="body grid xray">
          <div><h3><span className="xray-ic"><Icon name="market" size={16} /></span>Marketplace</h3>
            <p className="small muted" style={{ margin: 0 }}>A ciphertext it cannot open.</p>
            <pre className="codebox">{vault ? JSON.stringify({ ...vault.envelope, ct: vault.envelope.ct.slice(0, 220) + '…' }, null, 1) : 'Loading…'}</pre></div>
          <div><h3><span className="xray-ic"><Icon name="vault" size={16} /></span>Contract</h3>
            <p className="small muted" style={{ margin: 0 }}>Enough to settle, not enough to copy.</p>
            <pre className="codebox">{chainRecipe ? JSON.stringify({ id: chainRecipe.id, sealed_hash: chainRecipe.sealed_hash, runner_id: chainRecipe.runner_id, parts: chainRecipe.parts, price_per_run: chainRecipe.price_per_run, reserve_bps: chainRecipe.reserve_bps, guarantee_deposit: chainRecipe.bond_available }, null, 1) : 'Loading…'}</pre></div>
          <div><h3><span className="xray-ic"><Icon name="cpu" size={16} /></span>Only the runner</h3>
            <p className="small muted" style={{ margin: 0 }}>Wiring, settings, prompts and the buyer’s inputs, for one run.</p>
            <div className="sealed-box"><Icon name="lock" size={14} /><span>Decrypted in memory, never logged</span><Tip wide>Decrypted in memory inside runner/src/main.ts, never logged or stored. Everything derived from it (part logs, wallet requests, the result) is sealed to the buyer's one-time browser key before it leaves the runner. The demo's plaintext seeds are in seed/recipes/ so you can read what was sealed.</Tip></div></div>
        </div>
      </div>

      <div className="grid trust-grid">
        <div className="panel" id="trust-attestation">
          <header><Icon name="cpu" size={16} className="hd-ic" /><h2>Runner attestation</h2><span className="spacer" /><button className="btn ghost sm" onClick={verify}><Icon name="refresh" size={13} />Verify again</button></header>
          <div className="body">
            {att?.checks.map((c) => <div key={c.id} className={'check ' + c.status}><span className="i">{c.status === 'pass' ? '✓' : c.status === 'skip' ? '○' : '✕'}</span><span>{c.label}</span><span className="d">{c.detail}</span></div>)}
            {att && <dl className="kv small" style={{ marginTop: 10 }}>
              <dt>TEE</dt><dd>{att.a.tee}</dd>
              <dt>Signing key</dt><dd className="hash">{short(att.a.signing_pk, 14, 6)}</dd>
              <dt>Encryption key</dt><dd className="hash">{short(att.a.enc_pk_hex, 10, 6)}</dd>
              <dt>Code hash</dt><dd className="hash">{short(att.a.codehash, 10, 6)}</dd>
              <dt>Compose hash</dt><dd className="hash">{short(att.a.compose_hash, 10, 6)}</dd>
            </dl>}
            <div className="small muted row" style={{ marginTop: 10 }}>How the code hash is pinned <Tip wide>The owner pins the audited release in AUDITED_CODEHASH and registers it on-chain. Edit a file under runner/src or core/src and restart without re-pinning: this check turns red. In local-dev the code hash is self-reported; inside a TDX CVM it is only meaningful together with a DCAP-verified quote.</Tip></div>
          </div>
        </div>
        <div className="panel">
          <header><Icon name="globe" size={16} className="hd-ic" /><h2>What 1Click sees</h2><Tip>Confidential intents hide the deposit-to-payout link from chain observers. The 1Click service itself still sees each request, including the fresh recipient. Exact request bodies below.</Tip></header>
          <div className="body">{(ilog ?? []).some((l) => l.path === '/v0/quote') ? <pre className="codebox">{JSON.stringify((ilog ?? []).filter((l) => l.path === '/v0/quote').slice(-3).map((l) => l.body), null, 1)}</pre> : <div className="small muted">No swaps quoted yet. Quote SWPR or CLNP to see them.</div>}</div>
        </div>
        <div className="panel">
          <header><Icon name="receipt" size={16} className="hd-ic" /><h2>Contract events</h2><span className="spacer" /><span className="small muted">block {events?.height}</span></header>
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
