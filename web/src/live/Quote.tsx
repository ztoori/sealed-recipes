/**
 * Get a sealed quote, pay and follow the run, laid out like the guided demo's Quote page (pages/Quote.tsx):
 * a progress stepper, the buyer's inputs on the left, the quote, payment, run and result on the right.
 * Everything here is real: the runner's attestation is checked in this browser against the keys registered on-chain,
 * the inputs are sealed to the runner, the quote is opened and its signature checked here, the payment is signed here
 * with the guest key, and the result comes back sealed to a one-time key made here.
 */
import { useEffect, useRef, useState } from 'react';
import nacl from 'tweetnacl';
import { seal, open, sealedHash, type SealedEnvelope } from '../../../core/src/seal';
import { jobHash, openQuote } from '../../../core/src/quotes';
import { verifyRunnerAttestation } from '../../../core/src/attestation';
import { api, short, usePoll, withBase } from '../api';
import { Output } from '../components/RunViews';
import { Icon } from '../icons';
import { Empty, Head, Seal, Tip } from '../ui';
import { fmtNear, tusdc, txUrl, useLive } from './ctx';
import { hex, saveRun, savedRuns, type SavedRun } from './guest';

const STAGES: [string, string][] = [['lock', 'Seal inputs'], ['receipt', 'Quote'], ['wallet', 'Pay'], ['cpu', 'Run'], ['check', 'Settled']];
const SRC_ICON: Record<string, string> = { chain: 'vault', contract: 'vault', runner: 'cpu', part: 'box', market: 'market', you: 'user' };
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
interface Balance { exists: boolean; near_yocto: string; tusdc: string }
type Ev = { seq: number; at: number; source: string; type: string; data: any; sealed?: boolean };
type Phase = { name: 'form' } | { name: 'quoting' } | { name: 'quoted'; q: any } | { name: 'paying'; q: any } | { name: 'running'; q?: any } | { name: 'done'; ok: boolean; q?: any };

