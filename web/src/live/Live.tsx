/**
 * The live marketplace on NEAR testnet (served by server/src/live.ts). Nobody logs in:
 *  - read-only recipes take any public mainnet account, typed in like on a block explorer, sealed in this browser;
 *  - paying uses a guest key made in this browser and funded once by the testnet faucet (test tokens only);
 *  - every step is a real testnet transaction, linked to the explorer.
 */
import { useEffect, useRef, useState } from 'react';
import nacl from 'tweetnacl';
import { seal, open, sealedHash, type SealedEnvelope } from '../../../core/src/seal';
import { jobHash, openQuote } from '../../../core/src/quotes';
import { verifyRunnerAttestation } from '../../../core/src/attestation';
import { api, short, usePoll } from '../api';
import { Output } from '../components/RunViews';
import { Icon } from '../icons';
import { BrandMark, Empty, Head, Seal, Tip } from '../ui';
import { downloadGuest, forgetGuest, hex, loadGuest, newGuest, saveRun, savedRuns, type Guest, type SavedRun } from './guest';

const EXPLORER = 'https://testnet.nearblocks.io';
const txUrl = (h: string) => `${EXPLORER}/txns/${h}`;
const accUrl = (a: string) => `${EXPLORER}/address/${a}`;
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
/** tUSDC has 6 decimals */
const usd = (u: string | number, dp = 2) => (Number(u) / 1e6).toFixed(dp);
const fmtNear = (y: string) => (Number(BigInt(y) / 10n ** 18n) / 1e6).toFixed(4);

interface Mode { mode: string; contract_id: string; payment_token: string; runner_id: string; rpc_url: string; faucet: boolean }
interface Listing { ticker: string; name: string; description: string; creator: string; form: { id: string; label: string; type: string; placeholder?: string; default?: unknown; options?: string[]; required?: boolean }[]; price_per_run: string; risk: string; privacy: string; output_type: string; parts: string[]; capabilities: string[]; onchain?: { runs: string; failed: string; price_per_run: string } }
interface Balance { exists: boolean; near_yocto: string; tusdc: string }
type Ev = { seq: number; at: number; source: string; type: string; data: any; sealed?: boolean };

export function Live() {
  const [mode] = usePoll<Mode>('/api/mode', 60000);
  const [listings] = usePoll<Listing[]>('/api/listings', 30000);
  const [guest, setGuest] = useState<Guest | null>(() => loadGuest());
  const [pick, setPick] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);
  const say = (msg: string, err?: boolean) => { setToast({ msg, err }); setTimeout(() => setToast(null), 5000); };
  const [resume, setResume] = useState<SavedRun | null>(null);
  const listing = listings?.find((l) => l.ticker === pick);

  return (
    <>
      <div className="top">
        <a className="brand" href="/" aria-label="Sealed Recipes live"><BrandMark /><b>Sealed Recipes</b></a>
        <div className="spacer" />
        <span className="mode" title={mode ? `${mode.contract_id} on ${mode.mode}\nrunner ${mode.runner_id}` : ''}><i className="dot" style={{ background: 'var(--gain, #3fb27f)' }} />Live · NEAR {mode?.mode ?? 'testnet'}</span>
        <a className="btn ghost sm" href="https://sealedrecipes.xyz" title="The guided demo, with simulated services">Guided demo</a>
      </div>
      <main>
        <div className="grid">
          <div className="panel">
            <div className="body small" style={{ lineHeight: 1.55 }}>
              <b>No login needed.</b> These recipes run for real: the contract <a href={accUrl(mode?.contract_id ?? '')} target="_blank" rel="noreferrer" className="hash">{mode?.contract_id}</a> is on NEAR testnet and the data they read comes from NEAR mainnet, read-only.
              Type any public mainnet account to look at, the way you would on a block explorer. To pay for a run, make a guest account below: a key created in this browser, given test tokens by our faucet. No real money is involved anywhere.
            </div>
          </div>
          <GuestPanel mode={mode} guest={guest} setGuest={setGuest} say={say} />
          <div className="grid runpage">
            <section className="grid">
              <div className="panel">
                <Head icon="market" title="Recipes on testnet" />
                <div className="body grid" style={{ gap: 8 }}>
                  {!listings && <div className="row muted"><span className="spinner" />Loading</div>}
                  {listings?.length === 0 && <Empty icon="market">No recipes are published on this contract yet.</Empty>}
                  {listings?.map((l) => (
                    <button key={l.ticker} className={'btn ghost'} style={{ justifyContent: 'flex-start', textAlign: 'left', whiteSpace: 'normal', padding: 10, borderColor: pick === l.ticker ? 'var(--wax)' : undefined }} onClick={() => { setPick(l.ticker); setResume(null); }}>
                      <Seal ticker={l.ticker} kind={l.output_type} size={40} />
                      <span style={{ minWidth: 0 }}><b>{l.name}</b> <span className="tk">{l.ticker}</span><br /><span className="small muted">{l.description}</span><br />
                        <span className="small">{usd(l.onchain?.price_per_run ?? l.price_per_run, 2)} tUSDC / run · {l.risk} risk{l.onchain ? ` · ${l.onchain.runs} runs on-chain` : ''}</span></span>
                    </button>
                  ))}
                </div>
              </div>
              <PastRuns onOpen={(r) => { setPick(r.recipe_id); setResume(r); }} />
            </section>
            <section className="grid">
              {listing && mode ? <RunPanel key={listing.ticker + (resume?.run_id ?? '')} mode={mode} listing={listing} guest={guest} resume={resume} say={say} /> : <div className="panel"><div className="body"><Empty icon="receipt">Pick a recipe to get a sealed quote.</Empty></div></div>}
            </section>
          </div>
        </div>
      </main>
      {toast && <div className={'toast' + (toast.err ? ' err' : '')} role="alert"><Icon name={toast.err ? 'alert' : 'check'} size={16} />{toast.msg}</div>}
    </>
  );
}

