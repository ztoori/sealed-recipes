import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import nacl from 'tweetnacl';
import { seal, open, sealedHash, type SealedEnvelope } from '../../../core/src/seal';
import { jobHash, openQuote } from '../../../core/src/quotes';
import { measuresValue } from '../../../core/src/srs';
import { verifyRunnerAttestation } from '../../../core/src/attestation';
import { api, ASSET_LABEL, money, PAY_ASSETS, runnerAttestation, short, usd, usePoll } from '../api';
import { useApp, useStoryOnce } from '../App';
import { SettlementFlow } from '../components/Sankey';
import { Output, timeline, type Ev } from '../components/RunViews';
import { LOCKED, quoteReducer } from './quote-machine';
import { Icon } from '../icons';
import { Empty, Head, Seal, Tip } from '../ui';

const STAGES: [string, string][] = [['lock', 'Seal inputs'], ['receipt', 'Quote'], ['wallet', 'Pay'], ['cpu', 'Run'], ['check', 'Settled']];
const SRC_ICON: Record<string, string> = { 'NEAR Intents': 'globe', contract: 'vault', runner: 'cpu', part: 'box', market: 'market' };

const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');


export function Quote({ ticker }: { ticker: string }) {
  const { acting, story, toast, go } = useApp();
  const once = useStoryOnce();
  const [m] = usePoll<any>(`/api/recipe/${ticker}`, 3000, [ticker]);
  const [cat] = usePoll<any>('/api/catalog', 60000);
  const listing = m?.listing;
  const form: any[] = listing?.form ?? [];
  const [phase, dispatch] = useReducer(quoteReducer, { name: 'form' });
  const [values, setValues] = useState<Record<string, string>>({});
  const [freshKey, setFreshKey] = useState<{ account: string; sk: Uint8Array } | null>(null);
  const [payAsset, setPayAsset] = useState(PAY_ASSETS[0].id);
  const [maxPrice, setMaxPrice] = useState('');
  const [runnerOk, setRunnerOk] = useState<null | { ok: boolean; hardware: boolean }>(null);
  const jobRef = useRef<{ sealed: SealedEnvelope; job_hash: string } | null>(null);
  const reply = useRef<nacl.BoxKeyPair | null>(null); // one-time key: the runner seals everything about these inputs and this run to it
  const [allEvents, setEvents] = useState<Ev[]>([]);
  const [shown, setShown] = useState(0);
  const maxUnits = () => (maxPrice.trim() && Number(maxPrice) > 0 ? String(Math.round(Number(maxPrice) * 1e6)) : undefined);
  const locked = LOCKED.has(phase.name) || phase.name === 'finished';

  // defaults for the form, once the listing is known
  const formKey = form.map((f) => f.id).join(',');
  useEffect(() => {
    const v: Record<string, string> = {};
    for (const f of form) v[f.id] = f.type === 'near.account' && /wallet/i.test(f.id + f.label) ? acting : f.default != null ? String(f.default) : '';
    setValues(v); setFreshKey(null);
  }, [formKey, acting]);
  const edit = (id: string, v: string) => { setValues((x) => ({ ...x, [id]: v })); dispatch({ t: 'edit' }); };
  const genFresh = (fid: string) => { const kp = nacl.sign.keyPair(); const account = hex(kp.publicKey); setFreshKey({ account, sk: kp.secretKey }); edit(fid, account); };
  const downloadKey = () => {
    if (!freshKey) return;
    const blob = new Blob([JSON.stringify({ account_id: freshKey.account, public_key: 'ed25519:' + freshKey.account, secret_key_hex: hex(freshKey.sk), note: 'Fresh implicit NEAR account generated in your browser by Sealed Recipes. Keep this file private.' }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `fresh-${freshKey.account.slice(0, 8)}.json`; a.click();
  };

  /** Seal the inputs once to the attested runner, then this recipe quotes from a dry run, signed. */
  const getQuote = async () => {
    dispatch({ t: 'quote' });
    setEvents([]); setShown(0);
    try {
      const nonce = hex(crypto.getRandomValues(new Uint8Array(32)));
      const { attestation, onchain } = await runnerAttestation(nonce);
      const v = verifyRunnerAttestation(attestation, { nonce, signing_pk: onchain.signing_pk, enc_pk_hex: onchain.enc_pk_hex, codehash: onchain.codehash });
      setRunnerOk({ ok: v.ok, hardware: v.hardware });
      if (!v.ok) throw new Error('runner attestation failed; refusing to send your inputs');
      const inputs: Record<string, unknown> = {};
      for (const f of form) {
        const raw = (values[f.id] ?? '').trim();
        if (!raw) throw new Error(`${f.label} is required${f.generator === 'fresh-implicit' ? ': press Generate' : ''}`);
        if ((f.type === 'usd' || f.type === 'percent') && !(Number(raw) >= 0)) throw new Error(`${f.label} must be a number`);
        inputs[f.id] = f.type === 'usd' || f.type === 'percent' ? Number(raw) : raw;
      }
      reply.current = nacl.box.keyPair();
      const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
      const job_hash = jobHash(inputs, salt);
      const sealed = seal({ inputs, salt, reply_to: hex(reply.current.publicKey) }, onchain.enc_pk_hex, 'inputs');
      jobRef.current = { sealed, job_hash };
      const { contract_id } = await api('/api/chain/config');
      const mp = maxUnits();
      const { quote: q } = await api('/api/quotes', { recipe_id: ticker, sealed_job: sealed, job_hash, buyer: acting, ...(mp ? { max_price: mp } : {}) });
      if (q.ok && q.sealed_quote) {
        // opened with this browser's one-time key; the runner signature is checked against the exact message the contract will verify
        try { const o = openQuote(q.sealed_quote, reply.current.secretKey, { contractId: contract_id, signingPk: onchain.signing_pk, buyer: acting, inputsHash: sealedHash(sealed), jobHash: job_hash, recipeId: ticker }); Object.assign(q, o, { ok: o.verified, error: o.problem }); }
        catch { Object.assign(q, { ok: false, error: 'quote could not be opened with your key' }); }
      }
      dispatch(q.ok ? { t: 'quoted', q } : { t: 'unquotable', error: q.error ?? 'no quote' });
    } catch (e) { toast((e as Error).message, true); dispatch({ t: 'quote_failed' }); }
  };

  const choose = async (guaranteed: boolean) => {
    if (phase.name !== 'quoted' || !jobRef.current) return;
    const q = phase.q;
    dispatch({ t: 'choose', guaranteed });
    try {
      const pa = PAY_ASSETS.find((p) => p.id === payAsset)!;
      const r = await api('/api/runs/quote', { recipe_id: ticker, buyer: acting, pay_asset: payAsset, refund_to: pa.refund, sealed_inputs: jobRef.current.sealed,
        // with the quote, its signed price is locked; without it, the list price applies and the shown price is the cap
        ...(guaranteed ? { signed_quote: { sealed_hash: q.sealed_hash, job_hash: q.job_hash, price: q.price, expected: q.expected, promised: q.promised, cover: q.cover, expires_ns: q.expires_ns, signature: q.signature } } : { max_price: maxUnits() ?? String(q.price ?? q.listing.price_per_run) }) });
      dispatch({ t: 'prepared', pay: r });
    } catch (e) { toast((e as Error).message, true); dispatch({ t: 'prepare_failed' }); }
  };
  const pay = async () => {
    if (phase.name !== 'ready') return;
    dispatch({ t: 'pay' });
    try { await api(`/api/runs/${phase.pay.run_id}/pay?token=${phase.pay.run_token}`, {}); dispatch({ t: 'paid' }); }
    catch (e) { toast((e as Error).message, true); dispatch({ t: 'pay_failed' }); }
  };

  // the run's event stream (while running and after), opened with the reply key
  const runId = 'pay' in phase ? phase.pay.run_id : null;
  const runToken = 'pay' in phase ? phase.pay.run_token : '';
  useEffect(() => {
    if (!runId || (phase.name !== 'running' && phase.name !== 'finished')) return;
    const es = new EventSource(`/api/runs/${runId}/events?token=${runToken}`);
    es.onmessage = (msg) => {
      let e = JSON.parse(msg.data) as Ev;
      if (e.type === 'sealed' && reply.current) {
        try { const inner = open<{ type: string; data: any }>(e.data.envelope as SealedEnvelope, reply.current.secretKey); e = { ...e, type: inner.type, data: inner.data, sealed: true }; } catch { return; }
      }
      setEvents((x) => (x.some((y) => y.seq === e.seq) ? x : [...x, e]));
    };
    return () => es.close();
  }, [runId, phase.name === 'running' || phase.name === 'finished']);
  // reveal events one by one so a human can follow the run (presentation only; the run itself is not slowed)
  useEffect(() => {
    if (shown >= allEvents.length) return;
    const t = setTimeout(() => setShown((n) => n + 1), story.step ? 420 : 160);
    return () => clearTimeout(t);
  }, [shown, allEvents.length, story.step]);
  const events = useMemo(() => allEvents.slice(0, shown), [allEvents, shown]);
  const completed = events.find((e) => e.type === 'completed');
  const failed = events.find((e) => e.type === 'failed' || e.type === 'payment_rejected');
  useEffect(() => { if (phase.name === 'running' && (completed || failed)) dispatch({ t: 'ended', ok: !!completed?.data?.ok }); }, [!!completed, !!failed, phase.name]);
  useEffect(() => { if (story.step && shown) document.querySelector('.tl:last-child')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [shown, story.step]);

  const approval = useMemo(() => {
    const req = [...events].reverse().find((e) => e.type === 'approval_required');
    const res = req && events.find((e) => e.type === 'approval_result' && e.seq > req.seq);
    return req && !res ? req.data : null;
  }, [events]);
  const [approving, setApproving] = useState(false);
  // a signed quote expires: once it has, it can only be refreshed, not used
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (phase.name !== 'quoted') return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [phase.name]);
  const approve = async (ok: boolean) => {
    if (!runId || approving) return;
    setApproving(true);
    try { await api(`/api/runs/${runId}/approve?token=${runToken}`, { approved: ok, transactions: ok ? approval?.transactions : [], ...(ok && approval?.sign_message ? { sign_message: approval.sign_message } : {}) }); }
    catch (e) { toast((e as Error).message, true); } finally { setApproving(false); }
  };

  // ---------- story automation (steps 2-4) ----------
  useEffect(() => {
    if (story.step !== 2 || !listing || phase.name !== 'form' || !once('quote')) return;
    (async () => {
      await new Promise((r) => setTimeout(r, 900));
      const fid = form.find((f) => f.generator === 'fresh-implicit')?.id; if (fid) genFresh(fid);
      await new Promise((r) => setTimeout(r, 1200));
      document.getElementById('get-quote-btn')?.click();
    })();
  }, [story.step, !!listing]);
  useEffect(() => { if (story.step === 2 && phase.name === 'quoted' && once('choose')) { const t = setTimeout(() => document.getElementById('choose-guaranteed')?.click(), 4200); return () => clearTimeout(t); } }, [phase.name, story.step]);
  useEffect(() => { if (story.step === 2 && phase.name === 'ready' && once('pay')) { const t = setTimeout(() => document.getElementById('pay-btn')?.click(), 2200); return () => clearTimeout(t); } }, [phase.name, story.step]);
  useEffect(() => { if (story.step === 2 && events.some((e) => e.type === 'decrypted')) story.advance(2); }, [events, story.step]);
  useEffect(() => { if (story.step === 3 && approval) { const t = setTimeout(() => approve(true), 2600); return () => clearTimeout(t); } }, [approval, story.step]);
  useEffect(() => { if (story.step === 3 && completed) { story.advance(3); setTimeout(() => document.getElementById('settlement')?.scrollIntoView({ behavior: 'smooth' }), 400); } }, [completed, story.step]);
  useEffect(() => { if (story.step === 4) { const t = setTimeout(() => story.advance(4), 9000); return () => clearTimeout(t); } }, [story.step]);

  if (m && !listing) return <div className="panel body">No recipe {ticker}. <button className="btn ghost sm" onClick={() => go({ page: 'recipes' })}>Back to Recipes</button></div>;
  if (!listing) return <div className="panel body muted">Loading {ticker}…</div>;
  const rec = m.record;
  const rows = timeline(events);
  const settlement = completed?.data?.settlement;
  const settleEv = events.find((e) => e.type === 'srs_settlement')?.data;
  const result = events.find((e) => e.type === 'result')?.data;
  const q = 'q' in phase ? phase.q : null;
  const guaranteed = 'guaranteed' in phase ? phase.guaranteed : true;
  const metric = !!cat && measuresValue(cat.types, listing?.output_type); // swap receipts: the quote promises a value
  const expired = phase.name === 'quoted' && q && now > Number(BigInt(q.expires_ns) / 1_000_000n);
  const busy = LOCKED.has(phase.name);
  const stage = phase.name === 'finished' ? (settlement?.payouts ? 5 : 4) : phase.name === 'running' ? 3 : phase.name === 'ready' || phase.name === 'paying' ? 2 : phase.name === 'quoted' || phase.name === 'preparing' ? 1 : 0;

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
            <header><button className="btn ghost sm icon-only" aria-label={'Back to ' + listing.name} onClick={() => go({ page: 'recipes', ticker })}><Icon name="back" size={15} /></button><h2>Your inputs</h2><span className="spacer" /><span className="small muted">as {acting}</span></header>
            <div className="body grid" style={{ gap: 10 }}>
              <div className="quote-recipe">
                <Seal ticker={ticker} kind={listing.output_type} size={48} />
                <div style={{ minWidth: 0 }}><b>{listing.name}</b> <span className="tk">{ticker}</span>
                  <div className="tags">
                    <span className="tag">{money(rec.pricePerRun)} / run</span>
                    <span className="tag"><Icon name="shield" size={12} />{money(rec.deposit.available, 0)}</span>
                    <span className={'tag risk-' + listing.risk}><i className="dot" />{listing.risk} risk</span>
                  </div>
                </div>
              </div>
              <fieldset disabled={locked} className="plainset grid" style={{ gap: 10 }}>
                {form.map((f) => (
                  <div className="field" key={f.id}>
                    <label htmlFor={'f-' + f.id}>{f.label}{f.generator === 'fresh-implicit' && <Tip>A new keypair made in this browser. Only the address goes into your sealed inputs; the key never leaves your device.</Tip>}</label>
                    {f.options ? (
                      <select id={'f-' + f.id} value={values[f.id] ?? ''} onChange={(e) => edit(f.id, e.target.value)}>{f.options.map((o: string) => <option key={o} value={o}>{ASSET_LABEL[o] ?? o}</option>)}</select>
                    ) : f.generator === 'fresh-implicit' ? (
                      <div className="fresh"><input id={'f-' + f.id} value={values[f.id] ? short(values[f.id], 12, 8) : ''} readOnly placeholder="press Generate" />
                        <button className="btn ghost sm" onClick={() => genFresh(f.id)}><Icon name="sparkles" size={13} />Generate</button>
                        {freshKey && <button className="btn ghost sm icon-only" aria-label="Save key" title="Save the key file" onClick={downloadKey}><Icon name="download" size={14} /></button>}</div>
                    ) : (
                      <input id={'f-' + f.id} value={values[f.id] ?? ''} placeholder={f.placeholder} inputMode={f.type === 'usd' || f.type === 'percent' ? 'decimal' : undefined} onChange={(e) => edit(f.id, e.target.value)} />
                    )}
                  </div>
                ))}
                <div className="field"><label htmlFor="maxp">Max price per run<Tip>Optional. If the recipe's price is above it, it isn't asked to quote, and the contract refuses to charge more.</Tip></label>
                  <input id="maxp" value={maxPrice} onChange={(e) => { setMaxPrice(e.target.value.replace(/[^0-9.]/g, '')); dispatch({ t: 'edit' }); }} inputMode="decimal" placeholder="no limit" /></div>
                <div className="field"><label htmlFor="pay">Pay with<Tip>Any of these, through NEAR Intents: the contract always receives USDC.</Tip></label>
                  <select id="pay" value={payAsset} onChange={(e) => { setPayAsset(e.target.value); dispatch({ t: 'edit' }); }}>{PAY_ASSETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></div>
              </fieldset>
              {phase.name === 'finished'
                ? <button className="btn lg" onClick={() => { dispatch({ t: 'again' }); setEvents([]); setShown(0); const fid = form.find((f) => f.generator === 'fresh-implicit')?.id; if (fid) { setFreshKey(null); setValues((v) => ({ ...v, [fid]: '' })); } }}><Icon name="refresh" size={15} />Get another quote</button>
                : <button id="get-quote-btn" className="btn lg" disabled={busy || phase.name === 'ready' || phase.name === 'running'} onClick={getQuote}>{phase.name === 'quoting' ? <><span className="spinner" />Sealing and quoting</> : phase.name === 'quoted' || phase.name === 'unquotable' ? <><Icon name="refresh" size={15} />Quote again</> : <><Icon name="lock" size={15} />Seal and get a quote</>}</button>}
              {runnerOk && <div className="row wrap small" style={{ gap: 6 }}>{runnerOk.ok ? <span className="pill ok"><Icon name="cpu" size={12} />runner verified</span> : <span className="pill bad">runner attestation failed</span>} {!runnerOk.hardware && <span className="pill warn" title="Local development: no hardware TEE quote">no TEE (local)</span>}</div>}
            </div>
          </div>
        </section>

        <section className="grid" style={{ minWidth: 0, alignContent: 'start' }}>
          {phase.name === 'form' && <div className="panel"><div className="quote-wait">
            <span className="big-ic"><Icon name="lock" size={28} /></span>
            <b>Your inputs are sealed before they leave</b>
            <p>{ticker} quotes from a private dry run and signs a promise only this browser can open.</p>
            <div className="mini-flow"><span><Icon name="user" size={13} />You</span><Icon name="arrow" size={13} className="arrow-ic" /><span><Icon name="cpu" size={13} />Sealed runner</span><Icon name="arrow" size={13} className="arrow-ic" /><span><Icon name="receipt" size={13} />Signed quote</span></div>
          </div></div>}
          {phase.name === 'quoting' && <div className="panel"><div className="quote-wait"><span className="big-ic"><span className="spinner" style={{ width: 26, height: 26, borderWidth: 3 }} /></span><b>Dry run inside the sealed runner</b><p>Nothing is spent until you pay.</p></div></div>}
          {phase.name === 'unquotable' && <div className="panel"><Empty icon="alert"><b>{ticker} could not quote these inputs.</b><div className="small">{phase.error}</div></Empty></div>}
          {q && (
            <div className="panel" id="quote">
              <Head icon="receipt" title={`${ticker}'s quote`} tip="From a dry run inside the sealed runner. The signature is checked in this browser against the exact message the contract will verify."><span className="spacer" /><span className="pill ok"><Icon name="check" size={12} />signature verified</span></Head>
              <div className="body grid" style={{ gap: 10 }}>
                <div className="quote-figs">
                  {metric && <div><span><Icon name="trend" size={13} />Expected</span><b>{usd(q.expected, 2)}</b></div>}
                  {metric && <div className="promise"><span><Icon name="shield" size={13} />Promised</span><b>{usd(q.promised, 2)}</b><small>{Number(q.cover) > 0 ? `${usd(q.cover, 2)} covered` : 'no cover'}</small></div>}
                  <div><span><Icon name="lock" size={13} />Price</span><b>{usd(q.price, 2)}</b><small>locked</small></div>
                  <div><span><Icon name="clock" size={13} />Valid until</span><b>{new Date(Number(BigInt(q.expires_ns) / 1_000_000n)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b></div>
                </div>
                {!metric && q.details?.output?.title && <div className="small">Dry run says: <b>{q.details.output.title}</b></div>}
                <div className="row wrap small" style={{ gap: 6 }}>
                  <span className="tag"><Icon name="check" size={12} />{q.track.runs} run{q.track.runs === 1 ? '' : 's'}{Number(q.track.failed) ? `, ${q.track.failed} refunded` : ''}</span>
                  {Number(q.track.promised_total) > 0 && <span className="tag"><Icon name="target" size={12} />{(Number(q.track.delivered_total) / Number(q.track.promised_total) * 100).toFixed(0)}% of promises kept</span>}
                  <span className={'tag' + (listing.privacy === 'confidential' ? ' sealed' : '')}><Icon name={listing.privacy === 'confidential' ? 'lock' : 'eye'} size={12} />{listing.privacy}</span>
                </div>
                {expired && <div className="diag warning">This quote expired. Press Quote again for a fresh one.</div>}
                {phase.name === 'quoted' && !expired && <div className="row wrap">
                  <button id="choose-guaranteed" className="btn lg" onClick={() => choose(true)} title="Its price is locked and its promise is backed by the guarantee deposit"><Icon name="shieldCheck" size={16} />Use this quote{metric ? ' (guaranteed)' : ''}</button>
                  {metric && <button className="btn ghost" onClick={() => choose(false)} title="Pay without the quote: no guarantee, and no promised or delivered value written on-chain">Run without a guarantee</button>}
                  <Tip wide>The promise is bound to your account and these inputs. If the run delivers less, the contract pays the shortfall from the guarantee deposit in the same settlement. Right before executing, the runner re-prices the run; if your wallet changed since the quote, it aborts and you are refunded.</Tip>
                </div>}
                {phase.name === 'preparing' && <div className="row small muted"><span className="spinner" />Getting a payment quote from 1Click</div>}
              </div>
            </div>
          )}

          {'pay' in phase && (
            <div className="panel">
              <Head icon="wallet" title="Pay" tip="Through NEAR Intents (1Click, EXACT_OUTPUT): you send any supported asset, the contract receives exactly the run price in USDC." />
              <div className="body grid" style={{ gap: 8 }}>
                <dl className="kv">
                  <dt><Icon name="arrow" size={14} />You send</dt><dd>{phase.pay.quote.quote.amountInFormatted} {PAY_ASSETS.find((p) => p.id === payAsset)?.label}</dd>
                  <dt><Icon name="vault" size={14} />Contract receives</dt><dd>{usd(phase.pay.quote.quote.amountOut, 2)} USDC</dd>
                  <dt><Icon name="shield" size={14} />Guarantee</dt><dd>{guaranteed && metric ? <>{usd(q.promised, 2)} promised, covered up to {usd(q.cover, 2)}</> : guaranteed ? 'signed price' : 'none'}</dd>
                  <dt><Icon name="link" size={14} />Deposit address</dt><dd className="hash">{short(phase.pay.quote.quote.depositAddress, 10, 8)}</dd>
                  <dt><Icon name="ticket" size={14} />Run ticket</dt><dd className="hash">{phase.pay.run_id}</dd>
                </dl>
                <details className="small"><summary>Message to the contract</summary><pre className="codebox">{JSON.stringify(JSON.parse(phase.pay.msg), null, 1)}</pre></details>
                {(phase.name === 'ready' || phase.name === 'paying') && <button id="pay-btn" className="btn buy lg" disabled={phase.name === 'paying'} onClick={pay} style={{ justifySelf: 'start' }}>{phase.name === 'paying' ? <><span className="spinner" />Sending</> : <><Icon name="bolt" size={16} />Pay {phase.pay.quote.quote.amountInFormatted} and run</>}</button>}
              </div>
            </div>
          )}

          {(phase.name === 'running' || phase.name === 'finished') && (
            <div className="panel">
              <Head icon="cpu" title="Run" tip="Payment → on-chain escrow → sealed runner → settlement. Gold-marked details were sealed to your browser key; the marketplace only relayed ciphertext.">{phase.name === 'running' && <><span className="spacer" /><span className="pill warn"><span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />live</span></>}</Head>
              {!rows.length && <div className="body row muted"><span className="spinner" />Waiting for the deposit to reach the contract</div>}
              <div className="timeline">
                {rows.map((r, i) => (
                  <div key={i} className={'tl ' + (r.state === 'fail' ? 'fail' : i === rows.length - 1 && phase.name === 'running' ? 'live' : 'done')}>
                    <span className="tic">{r.state === 'fail' ? <Icon name="x" size={13} /> : i === rows.length - 1 && phase.name === 'running' ? <Icon name={SRC_ICON[r.source] ?? 'cpu'} size={13} /> : <Icon name="check" size={13} />}</span>
                    <div><b>{r.title}</b>{r.sub && <div className="small muted">{r.sub}</div>}</div>
                    <span className="src">{r.sealed ? <span className="pill sealed" title="Sealed to your browser key; the marketplace only relayed ciphertext"><Icon name="lock" size={11} />sealed</span> : <span className="pill"><Icon name={SRC_ICON[r.source] ?? 'cpu'} size={11} />{r.source}</span>}</span>
                    {r.logs.length > 0 && <div className="logs">{r.logs.map((l, j) => <div key={j}>{l}</div>)}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}
          {completed?.data?.ok && result && (
            <div className="panel">
              <Head icon="check" title="Result"><span className="spacer" /><span className="pill sealed"><Icon name="lock" size={11} />only you can read this</span></Head>
              <div className="body"><Output out={result.output} /></div>
            </div>
          )}
          {settlement?.payouts && (
            <div className="panel" id="settlement">
              <Head icon="receipt" title="Settled in one receipt"><span className="spacer" /><span className="small muted hash">tx {short(settlement.tx, 8, 6)} · #{settlement.height}</span></Head>
              <div className="body">
                {guaranteed && metric && settleEv && <p className="small" style={{ marginTop: 0 }}>Delivered <b>{usd(settleEv.delivered, 2)}</b> against a signed promise of {usd(q.promised, 2)}{Number(settleEv.compensation) > 0 ? <>: the guarantee deposit paid you <b>{usd(settleEv.compensation, 2)}</b>.</> : ': promise kept, the deposit is untouched.'}</p>}
                <SettlementFlow price={Number(settleEv?.price ?? q?.price ?? 0)} payouts={settlement.payouts} reserve={Number(settleEv?.reserve ?? 0)} />
                <div className="row wrap"><button className="btn ghost sm" onClick={() => go({ page: 'recipes', ticker })}><Icon name="clock" size={13} />{ticker}’s track record</button><button className="btn ghost sm" onClick={() => go({ page: 'wallet' })}><Icon name="users" size={13} />Who was paid</button><button className="btn ghost sm" onClick={() => go({ page: 'docs', sub: 'trust' })}><Icon name="shieldCheck" size={13} />The proofs</button></div>
              </div>
            </div>
          )}
        </section>
      </div>

      {approval && (
        <div className="overlay" role="dialog" aria-modal="true" aria-label="Wallet approval">
          <div className="wallet-modal">
            <div className="wm-top"><span className="wm-ic"><Icon name="wallet" size={19} /></span><div><div className="small muted">Wallet · {approval.signer}</div><h2>{approval.title}</h2></div><Tip wide>Decrypted in your browser. The runner never holds your funds or keys: it prepared these transactions, and only your wallet can sign them.</Tip></div>
            <table className="small"><thead><tr><th>What</th><th className="r">Amount</th>{approval.summary.some((s: any) => s.usd > 0) && <th className="r">≈ USD</th>}<th>To</th></tr></thead><tbody>
              {approval.summary.map((s: any, i: number) => <tr key={i}><td>{s.symbol}</td><td className="r">{s.amount}</td>{approval.summary.some((x: any) => x.usd > 0) && <td className="r">{money(s.usd)}</td>}<td className="hash">{short(s.to, 12, 6)}</td></tr>)}
            </tbody></table>
            {approval.sign_message && <div className="small" style={{ padding: '8px 10px', border: '1px solid var(--rule)', borderRadius: 8 }}><b>Also sign one NEAR Intents bundle (NEP-413):</b> {approval.sign_summary}<details><summary>Message</summary><pre className="codebox">{JSON.stringify(JSON.parse(approval.sign_message.message), null, 1)}</pre></details></div>}
            <details className="small"><summary>Raw transactions (signAndSendTransactions)</summary><pre className="codebox">{JSON.stringify(approval.transactions, null, 1)}</pre></details>
            <div className="row"><button className="btn buy lg" disabled={approving} onClick={() => approve(true)}><Icon name="check" size={16} />Approve {approval.transactions.length} transaction{approval.transactions.length === 1 ? '' : 's'}</button><button className="btn ghost" disabled={approving} onClick={() => approve(false)}>Reject</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