export function Quote({ ticker, runId }: { ticker: string; runId?: string }) {
  const { listings, mode, guest, createGuest, fund, funding, go, toast } = useLive();
  const listing = listings?.find((l) => l.ticker === ticker);
  const resume = runId ? savedRuns().find((r) => r.run_id === runId) ?? null : null;
  const [values, setValues] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<Phase>(resume ? { name: 'running' } : { name: 'form' });
  const [checks, setChecks] = useState<{ ok: boolean; hardware: boolean; tdx: boolean; passed: number } | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const job = useRef<{ sealed_job: SealedEnvelope; job_hash: string; reply: nacl.BoxKeyPair; buyer: string } | null>(null);
  const run = useRef<SavedRun | null>(resume);
  const [bal, refreshBal] = usePoll<Balance>(guest ? `/api/account/${guest.account}/balance` : null, 15000, [guest?.account]);
  const buyer = guest?.account ?? '';

  useEffect(() => { if (listing) setValues((v) => (Object.keys(v).length ? v : Object.fromEntries(listing.form.map((f) => [f.id, f.default != null ? String(f.default) : ''])))); }, [listing?.ticker]);

  // follow the run: public progress, plus payloads sealed to this browser's one-time key
  useEffect(() => {
    if (phase.name !== 'running' || !run.current) return;
    const r = run.current; const sk = fromHex(r.reply_sk);
    const es = new EventSource(withBase(`/api/runs/${r.run_id}/events?token=${r.token}`));
    const seen = new Set<number>();
    es.onmessage = (m) => {
      let e = JSON.parse(m.data) as Ev;
      if (seen.has(e.seq)) return; seen.add(e.seq);
      if (e.type === 'sealed') { try { e = { ...e, ...open<{ type: string; data: any }>(e.data.envelope, sk), sealed: true }; } catch { return; } }
      setEvents((x) => [...x, e]);
      if (e.type === 'completed') { setPhase((p) => ({ name: 'done', ok: !!e.data?.ok, q: 'q' in p ? p.q : undefined })); es.close(); refreshBal(); }
      if (['failed', 'payment_failed', 'run_not_pending', 'payment_timeout'].includes(e.type)) { setPhase((p) => ({ name: 'done', ok: false, q: 'q' in p ? p.q : undefined })); es.close(); }
    };
    es.onerror = () => { if (es.readyState === EventSource.CLOSED) setPhase((p) => (p.name === 'running' ? { name: 'done', ok: false, q: p.q } : p)); };
    return () => es.close();
  }, [phase.name]);

  if (listings && !listing) return <div className="panel body">No recipe {ticker} on this contract. <button className="btn ghost sm" onClick={() => go({ page: 'recipes' })}>Back to Recipes</button></div>;
  if (!listing || !mode) return <div className="panel body muted"><span className="spinner" />Loading {ticker}</div>;

  const bad = listing.form.filter((f) => f.type === 'near.account' && values[f.id] && !ACCOUNT_RE.test(values[f.id].trim())).map((f) => f.id);
  const missing = listing.form.some((f) => f.required && !values[f.id]?.trim());
  const price = listing.onchain?.price_per_run ?? listing.price_per_run;

  const getQuote = async (): Promise<any | null> => {
    setPhase({ name: 'quoting' });
    try {
      // 1. check the runner's attestation against the keys registered on-chain, in this browser
      const nonce = hex(nacl.randomBytes(32));
      const { attestation, onchain } = await api<any>(`/api/runner/attestation?nonce=${nonce}`);
      const v = verifyRunnerAttestation(attestation, { nonce, signing_pk: onchain.signing_pk, enc_pk_hex: onchain.enc_pk_hex, codehash: onchain.codehash });
      setChecks({ ok: v.ok, hardware: v.hardware, tdx: attestation.tee === 'dstack-tdx' && !!attestation.quote, passed: v.checks.filter((c) => c.status === 'pass').length });
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
      const quoted = { ...q, ...o };
      setPhase({ name: 'quoted', q: quoted });
      return quoted;
    } catch (e) { toast((e as Error).message, true); setPhase({ name: 'form' }); return null; }
  };

  const pay = async (q: any) => {
    if (!guest || !job.current) return;
    // a quote is bound to the buyer: one made before the guest existed is asked again for the guest, then paid
    if (job.current.buyer !== guest.account) { toast('Asking for a quote bound to your guest account'); const nq = await getQuote(); if (nq && job.current?.buyer === guest.account) await pay(nq); return; }
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
      history.replaceState(null, '', `#/quote/${listing.ticker}/${ticket.run_id}`);
      setPhase({ name: 'running', q });
    } catch (e) { toast((e as Error).message, true); setPhase({ name: 'quoted', q }); }
  };

  const resumeRun = async () => {
    const r = run.current; if (!r) return;
    try { await api(`/api/runs/${r.run_id}/resume?token=${r.token}`, {}); setEvents([]); setPhase({ name: 'running' }); } catch (e) { toast((e as Error).message, true); }
  };
  const again = () => { run.current = null; job.current = null; setEvents([]); setPhase({ name: 'form' }); history.replaceState(null, '', `#/quote/${listing.ticker}`); };

  const q = 'q' in phase ? phase.q : null;
  const result = events.find((e) => e.type === 'result')?.data;
  const detail = events.find((e) => e.type === 'failure_detail')?.data?.error;
  const settled = events.find((e) => e.type === 'completed' && e.data?.ok);
  const locked = phase.name !== 'form' && phase.name !== 'quoted';
  const busy = phase.name === 'quoting' || phase.name === 'paying' || phase.name === 'running';
  const stage = phase.name === 'done' ? (phase.ok ? 5 : 3) : phase.name === 'running' ? 3 : phase.name === 'paying' ? 2 : phase.name === 'quoted' ? (guest ? 2 : 1) : phase.name === 'quoting' ? 1 : 0;
  const poor = !!bal && (!bal.exists || BigInt(bal.tusdc) < BigInt(q?.price ?? price));

  return (
    <div className="grid">
      <div className="panel">
        <ol className="stepper" aria-label="Progress">
          {STAGES.map(([icon, label], i) => <li key={label} className={i < stage ? 'done' : i === stage ? 'now' + (busy ? ' busy' : '') : ''}><span className="sn">{i < stage ? <Icon name="check" size={15} /> : <Icon name={icon} size={15} />}</span><span className="lbl">{label}</span></li>)}
        </ol>
      </div>
      <div className="grid runpage">
        <section className="grid">
          <div className="panel">
            <header><button className="btn ghost sm icon-only" aria-label={'Back to ' + listing.name} onClick={() => go({ page: 'recipes', ticker })}><Icon name="back" size={15} /></button><h2>Your inputs</h2><span className="spacer" /><span className="small muted">{guest ? `as guest ${short(guest.account, 6, 4)}` : 'no account needed to quote'}</span></header>
            <div className="body grid" style={{ gap: 10 }}>
              <div className="quote-recipe">
                <Seal ticker={ticker} kind={listing.output_type} size={48} />
                <div style={{ minWidth: 0 }}><b>{listing.name}</b> <span className="tk">{ticker}</span>
                  <div className="tags">
                    <span className="tag">{tusdc(price)} tUSDC / run</span>
                    <span className="tag"><Icon name="check" size={12} />{String(listing.onchain?.runs ?? 0)} runs on-chain</span>
                    <span className={'tag risk-' + listing.risk}><i className="dot" />{listing.risk} risk</span>
                  </div>
                </div>
              </div>
              {resume ? <p className="small muted" style={{ margin: 0 }}>Reopened run <span className="hash">{resume.run_id}</span> from this browser, started {new Date(resume.created).toLocaleString()}.</p> : (
                <fieldset disabled={locked} className="plainset grid" style={{ gap: 10 }}>
                  {listing.form.map((f) => (
                    <div className="field" key={f.id}>
                      <label htmlFor={'lf-' + f.id}>{f.label}{f.type === 'near.account' && <Tip>Any public NEAR mainnet account, e.g. from a block explorer. The recipe only reads it.</Tip>}</label>
                      {f.options ? <select id={'lf-' + f.id} value={values[f.id] ?? ''} onChange={(e) => { setValues({ ...values, [f.id]: e.target.value }); if (phase.name === 'quoted') setPhase({ name: 'form' }); }}>{f.options.map((o) => <option key={o}>{o}</option>)}</select>
                        : <input id={'lf-' + f.id} value={values[f.id] ?? ''} placeholder={f.placeholder} autoComplete="off" spellCheck={false} aria-invalid={bad.includes(f.id)} aria-describedby={'lf-' + f.id + '-privacy'} onChange={(e) => { setValues({ ...values, [f.id]: e.target.value.toLowerCase() }); if (phase.name === 'quoted') setPhase({ name: 'form' }); }} />}
                      {bad.includes(f.id) && <div className="small" style={{ color: 'var(--loss)' }}>That doesn't look like a NEAR account id.</div>}
                      {/^(near\.account|address\.near)$/.test(f.type) && (
                        <div className="small muted" id={'lf-' + f.id + '-privacy'}>
                          <Icon name="lock" size={11} /> Encrypted in your browser: only the sealed runner can read it. We don't log or store it, and it never goes on-chain.
                          Like any block explorer, the runner looks up this account's public data from NEAR data providers (FastNEAR, NEAR RPC), which see that lookup.
                        </div>
                      )}
                    </div>
                  ))}
                </fieldset>
              )}
              {phase.name === 'done' || resume
                ? <button className="btn lg" onClick={again}><Icon name="refresh" size={15} />Get another quote</button>
                : <button id="get-quote-btn" className="btn lg" disabled={missing || bad.length > 0 || busy} onClick={() => { void getQuote(); }}>{phase.name === 'quoting' ? <><span className="spinner" />Sealing and quoting</> : phase.name === 'quoted' ? <><Icon name="refresh" size={15} />Quote again</> : <><Icon name="lock" size={15} />Seal and get a quote</>}</button>}
              {checks && <div className="row wrap small" style={{ gap: 6 }}>{checks.ok ? <span className="pill ok"><Icon name="cpu" size={12} />runner verified · {checks.passed} checks</span> : <span className="pill bad">runner attestation failed</span>} {!checks.hardware && (checks.tdx
                ? <span className="pill ok" title="The runner sent an Intel TDX quote that carries its keys and your nonce. Intel's signature chain is checked by the operator (scripts/testnet/tee-identity.ts) before registration; this browser does not check it yet.">TDX quote</span>
                : <span className="pill warn" title="The runner is the local-dev build: real keys and signatures, no hardware TEE quote yet">no hardware quote yet</span>)}</div>}
            </div>
          </div>
        </section>

        <section className="grid" style={{ minWidth: 0, alignContent: 'start' }}>
          {phase.name === 'form' && <div className="panel"><div className="quote-wait">
            <span className="big-ic"><Icon name="lock" size={28} /></span>
            <b>Your inputs are sealed before they leave</b>
            <p>{ticker} quotes from a private dry run and signs a quote only this browser can open. Quotes are free and need no account.</p>
            <div className="mini-flow"><span><Icon name="user" size={13} />You</span><Icon name="arrow" size={13} className="arrow-ic" /><span><Icon name="cpu" size={13} />Sealed runner</span><Icon name="arrow" size={13} className="arrow-ic" /><span><Icon name="receipt" size={13} />Signed quote</span></div>
          </div></div>}
          {phase.name === 'quoting' && <div className="panel"><div className="quote-wait"><span className="big-ic"><span className="spinner" style={{ width: 26, height: 26, borderWidth: 3 }} /></span><b>Dry run inside the sealed runner</b><p>Real mainnet data, read-only. Nothing is spent until you pay.</p></div></div>}

          {q && (
            <div className="panel" id="quote">
              <Head icon="receipt" title={`${ticker}'s quote`} tip="Opened in this browser and its runner signature checked against the key registered on-chain. The contract checks the same signature when you pay."><span className="spacer" /><span className="pill ok"><Icon name="check" size={12} />signature verified</span></Head>
              <div className="body grid" style={{ gap: 10 }}>
                <div className="quote-figs">
                  <div><span><Icon name="lock" size={13} />Price</span><b>{tusdc(q.price, 2)}</b><small>tUSDC, locked</small></div>
                  <div><span><Icon name="clock" size={13} />Valid until</span><b>{new Date(Number(BigInt(q.expires_ns) / 1_000_000n)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b></div>
                  <div><span><Icon name="cpu" size={13} />Signed by</span><b className="hash" style={{ fontSize: 13 }}>{mode.runner_id}</b></div>
                </div>
                {q.details?.output?.title && <div className="small">Dry run says: <b>{q.details.output.title}</b></div>}
                <div className="row wrap small" style={{ gap: 6 }}>
                  {q.track && <span className="tag"><Icon name="check" size={12} />{q.track.runs} run{String(q.track.runs) === '1' ? '' : 's'}{Number(q.track.failed) ? `, ${q.track.failed} refunded` : ''}</span>}
                  <span className={'tag' + (listing.privacy === 'confidential' ? ' sealed' : '')}><Icon name={listing.privacy === 'confidential' ? 'lock' : 'eye'} size={12} />{listing.privacy}</span>
                </div>
              </div>
            </div>
          )}

          {(phase.name === 'quoted' || phase.name === 'paying') && q && (
            <div className="panel">
              <Head icon="wallet" title="Pay" tip="On NEAR testnet, with tUSDC (a test token with no value): the guest key in this browser signs ft_transfer_call to the contract, carrying the signed quote." />
              <div className="body grid" style={{ gap: 8 }}>
                {!guest ? (
                  <>
                    <p className="small" style={{ margin: 0 }}>To run it, continue as a guest: a key made in this browser, given test tokens by our faucet. No sign-up, no real money.</p>
                    <button className="btn primary lg" style={{ justifySelf: 'start' }} disabled={funding} onClick={createGuest}>{funding ? <><span className="spinner" />Creating</> : <><Icon name="sparkles" size={15} />Continue as guest</>}</button>
                  </>
                ) : (
                  <>
                    <dl className="kv">
                      <dt><Icon name="user" size={14} />From</dt><dd className="hash">{short(guest.account, 10, 8)}</dd>
                      <dt><Icon name="wallet" size={14} />Balance</dt><dd>{bal ? (bal.exists ? <>{tusdc(bal.tusdc)} tUSDC · {fmtNear(bal.near_yocto)} NEAR for gas</> : 'not on-chain yet') : <span className="spinner" />}</dd>
                      <dt><Icon name="vault" size={14} />Contract receives</dt><dd>{tusdc(q.price, 4)} tUSDC</dd>
                    </dl>
                    {poor && <div className="row wrap small"><span className="muted">Not enough test tokens yet.</span><button className="btn sm" disabled={funding} onClick={async () => { await fund(guest); refreshBal(); }}>{funding ? <span className="spinner" /> : 'Get test tokens'}</button></div>}
                    <button id="pay-btn" className="btn buy lg" style={{ justifySelf: 'start' }} disabled={phase.name === 'paying'} onClick={() => pay(q)}>{phase.name === 'paying' ? <><span className="spinner" />Signing on testnet</> : <><Icon name="bolt" size={16} />Pay {tusdc(q.price, 4)} tUSDC and run</>}</button>
                  </>
                )}
              </div>
            </div>
          )}

          {(phase.name === 'running' || phase.name === 'done') && (
            <div className="panel">
              <Head icon="cpu" title="Run" tip="Payment → on-chain escrow → sealed runner → settlement. Gold-marked rows were sealed to your browser's one-time key; the marketplace only relayed ciphertext.">{phase.name === 'running' && <><span className="spacer" /><span className="pill warn"><span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />live</span></>}</Head>
              {!events.length && phase.name === 'running' && <div className="body row muted"><span className="spinner" />Waiting for the payment to reach the contract</div>}
              <div className="timeline">
                {run.current?.pay_tx && <div className="tl done"><span className="tic"><Icon name="check" size={13} /></span><div><b>Paid with ft_transfer_call</b><div className="small"><a href={txUrl(run.current.pay_tx)} target="_blank" rel="noreferrer">{short(run.current.pay_tx, 8, 6)} on nearblocks</a></div></div><span className="src"><span className="pill"><Icon name="user" size={11} />you</span></span></div>}
                {events.filter((e) => e.type !== 'result').map((e, i, all) => {
                  const url = e.data?.url ?? (e.data?.tx ? txUrl(e.data.tx) : undefined);
                  const fail = /fail|lost|timeout|not_pending|rejected/.test(e.type) || e.data?.ok === false;
                  const live = !fail && phase.name === 'running' && i === all.length - 1;
                  return (
                    <div key={e.seq} className={'tl ' + (fail ? 'fail' : live ? 'live' : 'done')}>
                      <span className="tic">{fail ? <Icon name="x" size={13} /> : live ? <Icon name={SRC_ICON[e.source] ?? 'cpu'} size={13} /> : <Icon name="check" size={13} />}</span>
                      <div><b>{label(e)}</b>{e.data?.error && <div className="small muted">{String(e.data.error)}</div>}{url && <div className="small"><a href={url} target="_blank" rel="noreferrer">view on nearblocks</a></div>}</div>
                      <span className="src">{e.sealed ? <span className="pill sealed" title="Sealed to your browser key; the marketplace only relayed ciphertext"><Icon name="lock" size={11} />sealed</span> : <span className="pill"><Icon name={SRC_ICON[e.source] ?? 'cpu'} size={11} />{e.source}</span>}</span>
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
          {settled && (
            <div className="panel" id="settlement">
              <Head icon="receipt" title="Settled on-chain" />
              <div className="body grid" style={{ gap: 8 }}>
                <p className="small" style={{ margin: 0 }}>The contract checked the runner’s signed report and paid the protocol, the runner, the part authors and the creator in the same settlement.</p>
                <div className="row wrap">
                  {(settled.data?.url || settled.data?.tx) && <a className="btn ghost sm" href={settled.data.url ?? txUrl(settled.data.tx)} target="_blank" rel="noreferrer"><Icon name="link" size={13} />Settlement on nearblocks</a>}
                  <button className="btn ghost sm" onClick={() => go({ page: 'recipes', ticker })}><Icon name="clock" size={13} />{ticker}’s track record</button>
                  <button className="btn ghost sm" onClick={() => go({ page: 'wallet' })}><Icon name="wallet" size={13} />Your runs</button>
                </div>
              </div>
            </div>
          )}
          {phase.name === 'done' && !result && !settled && phase.ok && <div className="panel"><Empty icon="check">Run finished.</Empty></div>}
        </section>
      </div>
    </div>
  );
}

const LABELS: Record<string, string> = {
  payment_tx: 'Payment landed on the contract', run_requested: 'Run escrowed by the contract', accepted: 'Runner accepted the run', verified: 'Runner checked the on-chain commitments',
  completed: 'Run settled on-chain', settled: 'Report accepted by the contract', report_rejected: 'The contract rejected the report', failed: 'Run failed', failure_detail: 'Why it failed', checkpoint: 'Progress checkpointed on-chain', reported: 'Runner report sent',
  payment_failed: 'Payment failed', payment_timeout: 'No payment arrived in time', run_not_pending: 'The run is not pending on-chain', runner_lost: 'Lost the runner: resuming', resume_requested: 'Resume requested',
};
function label(e: Ev) {
  if (LABELS[e.type]) return LABELS[e.type];
  if (e.data?.part) return `${e.type.replace(/_/g, ' ')}: ${e.data.part}`;
  return e.type.replace(/_/g, ' ');
}