function GuestPanel({ mode, guest, setGuest, say }: { mode?: Mode; guest: Guest | null; setGuest: (g: Guest | null) => void; say: (m: string, e?: boolean) => void }) {
  const [bal, refresh] = usePoll<Balance>(guest ? `/api/account/${guest.account}/balance` : null, 15000, [guest?.account]);
  const [busy, setBusy] = useState(false);
  const fund = async (g: Guest) => {
    setBusy(true);
    try { await api('/api/faucet', { account_id: g.account }); say('Guest account funded with test tokens'); refresh(); }
    catch (e) { say((e as Error).message, true); }
    finally { setBusy(false); }
  };
  const create = async () => { const g = newGuest(); setGuest(g); await fund(g); };
  return (
    <div className="panel">
      <Head icon="wallet" title="Guest account" tip="A NEAR testnet implicit account: its name is its public key, so there is nothing to sign up for. The key is kept in this browser only and signs your own testnet payments. It holds test tokens with no value." />
      <div className="body grid" style={{ gap: 8 }}>
        {!guest ? (
          <div className="row wrap"><button className="btn primary" disabled={busy || !mode} onClick={create}>{busy ? <><span className="spinner" />Creating</> : <><Icon name="sparkles" size={15} />Continue as guest</>}</button>
            <span className="small muted">You only need this to pay for a run. Quotes are free and need no account.</span></div>
        ) : (
          <>
            <div className="row wrap small"><a className="hash" href={accUrl(guest.account)} target="_blank" rel="noreferrer">{short(guest.account, 10, 8)}</a>
              {bal ? (bal.exists ? <span>{fmtNear(bal.near_yocto)} NEAR (gas) · <b>{usd(bal.tusdc, 2)} tUSDC</b></span> : <span className="muted">not on-chain yet</span>) : <span className="spinner" />}
              <span className="spacer" />
              {bal && !bal.exists && <button className="btn sm" disabled={busy} onClick={() => fund(guest)}>{busy ? <span className="spinner" /> : 'Get test tokens'}</button>}
              <button className="btn ghost sm" onClick={() => downloadGuest(guest)} title="Save the key file (works with near-cli)"><Icon name="download" size={13} />Key</button>
              <button className="btn ghost sm" onClick={() => { if (confirm('Forget this guest key? Its test tokens cannot be recovered without the key file.')) { forgetGuest(); setGuest(null); } }}>Forget</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function PastRuns({ onOpen }: { onOpen: (r: SavedRun) => void }) {
  const runs = savedRuns();
  if (!runs.length) return null;
  return (
    <div className="panel">
      <Head icon="clock" title="Your runs in this browser" />
      <div className="body grid small" style={{ gap: 4 }}>{runs.map((r) => <button key={r.run_id} className="btn ghost sm" style={{ justifyContent: 'flex-start' }} onClick={() => onOpen(r)}><span className="tk">{r.recipe_id}</span>{r.run_id}<span className="muted">{new Date(r.created).toLocaleString()}</span></button>)}</div>
    </div>
  );
}

type Phase = { name: 'form' } | { name: 'quoting' } | { name: 'quoted'; q: any } | { name: 'paying'; q: any } | { name: 'running' } | { name: 'done'; ok: boolean };

function RunPanel({ mode, listing, guest, resume, say }: { mode: Mode; listing: Listing; guest: Guest | null; resume: SavedRun | null; say: (m: string, e?: boolean) => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(listing.form.map((f) => [f.id, f.default != null ? String(f.default) : ''])));
  const [phase, setPhase] = useState<Phase>(resume ? { name: 'running' } : { name: 'form' });
  const [checks, setChecks] = useState<{ ok: boolean; hardware: boolean; passed: number } | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const job = useRef<{ sealed_job: SealedEnvelope; job_hash: string; reply: nacl.BoxKeyPair; buyer: string } | null>(null);
  const run = useRef<SavedRun | null>(resume);
  const buyer = guest?.account ?? '';

  const bad = listing.form.filter((f) => f.type === 'near.account' && values[f.id] && !ACCOUNT_RE.test(values[f.id].trim())).map((f) => f.id);
  const missing = listing.form.some((f) => f.required && !values[f.id]?.trim());

  const getQuote = async () => {
    setPhase({ name: 'quoting' });
    try {
      // 1. check the runner's attestation against the keys registered on-chain, in this browser
      const nonce = hex(nacl.randomBytes(32));
      const { attestation, onchain } = await api<any>(`/api/runner/attestation?nonce=${nonce}`);
      const v = verifyRunnerAttestation(attestation, { nonce, signing_pk: onchain.signing_pk, enc_pk_hex: onchain.enc_pk_hex, codehash: onchain.codehash });
      setChecks({ ok: v.ok, hardware: v.hardware, passed: v.checks.filter((c) => c.status === 'pass').length });
      if (!v.ok) throw new Error('the runner attestation did not verify: not sending your inputs');
      // 2. seal the inputs to the runner; the quote comes back sealed to a one-time key made here
      const inputs = Object.fromEntries(listing.form.map((f) => [f.id, values[f.id]?.trim()]));
      const reply = nacl.box.keyPair();
      const salt = hex(nacl.randomBytes(16));
      const job_hash = jobHash(inputs, salt);
      const sealed_job = seal({ inputs, salt, reply_to: hex(reply.publicKey) }, onchain.enc_pk_hex, 'inputs');
      // quotes are bound to the buyer who pays; without a guest yet, the quote is bound to a placeholder and re-asked at pay time
      const who = buyer || 'guest.testnet';
      job.current = { sealed_job, job_hash, reply, buyer: who };
      const { quote: q } = await api<any>('/api/quotes', { recipe_id: listing.ticker, sealed_job, job_hash, buyer: who });
      if (!q.ok) {
        let why = q.error;
        if (q.sealed_error) try { why = open<{ error: string }>(q.sealed_error, reply.secretKey).error; } catch { /* keep the public text */ }
        throw new Error(why ?? 'no quote');
      }
      const o = openQuote(q.sealed_quote, reply.secretKey, { contractId: mode.contract_id, recipeId: listing.ticker, signingPk: onchain.signing_pk, buyer: who, inputsHash: sealedHash(sealed_job), jobHash: job_hash });
      if (!o.verified) throw new Error(o.problem ?? 'the quote signature did not verify');
      setPhase({ name: 'quoted', q: { ...q, ...o } });
    } catch (e) { say((e as Error).message, true); setPhase({ name: 'form' }); }
  };

  const pay = async (q: any) => {
    if (!guest || !job.current) return;
    if (job.current.buyer !== guest.account) { say('The quote was made before your guest account existed: asking again', true); await getQuote(); return; }
    setPhase({ name: 'paying', q });
    try {
      const signed = { sealed_hash: q.sealed_hash, job_hash: q.job_hash, price: q.price, expected: q.expected, promised: q.promised, cover: q.cover, expires_ns: q.expires_ns, signature: q.signature };
      const ticket = await api<any>('/api/runs/prepare', { recipe_id: listing.ticker, buyer: guest.account, sealed_inputs: job.current.sealed_job, signed_quote: signed });
      const saved: SavedRun = { run_id: ticket.run_id, token: ticket.run_token, recipe_id: listing.ticker, reply_sk: hex(job.current.reply.secretKey), buyer: guest.account, created: Date.now() };
      saveRun(saved); run.current = saved;
      const { Account, JsonRpcProvider } = await import('near-api-js');
      const acct = new Account(guest.account, new JsonRpcProvider({ url: mode.rpc_url }), guest.secretKey);
      const r: any = await acct.callFunctionRaw({ contractId: ticket.pay.contract, methodName: ticket.pay.method, args: ticket.pay.args, deposit: BigInt(ticket.pay.deposit_yocto), gas: BigInt(ticket.pay.gas_tgas) * 10n ** 12n, waitUntil: 'EXECUTED_OPTIMISTIC' });
      const tx = r.transaction.hash as string;
      saveRun({ ...saved, pay_tx: tx }); run.current = { ...saved, pay_tx: tx };
      await api(`/api/runs/${ticket.run_id}/paid?token=${ticket.run_token}`, { tx_hash: tx });
      setPhase({ name: 'running' });
    } catch (e) { say((e as Error).message, true); setPhase({ name: 'quoted', q }); }
  };

  // follow the run: public progress, plus payloads sealed to this browser's one-time key
  useEffect(() => {
    if (phase.name !== 'running' || !run.current) return;
    const r = run.current; const sk = fromHex(r.reply_sk);
    const es = new EventSource(`/api/runs/${r.run_id}/events?token=${r.token}`);
    const seen = new Set<number>();
    es.onmessage = (m) => {
      let e = JSON.parse(m.data) as Ev;
      if (seen.has(e.seq)) return; seen.add(e.seq);
      if (e.type === 'sealed') { try { e = { ...e, ...open<{ type: string; data: any }>(e.data.envelope, sk), sealed: true }; } catch { return; } }
      setEvents((x) => [...x, e]);
      if (e.type === 'completed') { setPhase({ name: 'done', ok: !!e.data?.ok }); es.close(); }
      if (['failed', 'payment_failed', 'run_not_pending', 'payment_timeout'].includes(e.type)) { setPhase({ name: 'done', ok: false }); es.close(); }
    };
    es.onerror = () => { if (es.readyState === EventSource.CLOSED) setPhase((p) => (p.name === 'running' ? { name: 'done', ok: false } : p)); };
    return () => es.close();
  }, [phase.name]);

  const resumeRun = async () => {
    const r = run.current; if (!r) return;
    try { await api(`/api/runs/${r.run_id}/resume?token=${r.token}`, {}); setEvents([]); setPhase({ name: 'running' }); } catch (e) { say((e as Error).message, true); }
  };

  const q = 'q' in phase ? phase.q : null;
  const result = events.find((e) => e.type === 'result')?.data;
  const detail = events.find((e) => e.type === 'failure_detail')?.data?.error;
  const locked = phase.name !== 'form' && phase.name !== 'quoted';
  return (
    <>
      <div className="panel">
        <Head icon="lock" title={<>{listing.name} <span className="tk">{listing.ticker}</span></>} />
        <div className="body grid" style={{ gap: 10 }}>
          {resume ? <p className="small muted" style={{ margin: 0 }}>Reopened run {resume.run_id} from this browser.</p> : (
            <fieldset disabled={locked} className="plainset grid" style={{ gap: 10 }}>
              {listing.form.map((f) => (
                <div className="field" key={f.id}>
                  <label htmlFor={'lf-' + f.id}>{f.label}{f.type === 'near.account' && <Tip>Any public NEAR mainnet account, e.g. from a block explorer. The recipe only reads it.</Tip>}</label>
                  {f.options ? <select id={'lf-' + f.id} value={values[f.id]} onChange={(e) => setValues({ ...values, [f.id]: e.target.value })}>{f.options.map((o) => <option key={o}>{o}</option>)}</select>
                    : <input id={'lf-' + f.id} value={values[f.id] ?? ''} placeholder={f.placeholder} autoComplete="off" spellCheck={false} aria-invalid={bad.includes(f.id)} aria-describedby={'lf-' + f.id + '-privacy'} onChange={(e) => { setValues({ ...values, [f.id]: e.target.value.toLowerCase() }); if (phase.name === 'quoted') setPhase({ name: 'form' }); }} />}
                  {bad.includes(f.id) && <div className="small" style={{ color: 'var(--loss, #e06c6c)' }}>That doesn't look like a NEAR account id.</div>}
                  {/^(near\.account|address\.near)$/.test(f.type) && (
                    <div className="small muted" id={'lf-' + f.id + '-privacy'}>
                      <Icon name="lock" size={11} /> Encrypted in your browser: only the sealed runner can read it. We don't log or store it, and it never goes on-chain.
                      Like any block explorer, the runner looks up this account's public data from NEAR data providers (FastNEAR, NEAR RPC), which see that lookup.
                    </div>
                  )}
                </div>
              ))}
              <div className="row wrap"><button id="get-quote-btn" className="btn lg" disabled={missing || bad.length > 0 || phase.name === 'quoting'} onClick={getQuote}>{phase.name === 'quoting' ? <><span className="spinner" />Sealing and quoting</> : <><Icon name="receipt" size={16} />Get a sealed quote</>}</button>
                {checks && <span className="small muted"><Icon name="shieldCheck" size={12} /> runner attestation: {checks.passed} checks passed{checks.hardware ? '' : ' (local-dev runner: no hardware quote yet)'}</span>}</div>
            </fieldset>
          )}
        </div>
      </div>

      {q && (
        <div className="panel">
          <Head icon="receipt" title="Quote" tip="Opened in your browser and its runner signature checked against the key registered on-chain. The contract checks the same signature when you pay." />
          <div className="body grid" style={{ gap: 8 }}>
            <dl className="kv">
              <dt>Price</dt><dd><b>{usd(q.price, 4)} tUSDC</b> (test token)</dd>
              <dt>Valid until</dt><dd>{new Date(Number(BigInt(q.expires_ns) / 1_000_000n)).toLocaleTimeString()}</dd>
              <dt>Signed by</dt><dd className="hash">{mode.runner_id}</dd>
            </dl>
            {!guest ? <p className="small muted" style={{ margin: 0 }}>To run it, make a guest account above (it is free and gets test tokens).</p>
              : <button id="pay-btn" className="btn buy lg" style={{ justifySelf: 'start' }} disabled={phase.name === 'paying'} onClick={() => pay(q)}>{phase.name === 'paying' ? <><span className="spinner" />Signing on testnet</> : <><Icon name="bolt" size={16} />Pay {usd(q.price, 4)} tUSDC and run</>}</button>}
          </div>
        </div>
      )}

      {(phase.name === 'running' || phase.name === 'done') && (
        <div className="panel">
          <Head icon="cpu" title="Run" tip="Gold-marked rows were sealed to your browser's one-time key; the marketplace only relayed ciphertext.">{phase.name === 'running' && <><span className="spacer" /><span className="pill warn"><span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />live</span></>}</Head>
          <div className="timeline">
            {run.current?.pay_tx && <div className="tl done"><span className="tic"><Icon name="check" size={13} /></span><div><b>Paid with ft_transfer_call</b><div className="small"><a href={txUrl(run.current.pay_tx)} target="_blank" rel="noreferrer">{short(run.current.pay_tx, 8, 6)} on nearblocks</a></div></div><span className="src"><span className="pill">you</span></span></div>}
            {events.filter((e) => e.type !== 'result').map((e) => {
              const url = e.data?.url ?? (e.data?.tx ? txUrl(e.data.tx) : undefined);
              const fail = /fail|lost|timeout|not_pending/.test(e.type) || e.data?.ok === false;
              return (
                <div key={e.seq} className={'tl ' + (fail ? 'fail' : 'done')}>
                  <span className="tic"><Icon name={fail ? 'x' : 'check'} size={13} /></span>
                  <div><b>{label(e)}</b>{e.data?.error && <div className="small muted">{String(e.data.error)}</div>}{url && <div className="small"><a href={url} target="_blank" rel="noreferrer">view on nearblocks</a></div>}</div>
                  <span className="src">{e.sealed ? <span className="pill sealed"><Icon name="lock" size={11} />sealed</span> : <span className="pill">{e.source}</span>}</span>
                </div>
              );
            })}
          </div>
          {phase.name === 'done' && !phase.ok && <div className="body small">{detail && <p style={{ marginTop: 0 }}><b>Why it failed</b> (sealed to you): {detail}</p>}<button className="btn sm" onClick={resumeRun}>Resume the run</button> <span className="muted">works while the run is still pending on-chain</span></div>}
        </div>
      )}
      {result && (
        <div className="panel">
          <Head icon="check" title="Result"><span className="spacer" /><span className="pill sealed"><Icon name="lock" size={11} />only you can read this</span></Head>
          <div className="body"><Output out={result.output ?? result} /></div>
        </div>
      )}
    </>
  );
}

const LABELS: Record<string, string> = {
  payment_tx: 'Payment landed on the contract', run_requested: 'Run escrowed by the contract', accepted: 'Runner accepted the run', verified: 'Runner checked the on-chain commitments',
  completed: 'Run settled on-chain', failed: 'Run failed', failure_detail: 'Why it failed', checkpoint: 'Progress checkpointed on-chain', reported: 'Runner report sent',
  payment_failed: 'Payment failed', payment_timeout: 'No payment arrived in time', run_not_pending: 'The run is not pending on-chain', runner_lost: 'Lost the runner: resuming', resume_requested: 'Resume requested',
};
function label(e: Ev) {
  if (LABELS[e.type]) return LABELS[e.type];
  if (e.data?.part) return `${e.type.replace(/_/g, ' ')}: ${e.data.part}`;
  return e.type.replace(/_/g, ' ');
}
