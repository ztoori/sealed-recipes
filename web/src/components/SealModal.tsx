import { useEffect, useRef, useState } from 'react';
import { seal, sealedHash, type SealedEnvelope } from '../../../core/src/seal';
import { publicListing, type Catalog, type Recipe } from '../../../core/src/srs';
import { verifyRunnerAttestation } from '../../../core/src/attestation';
import { creatorKeyFromSignature, creatorKeyMessage, demoWalletSign } from '../../../core/src/creator';
import type { Check } from '../../../core/src/nearai';
import { api, runnerAttestation, short, txRef } from '../api';
import { demoMs } from '../pace';
import { Icon } from '../icons';

const rand = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * The "seal" moment: verify the runner, encrypt in this browser, publish only ciphertext + listing.
 * With `asVersion`, the sealed recipe is announced as the next version of an already listed recipe instead: it takes
 * effect after the notice period, and the listing (name, form, parts, price) stays as published.
 *
 * verifying → verified → sealed → publishing → published, with explicit failure states and retries:
 * verify_failed (retry verify), publish_failed (retry publish with the same ciphertext).
 */
type Phase = 'verifying' | 'verify_failed' | 'verified' | 'sealed' | 'publishing' | 'publish_failed' | 'published';
const STAGE: Record<Phase, number> = { verifying: 0, verify_failed: 0, verified: 1, sealed: 2, publishing: 2, publish_failed: 2, published: 3 };

