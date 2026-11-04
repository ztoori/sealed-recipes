import { useEffect, useRef, useState } from 'react';
import { seal, sealedHash, type SealedEnvelope } from '../../../core/src/seal';
import { publicListing, type Catalog, type Recipe } from '../../../core/src/frs';
import { verifyRunnerAttestation } from '../../../core/src/attestation';
import { creatorKeyFromSignature, creatorKeyMessage, demoWalletSign } from '../../../core/src/creator';
import type { Check } from '../../../core/src/nearai';
import { api, runnerAttestation, short } from '../api';

const rand = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');

/** The "seal" moment: verify the runner, encrypt in this browser, publish only ciphertext + listing. */
export function SealModal({ recipe, catalog, auto, onClose }: { recipe: Recipe; catalog: Catalog; auto: boolean; onClose: (published: boolean) => void }) {
  const [stage, setStage] = useState(0); // 0 verify, 1 seal, 2 publish, 3 done
  const [checks, setChecks] = useState<Check[]>([]);
  const [env, setEnv] = useState<SealedEnvelope>();
  const [encPk, setEncPk] = useState('');
  const [tx, setTx] = useState<{ tx: string; height: number; sealed_hash: string }>();
  const [err, setErr] = useState('');
  const started = useRef(false);

  const verify = async () => {
    setErr('');
    const nonce = rand();
    const { attestation, onchain } = await runnerAttestation(nonce);
    const v = verifyRunnerAttestation(attestation, { nonce, signing_pk: onchain.signing_pk, enc_pk_hex: onchain.enc_pk_hex, codehash: onchain.codehash });
    setChecks(v.checks);
    if (!v.ok) { setErr('Runner attestation failed. Do not seal to this key.'); return false; }
    setEncPk(onchain.enc_pk_hex); setStage(1); return onchain.enc_pk_hex as string;
  };
  const doSeal = (pk: string) => { const e = seal(recipe, pk, 'recipe'); setEnv(e); setStage(2); return e; };
  const publish = async (e: SealedEnvelope) => {
    try {
      const listing = publicListing(recipe, catalog);
      // a second copy sealed to the creator's own key (derived from a wallet signature; local demo wallet here),
      // so the creator can reopen and edit any published version from any device
      const who = recipe.meta.creator;
      const creator_copy = seal(recipe, creatorKeyFromSignature(demoWalletSign(who, creatorKeyMessage(who))).publicKeyHex, 'creator-copy');
      const r = await api('/api/publish', { listing, sealed: e, bond: recipe.listing.bond ?? '0', settle_mode: recipe.listing.settle_mode ?? 'final', creator_copy });
      setTx(r); setStage(3); return true;
    } catch (x) { setErr((x as Error).message); return false; }
  };

  useEffect(() => {
    if (started.current) return; started.current = true;
    (async () => {
      const pk = await verify().catch((e) => { setErr(e.message); return false as const; });
      if (typeof pk !== 'string' || !auto) return;
      await new Promise((r) => setTimeout(r, 1600));
      const e = doSeal(pk);
      await new Promise((r) => setTimeout(r, 2200));
      if (await publish(e)) setTimeout(() => onClose(true), 2600);
    })();
  }, []);

  const plaintext = JSON.stringify({ nodes: recipe.nodes.map((n) => ({ id: n.id, part: n.part, inputs: n.inputs, params: n.params })) }, null, 1);
  const listItems = ['Verify the runner attestation', 'Seal the recipe in this browser', 'Publish listing and commitment', 'Listed on the marketplace'];
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Seal and publish">
      <div className="sealer">
        <div className="left">
          <h2>{stage < 2 ? 'Your recipe, in plaintext' : 'What leaves this browser'}</h2>
          <p className="small muted" style={{ margin: '4px 0 10px' }}>{stage < 2 ? 'Wiring, prompts and thresholds: the edge you are selling.' : `X25519 + XSalsa20-Poly1305 sealed box to runner key ${short(encPk, 10, 6)}`}</p>
          <pre className={'plain' + (stage >= 2 ? ' gone' : '')}>{plaintext}</pre>
          <pre className={'cipher' + (stage >= 2 ? ' on' : '')}>{env ? `ct: ${env.ct}\n\nepk: ${env.epk}\nnonce: ${env.nonce}` : ''}</pre>
          <div className={'waxseal' + (stage >= 2 ? ' on' : '')} aria-hidden>sealed<br />{recipe.meta.ticker}</div>
        </div>
        <div className="right">
          <ol className="steps">
            {listItems.map((l, i) => <li key={l} className={stage > i ? 'done' : stage === i ? 'now' : ''}><span className="dot">{stage > i ? '✓' : i + 1}</span>{l}</li>)}
          </ol>
          {checks.length > 0 && <div style={{ borderTop: '1px solid var(--rule-soft)', paddingTop: 8 }}>
            {checks.map((c) => <div key={c.id} className={'check ' + c.status}><span className="i">{c.status === 'pass' ? '✓' : c.status === 'skip' ? '○' : '✕'}</span><span>{c.label}</span>{c.status === 'skip' && <span className="d">{c.detail}</span>}</div>)}
          </div>}
          {env && <div className="small"><span className="muted">on-chain commitment</span><div className="hash">{sealedHash(env)}</div></div>}
          {tx && <div className="small"><span className="muted">publish_recipe</span><div className="hash">tx {tx.tx} · block {tx.height}</div></div>}
          {err && <div className="diag error">{err}</div>}
          <div className="row wrap">
            {stage === 1 && !auto && <button className="btn seal" onClick={() => doSeal(encPk)}>Seal in this browser</button>}
            {stage === 2 && !auto && env && <button className="btn" onClick={() => publish(env)}>Publish {recipe.meta.ticker}</button>}
            {stage === 3 && <button className="btn" onClick={() => onClose(true)}>Open the listing</button>}
            {stage < 3 && !auto && <button className="btn ghost" onClick={() => onClose(false)}>Cancel</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