export function SealModal({ recipe, catalog, auto, asVersion, onClose }: { recipe: Recipe; catalog: Catalog; auto: boolean; asVersion?: boolean; onClose: (published: boolean) => void }) {
  const [phase, setPhase] = useState<Phase>('verifying');
  const stage = STAGE[phase];
  const [checks, setChecks] = useState<Check[]>([]);
  const [env, setEnv] = useState<SealedEnvelope>();
  const [encPk, setEncPk] = useState('');
  const [tx, setTx] = useState<{ tx: string; height?: number; version?: number; effective_ns?: string }>();
  const [err, setErr] = useState('');
  const started = useRef(false);

  const verify = async (): Promise<string | false> => {
    setErr(''); setPhase('verifying');
    try {
      const nonce = rand();
      const { attestation, onchain } = await runnerAttestation(nonce);
      const v = verifyRunnerAttestation(attestation, { nonce, signing_pk: onchain.signing_pk, enc_pk_hex: onchain.enc_pk_hex, codehash: onchain.codehash });
      setChecks(v.checks);
      if (!v.ok) { setErr('Runner attestation failed. Do not seal to this key.'); setPhase('verify_failed'); return false; }
      setEncPk(onchain.enc_pk_hex); setPhase('verified'); return onchain.enc_pk_hex as string;
    } catch (e) { setErr((e as Error).message); setPhase('verify_failed'); return false; }
  };
  const doSeal = (pk: string) => { const e = seal(recipe, pk, 'recipe'); setEnv(e); setPhase('sealed'); return e; };
  const publish = async (e: SealedEnvelope) => {
    setErr(''); setPhase('publishing');
    try {
      // a second copy sealed to the creator's own key (derived from a wallet signature; local demo wallet here),
      // so the creator can reopen and edit any published version from any device
      const who = recipe.meta.creator;
      const creator_copy = seal(recipe, creatorKeyFromSignature(demoWalletSign(who, creatorKeyMessage(who))).publicKeyHex, 'creator-copy');
      const r = asVersion
        ? await api(`/api/recipes/${recipe.meta.ticker}/update`, { signer: who, sealed: e, creator_copy })
        : await api('/api/publish', { listing: publicListing(recipe, catalog), sealed: e, bond: recipe.listing.bond ?? '0', settle_mode: recipe.listing.settle_mode ?? 'final', creator_copy });
      setTx(r); setPhase('published'); return true;
    } catch (x) { setErr((x as Error).message); setPhase('publish_failed'); return false; }
  };

  useEffect(() => {
    if (started.current) return; started.current = true;
    (async () => {
      const pk = await verify();
      if (!pk || !auto) return;
      await new Promise((r) => setTimeout(r, demoMs(1600)));
      const e = doSeal(pk);
      await new Promise((r) => setTimeout(r, demoMs(2200)));
      if (await publish(e)) setTimeout(() => onClose(true), demoMs(2600));
    })();
  }, []);

  const plaintext = JSON.stringify({ nodes: recipe.nodes.map((n) => ({ id: n.id, part: n.part, inputs: n.inputs, params: n.params })) }, null, 1);
  const listItems = asVersion ? ['Verify the runner', 'Seal in this browser', 'Announce the new version', 'Takes effect after notice'] : ['Verify the runner', 'Seal in this browser', 'Publish the commitment', 'Listed'];
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Seal and publish">
      <div className="sealer">
        <div className="left">
          <h2>{stage < 2 ? 'Your recipe, in plaintext' : 'What leaves this browser'}</h2>
          <p className="small muted" style={{ margin: '4px 0 10px' }}>{stage < 2 ? 'The edge you are selling.' : `Sealed box to runner key ${short(encPk, 10, 6)}`}</p>
          <pre className={'plain' + (stage >= 2 ? ' gone' : '')}>{plaintext}</pre>
          <pre className={'cipher' + (stage >= 2 ? ' on' : '')}>{env ? `ct: ${env.ct}\n\nepk: ${env.epk}\nnonce: ${env.nonce}` : ''}</pre>
          <div className={'waxseal' + (stage >= 2 ? ' on' : '')} aria-hidden>sealed<br />{recipe.meta.ticker}</div>
        </div>
        <div className="right">
          <ol className="steps">
            {listItems.map((l, i) => <li key={l} className={stage > i ? 'done' : stage === i ? 'now' : ''}><span className="dot">{stage > i ? <Icon name="check" size={12} /> : i + 1}</span>{l}</li>)}
          </ol>
          {checks.length > 0 && <div style={{ borderTop: '1px solid var(--rule-soft)', paddingTop: 8 }}>
            {checks.map((c) => <div key={c.id} className={'check ' + c.status}><span className="i">{c.status === 'pass' ? '✓' : c.status === 'skip' ? '○' : '✕'}</span><span>{c.label}</span>{c.status === 'skip' && <span className="d">{c.detail}</span>}</div>)}
          </div>}
          {env && <div className="small"><span className="muted">on-chain commitment</span><div className="hash">{sealedHash(env)}</div></div>}
          {tx && <div className="small"><span className="muted">{asVersion ? `update_sealed · version ${tx.version}` : 'publish_recipe'}</span><div className="hash">{txRef(tx.tx, 10, 8)}{tx.height ? ` · block ${tx.height}` : ''}</div>{asVersion && tx.effective_ns && <div className="muted">takes effect {new Date(Number(BigInt(tx.effective_ns) / 1_000_000n)).toLocaleString()}; buyers keep the current version until then</div>}</div>}
          {err && <div className="diag error">{err}</div>}
          <div className="row wrap">
            {phase === 'verify_failed' && <button className="btn ghost" onClick={() => verify()}>Verify again</button>}
            {phase === 'verified' && !auto && <button className="btn seal" onClick={() => doSeal(encPk)}><Icon name="lock" size={15} />Seal in this browser</button>}
            {(phase === 'sealed' || phase === 'publish_failed') && !auto && env && <button className="btn" onClick={() => publish(env)}>{phase === 'publish_failed' ? 'Try publishing again' : asVersion ? `Announce ${recipe.meta.ticker}’s new version` : `Publish ${recipe.meta.ticker}`}</button>}
            {phase === 'publishing' && <span className="small muted">Publishing…</span>}
            {phase === 'published' && <button className="btn primary" onClick={() => onClose(true)}><Icon name="market" size={15} />{asVersion ? 'Done' : 'Open the listing'}</button>}
            {phase !== 'published' && phase !== 'publishing' && (!auto || phase.endsWith('failed')) && <button className="btn ghost" onClick={() => onClose(false)}>{phase === 'publish_failed' || phase === 'verify_failed' ? 'Back to editing' : 'Cancel'}</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
