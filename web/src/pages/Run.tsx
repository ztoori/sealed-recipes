import { useEffect, useMemo, useRef, useState } from 'react';
import nacl from 'tweetnacl';
import { seal, open, sealedHash, type SealedEnvelope } from '../../../core/src/seal';
import { jobHash, openQuote } from '../../../core/src/jobs';
import { verifyRunnerAttestation } from '../../../core/src/attestation';
import { api, ASSET_LABEL, money, PAY_ASSETS, runnerAttestation, short, usd, usePoll } from '../api';
import { useApp } from '../App';
import { SettlementFlow } from '../components/Sankey';

const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const RUNNER_ID = 'tee-runner-1.testnet';
type Ev = { seq: number; at: number; source: string; type: string; data: any; sealed?: boolean };

export function Run() {
  const { acting, story, toast, go, onlyTicker, setOnlyTicker } = useApp();
  const [jobs] = usePoll<any[]>('/api/jobs', 5000);
  const [jobId, setJobId] = useState('job.wallet-cleanup@1.0.0');
  const job = jobs?.find((j) => j.id === jobId);
  const [values, setValues] = useState<Record<string, string>>({});
  const [freshKey, setFreshKey] = useState<{ account: string; sk: Uint8Array } | null>(null);
  const [payAsset, setPayAsset] = useState(PAY_ASSETS[0].id);
  /** buyer's price cap in USD (blank = none): recipes listed above it aren't asked to quote, and the contract enforces it */
  const [maxPrice, setMaxPrice] = useState('');
  const maxUnits = () => (maxPrice.trim() && Number(maxPrice) > 0 ? String(Math.round(Number(maxPrice) * 1e6)) : undefined);
  const [quotes, setQuotes] = useState<any[] | null>(null);
  const [openDemand, setOpenDemand] = useState(false);
  const [sortBy, setSortBy] = useState<'net' | 'value' | 'price' | 'risk'>('net');
  const [chosen, setChosen] = useState<any>(null);
  const jobRef = useRef<{ sealed: SealedEnvelope; job_hash: string } | null>(null);
  const [quote, setQuote] = useState<any>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [allEvents, setEvents] = useState<Ev[]>([]);
  const [shown, setShown] = useState(0);
  // reveal events one by one so a human can follow the run (presentation only; the run itself is not slowed)
  useEffect(() => {
    if (shown >= allEvents.length) return;
    const t = setTimeout(() => setShown((n) => n + 1), story.step ? 420 : 160);
    return () => clearTimeout(t);
  }, [shown, allEvents.length, story.step]);
  const events = useMemo(() => allEvents.slice(0, shown), [allEvents, shown]);
  useEffect(() => { if (story.step && shown) document.querySelector('.tl:last-child')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [shown, story.step]);
  const [busy, setBusy] = useState(false);
  const [runnerOk, setRunnerOk] = useState<null | { ok: boolean; hardware: boolean }>(null);
  const storyStage = useRef(0);
  const reply = useRef<nacl.BoxKeyPair | null>(null); // one-time key; the runner seals everything about this job and run to it
  const runToken = useRef('');

  // defaults for the job form
  useEffect(() => {
    if (!job) return;
    const v: Record<string, string> = {};
    for (const [id, f] of Object.entries<any>(job.inputs)) v[id] = f.type === 'near.account' ? 'bob.testnet' : f.default != null ? String(f.default) : '';
    setValues(v); setFreshKey(null); setQuotes(null); setChosen(null); setQuote(null); setRunId(null); setEvents([]); setShown(0); setOpenDemand(false);
  }, [jobId, !!job]);

  const genFresh = (fid: string) => { const kp = nacl.sign.keyPair(); const account = hex(kp.publicKey); setFreshKey({ account, sk: kp.secretKey }); setValues((v) => ({ ...v, [fid]: account })); };
  const downloadKey = () => {
    if (!freshKey) return;
    const blob = new Blob([JSON.stringify({ account_id: freshKey.account, public_key: 'ed25519:' + freshKey.account, secret_key_hex: hex(freshKey.sk), note: 'Fresh implicit NEAR account generated in your browser by Fungible Recipes. Keep this file private.' }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `fresh-${freshKey.account.slice(0, 8)}.json`; a.click();
  };

  /** Recipe intents: seal the job once to the attested runner, then every matching recipe quotes from a dry run. */
  const getQuotes = async () => {
    if (!job) return;
    setBusy(true); setQuotes(null); setChosen(null); setQuote(null); setRunId(null); setEvents([]); setShown(0); setOpenDemand(false);
    try {
      const nonce = hex(crypto.getRandomValues(new Uint8Array(32)));
      const { attestation, onchain } = await runnerAttestation(nonce);
      const v = verifyRunnerAttestation(attestation, { nonce, signing_pk: onchain.signing_pk, enc_pk_hex: onchain.enc_pk_hex, codehash: onchain.codehash });
      setRunnerOk({ ok: v.ok, hardware: v.hardware });
      if (!v.ok) throw new Error('runner attestation failed; refusing to send your job');
      const inputs: Record<string, unknown> = {};
      for (const [id, f] of Object.entries<any>(job.inputs)) {
        const raw = (values[id] ?? '').trim();
        if (!raw) throw new Error(`${f.label ?? id} is required${f.generator === 'fresh-implicit' ? ': press Generate' : ''}`);
        if (f.type === 'usd' && !(Number(raw) >= 0)) throw new Error(`${f.label ?? id} must be a number`);
        inputs[id] = f.type === 'usd' ? Number(raw) : raw;
      }
      reply.current = nacl.box.keyPair();
      const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
      const job_hash = jobHash(inputs, salt);
      const sealed = seal({ inputs, salt, reply_to: hex(reply.current.publicKey) }, onchain.enc_pk_hex, 'inputs');
      jobRef.current = { sealed, job_hash };
      const { contract_id } = await api('/api/chain/config');
      const mp = maxUnits();
      const r = await api('/api/jobs', { job_type: job.id, sealed_job: sealed, job_hash, buyer: acting, ...(onlyTicker ? { only: onlyTicker } : {}), ...(mp ? { max_price: mp } : {}) });
      // each quote arrives sealed to this browser; open it and check the runner's signature over the exact
      // message the contract will verify, so a tampered or misdirected quote is dropped before paying
      const ctx = { contractId: contract_id, signingPk: onchain.signing_pk, buyer: acting, inputsHash: sealedHash(sealed), jobHash: job_hash };
      for (const q of r.quotes) {
        if (!q.ok || !q.sealed_quote) continue;
        try { const o = openQuote(q.sealed_quote, reply.current!.secretKey, { ...ctx, recipeId: q.recipe_id }); Object.assign(q, o, { ok: o.verified, error: o.problem }); }
        catch { Object.assign(q, { ok: false, error: 'quote could not be opened with your key' }); }
      }
      setQuotes(r.quotes); setOpenDemand(r.open_demand);
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };

  /** buyer picks a quote: the signed promise goes into the run msg, so the contract can enforce the guarantee */
  const choose = async (q: any, guaranteed = true) => {
    if (!jobRef.current) return;
    setBusy(true); setChosen({ ...q, guaranteed });
    try {
      const pa = PAY_ASSETS.find((p) => p.id === payAsset)!;
      const r = await api('/api/runs/quote', { recipe_id: q.listing.ticker, buyer: acting, pay_asset: payAsset, refund_to: pa.refund, sealed_inputs: jobRef.current.sealed,
        // with the quote, its signed price is locked; without it, the list price applies and the shown price is the cap
        ...(guaranteed ? {} : { max_price: maxUnits() ?? String(q.price ?? q.listing.price_per_run) }),
        ...(guaranteed ? { signed_quote: { sealed_hash: q.sealed_hash, job_hash: q.job_hash, price: q.price, expected: q.expected, promised: q.promised, cover: q.cover, expires_ns: q.expires_ns, signature: q.signature } } : {}) });
      runToken.current = r.run_token;
      setQuote(r); setRunId(r.run_id); setEvents([]); setShown(0);
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const pay = async () => { if (!runId) return; setBusy(true); try { await api(`/api/runs/${runId}/pay?token=${runToken.current}`, {}); setQuote((q: any) => ({ ...q, paid: true })); } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); } };

  // live event stream
  useEffect(() => {
    if (!runId) return;
    const es = new EventSource(`/api/runs/${runId}/events?token=${runToken.current}`);
    es.onmessage = (m) => {
      let e = JSON.parse(m.data) as Ev;
      if (e.type === 'sealed' && reply.current) {
        try { const inner = open<{ type: string; data: any }>(e.data.envelope as SealedEnvelope, reply.current.secretKey); e = { ...e, type: inner.type, data: inner.data, sealed: true }; } catch { return; }
      }
      setEvents((x) => (x.some((y) => y.seq === e.seq) ? x : [...x, e]));
    };
    return () => es.close();
  }, [runId]);

  const approval = useMemo(() => {
    const req = [...events].reverse().find((e) => e.type === 'approval_required');
    const res = events.find((e) => e.type === 'approval_result');
    return req && !res ? req.data : null;
  }, [events]);
  const completed = events.find((e) => e.type === 'completed');
  const result = events.find((e) => e.type === 'result')?.data;
  const failed = events.find((e) => e.type === 'failed' || e.type === 'payment_rejected');
  const approve = async (ok: boolean) => { try { await api(`/api/runs/${runId}/approve?token=${runToken.current}`, { approved: ok, transactions: ok ? approval?.transactions : [], ...(ok && approval?.sign_message ? { sign_message: approval.sign_message } : {}) }); } catch (e) { toast((e as Error).message, true); } };

  // ---------- story automation (steps 2-4) ----------
  useEffect(() => {
    if (story.step !== 2 || !job || storyStage.current > 0) return;
    storyStage.current = 1;
    (async () => {
      await new Promise((r) => setTimeout(r, 900));
      genFresh('recipient');
      await new Promise((r) => setTimeout(r, 1200));
      document.getElementById('get-quotes')?.click();
    })();
  }, [story.step, !!job]);
  useEffect(() => { if (story.step === 2 && quotes?.length && storyStage.current === 1) { storyStage.current = 2; setTimeout(() => document.getElementById('choose-CLNP')?.click(), 4200); } }, [quotes, story.step]);
  useEffect(() => { if (story.step === 2 && quote && !quote.paid && storyStage.current === 2) { storyStage.current = 3; setTimeout(() => document.getElementById('pay-btn')?.click(), 2200); } }, [quote, story.step]);
  useEffect(() => { if (story.step === 2 && events.some((e) => e.type === 'decrypted')) story.next(); }, [events, story.step]);
  useEffect(() => { if (story.step === 3 && approval) { const t = setTimeout(() => approve(true), 2600); return () => clearTimeout(t); } }, [approval, story.step]);
  useEffect(() => { if (story.step === 3 && completed) { story.next(); setTimeout(() => document.getElementById('settlement')?.scrollIntoView({ behavior: 'smooth' }), 400); } }, [completed, story.step]);
  useEffect(() => { if (story.step === 4) { const t = setTimeout(story.next, 9000); return () => clearTimeout(t); } }, [story.step]);

  if (!job) return <div className="panel body">Loading job types…</div>;
  const rows = timeline(events);
  const settlement = completed?.data?.settlement;
  const settleEv = events.find((e) => e.type === 'frs_settlement')?.data;
  const reserve = settlement ? Number(settleEv?.reserve ?? 0) : 0;
  const priceOf = (q: any) => Number(q.price ?? q.listing.price_per_run); // the quote's signed price
  const net = (q: any) => Number(q.expected) - priceOf(q);
  const RISK: Record<string, number> = { low: 0, medium: 1, high: 2 };
  const sorted = [...(quotes ?? [])].sort((a, b) => (!a.ok ? 1 : !b.ok ? -1 : sortBy === 'price' ? priceOf(a) - priceOf(b) : sortBy === 'value' ? Number(b.expected) - Number(a.expected) : sortBy === 'risk' ? RISK[a.listing.risk] - RISK[b.listing.risk] || net(b) - net(a) : net(b) - net(a)));

  return (
    <div className="grid runpage">
      <section className="grid">
        <div className="panel">
          <header><h2>Post a job</h2><span className="small muted">as {acting}</span></header>
          <div className="body grid" style={{ gap: 10 }}>
            <div className="jobtypes" role="radiogroup" aria-label="Job type">
              {(jobs ?? []).map((j) => (
                <button key={j.id} role="radio" aria-checked={j.id === jobId} className={'jobtype' + (j.id === jobId ? ' on' : '')} onClick={() => setJobId(j.id)}>
                  <b>{j.name}</b><span>{j.recipes.length ? `${j.recipes.length} recipe${j.recipes.length > 1 ? 's compete' : ' competes'}` : 'no recipe yet: posting it records open demand'}</span>
                </button>
              ))}
            </div>
            <div className="small muted">{job.description}</div>
            {Object.entries<any>(job.inputs).map(([id, f]) => (
              <div className="field" key={id}>
                <label htmlFor={'f-' + id}>{f.label ?? id}</label>
                {f.options ? (
                  <select id={'f-' + id} value={values[id] ?? ''} onChange={(e) => setValues({ ...values, [id]: e.target.value })}>{f.options.map((o: string) => <option key={o} value={o}>{ASSET_LABEL[o] ?? o}</option>)}</select>
                ) : f.generator === 'fresh-implicit' ? (
                  <div className="row"><input id={'f-' + id} style={{ flex: 1 }} value={values[id] ? short(values[id], 12, 8) : ''} readOnly placeholder="not generated yet" />
                    <button className="btn ghost sm" onClick={() => genFresh(id)}>Generate</button>
                    {freshKey && <button className="btn ghost sm" onClick={downloadKey}>Save key</button>}</div>
                ) : (
                  <input id={'f-' + id} value={values[id] ?? ''} placeholder={f.placeholder} onChange={(e) => setValues({ ...values, [id]: e.target.value })} />
                )}
                {f.generator === 'fresh-implicit' && <span className="small muted">A new keypair made in this browser. Only the address goes into the sealed job; the key never leaves your device.</span>}
              </div>
            ))}
            <div className="field"><label htmlFor="maxp">Max price per run (USD, optional)</label>
              <input id="maxp" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value.replace(/[^0-9.]/g, ''))} inputMode="decimal" placeholder="no limit" />
              <span className="small muted">Recipes priced above it aren't asked to quote, and the contract refuses to charge more.</span></div>
            <div className="field"><label htmlFor="pay">Pay with (NEAR Intents)</label>
              <select id="pay" value={payAsset} onChange={(e) => setPayAsset(e.target.value)}>{PAY_ASSETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></div>
            {onlyTicker && <div className="small">Only asking <b>{onlyTicker}</b>. <button className="btn ghost sm" onClick={() => setOnlyTicker('')}>Ask every recipe</button></div>}
            <button id="get-quotes" className="btn" disabled={busy || (!!runId && !completed && !failed)} onClick={getQuotes}>Seal the job and get quotes</button>
            {runnerOk && <div className="small">{runnerOk.ok ? <span className="pill ok">runner attestation verified</span> : <span className="pill bad">runner attestation failed</span>} {!runnerOk.hardware && <span className="pill warn">local-dev: no hardware quote</span>}</div>}
          </div>
        </div>

        {quote && chosen && (
          <div className="panel">
            <header><h2>Pay {chosen.listing.ticker} through NEAR Intents</h2><span className="small muted">1Click EXACT_OUTPUT</span></header>
            <div className="body grid" style={{ gap: 8 }}>
              <dl className="kv">
                <dt>You send</dt><dd>{quote.quote.quote.amountInFormatted} {PAY_ASSETS.find((p) => p.id === payAsset)?.label}</dd>
                <dt>Contract receives</dt><dd>{usd(quote.quote.quote.amountOut, 2)} USDC</dd>
                <dt>Guarantee</dt><dd>{chosen.guaranteed ? <>{usd(chosen.promised, 2)} promised; the guarantee deposit covers a shortfall up to {usd(chosen.cover, 2)}<div className="small muted">The promise and the delivered value are written on-chain: that is what makes them enforceable.</div></> : <>none: no promise, no deposit cover<div className="small muted">Nothing about your wallet's value is written on-chain for this run.</div></>}</dd>
                <dt>Deposit address</dt><dd className="hash">{short(quote.quote.quote.depositAddress, 10, 8)}</dd>
                <dt>Run ticket</dt><dd className="hash">{quote.run_id}</dd>
              </dl>
              <details className="small"><summary>customRecipientMsg sent to the contract</summary><pre className="codebox">{JSON.stringify(JSON.parse(quote.msg), null, 1)}</pre></details>
              <button id="pay-btn" className="btn buy" disabled={busy || quote.paid} onClick={pay}>{quote.paid ? 'Deposit sent' : `Pay ${quote.quote.quote.amountInFormatted} and run`}</button>
            </div>
          </div>
        )}
      </section>

      <section className="grid" style={{ minWidth: 0 }}>
        {openDemand && <div className="panel"><div className="body">No recipe does this job yet. It was recorded as <b>open demand</b>, which builders see in Compose.</div></div>}
        {quotes && quotes.length > 0 && (
          <div className="panel" id="quotes">
            <header><h2>{(() => { const n = quotes.filter((q) => q.ok).length; return `${n} recipe${n === 1 ? '' : 's'} quoted`; })()}</h2><span className="small muted">from dry runs inside the sealed runner, each signed</span>
              <span className="spacer" />
              <label className="small muted">Sort by <select value={sortBy} onChange={(e) => setSortBy(e.target.value as any)} aria-label="Sort quotes"><option value="net">best result after price</option><option value="value">most value</option><option value="price">lowest price</option><option value="risk">lowest risk</option></select></label>
            </header>
            <table className="quotes">
              <thead><tr><th>Recipe</th><th className="r">Expected</th><th className="r">Promised</th><th className="r">Price</th><th>Privacy</th><th title="FRS-1 §2.1: how likely a part's model or service is withdrawn or changed under the recipe">Withdrawal risk</th><th>Track record</th><th /></tr></thead>
              <tbody>
                {sorted.map((q) => {
                  const t = q.track, quoted = Number(t.promised_total);
                  const swaps = Array.isArray(q.details?.output) ? q.details.output.length : null;
                  return (
                    <tr key={q.listing.ticker} className={chosen?.listing.ticker === q.listing.ticker ? 'sel' : ''}>
                      <td><b>{q.listing.ticker}</b> {q.listing.name}<div className="small muted">by {q.listing.creator}{swaps !== null ? ` · ${swaps} swap${swaps === 1 ? '' : 's'} planned` : ''}</div></td>
                      {q.ok ? <>
                        <td className="r">{job.metric ? usd(q.expected, 2) : '—'}</td>
                        <td className="r">{job.metric ? usd(q.promised, 2) : '—'}<div className="small muted">{job.metric ? (Number(q.cover) > 0 ? `deposit covers ${usd(q.cover, 2)}` : 'no guarantee') : 'no value metric'}</div></td>
                        <td className="r">{usd(q.price, 2)}<div className="small muted" title="Market-driven list price: it follows demand inside the creator's band. The quote locks this price.">band {usd(q.listing.price_floor, 2)}–{usd(q.listing.price_ceiling, 2)}</div></td>
                        <td><span className={'pill ' + (q.listing.privacy === 'confidential' ? 'sealed' : '')}>{q.listing.privacy}</span></td>
                        <td><span className={'pill ' + (q.listing.risk === 'low' ? 'ok' : q.listing.risk === 'high' ? 'bad' : 'warn')} title={q.listing.disclosures.map((d: any) => `${d.part}: ${d.model.kind}${d.model.name ? ' ' + d.model.name : ''}, ${d.runtime}`).join('\n')}>{q.listing.risk}</span></td>
                        <td className="small">{t.runs} run{t.runs === 1 ? '' : 's'}{Number(t.failed) ? `, ${t.failed} failed` : ''}{Number(t.aborted) ? `, ${t.aborted} aborted` : ''}{quoted ? <div className="muted">delivered {(Number(t.delivered_total) / quoted * 100).toFixed(0)}% of promises</div> : <div className="muted">no quoted runs yet</div>}</td>
                        <td><div className="grid" style={{ gap: 4 }}><button id={'choose-' + q.listing.ticker} className="btn sm" disabled={busy || !!runId && !completed && !failed} onClick={() => choose(q)} title="Pay with the signed quote: its price is locked and its promise is backed by the guarantee deposit">Choose</button>
                          {job.metric && <button className="btn ghost sm" disabled={busy || !!runId && !completed && !failed} onClick={() => choose(q, false)} title="Pay without the quote: no guarantee, and no promised or delivered value written on-chain">No guarantee</button>}</div></td>
                      </> : <td colSpan={7} className="small muted">could not quote: {q.error}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="body small muted">Recipes stay sealed: you compare results, not methods. Each quote was sealed to this browser and its runner signature checked here. A promise is bound to your account and this job, and backed by the recipe's guarantee deposit up to the cover shown. If a run delivers less, the contract pays the shortfall in the same settlement. Right before executing, the runner re-prices the job; if the wallet changed since the quote, it aborts and you are refunded.</div>
          </div>
        )}
        <div className="panel">
          <header><h2>Execution</h2><span className="small muted">payment → on-chain escrow → sealed runner → settlement</span></header>
          {!rows.length && <div className="body muted">Fill the form and pay. Every step of the run appears here as it happens: the Intents payment, the runner's checks of the on-chain commitments, each part with its author and fee, and the settlement.</div>}
          <div className="timeline">
            {rows.map((r, i) => (
              <div key={i} className={'tl ' + (r.state === 'fail' ? 'fail' : i === rows.length - 1 && !completed && !failed ? 'live' : 'done')}>
                <span className="ic">{r.state === 'fail' ? '!' : i === rows.length - 1 && !completed && !failed ? '' : '✓'}</span>
                <div><b>{r.title}</b>{r.sub && <div className="small muted">{r.sub}</div>}</div>
                <span className="src">{r.sealed ? <span className="pill sealed" title="These details were sealed to your browser key; the marketplace only relayed ciphertext">sealed to you</span> : r.source}</span>
                {r.logs.length > 0 && <div className="logs">{r.logs.map((l, j) => <div key={j}>{l}</div>)}</div>}
              </div>
            ))}
          </div>
        </div>

        {completed?.data?.ok && result && (
          <div className="panel">
            <header><h2>Result</h2><span className="pill sealed">sealed to your browser key</span></header>
            <div className="body"><Output out={result.output} /></div>
          </div>
        )}
        {settlement?.payouts && (
          <div className="panel" id="settlement">
            <header><h2>Settlement</h2><span className="small muted">tx {short(settlement.tx, 8, 6)} · block {settlement.height} · one receipt</span></header>
            <div className="body">
              {chosen?.guaranteed && settleEv && <p className="small" style={{ marginTop: 0 }}>Delivered <b>{usd(settleEv.delivered, 2)}</b> against a signed promise of {usd(chosen.promised, 2)}{Number(settleEv.compensation) > 0 ? <>: the guarantee deposit paid you <b>{usd(settleEv.compensation, 2)}</b>.</> : ': promise kept, the deposit is untouched.'}</p>}
              <SettlementFlow price={Number(settleEv?.price ?? chosen?.price ?? chosen?.listing.price_per_run ?? 0)} payouts={settlement.payouts} reserve={reserve} />
              <div className="row wrap"><button className="btn ghost sm" onClick={() => go('recipes', chosen?.listing.ticker)}>See {chosen?.listing.ticker}’s track record</button><button className="btn ghost sm" onClick={() => go('trust')}>Inspect the proofs</button></div>
            </div>
          </div>
        )}
      </section>

      {approval && (
        <div className="overlay" role="dialog" aria-modal="true" aria-label="Wallet approval">
          <div className="wallet-modal">
            <div className="small muted">Wallet · {approval.signer}</div>
            <h2>{approval.title}</h2>
            <p className="small muted" style={{ margin: 0 }}>Decrypted in your browser. The runner never holds your funds. It prepared these NEP-141 transfers to 1Click deposit addresses; confidential intents make the deposits unlinkable to the payout.</p>
            <table className="small"><thead><tr><th>Token</th><th className="r">Amount</th><th className="r">≈ USD</th><th>To deposit address</th></tr></thead><tbody>
              {approval.summary.map((s: any, i: number) => <tr key={i}><td>{s.symbol}</td><td className="r">{s.amount}</td><td className="r">{money(s.usd)}</td><td className="hash">{short(s.to, 8, 6)}</td></tr>)}
            </tbody></table>
            {approval.sign_message && <div className="small" style={{ padding: '8px 10px', border: '1px solid var(--line, #d7dde6)', borderRadius: 8 }}><b>Also sign one NEAR Intents bundle (NEP-413):</b> {approval.sign_summary}<details><summary>Message</summary><pre className="codebox">{JSON.stringify(JSON.parse(approval.sign_message.message), null, 1)}</pre></details></div>}
            <details className="small"><summary>Raw transactions (signAndSendTransactions)</summary><pre className="codebox">{JSON.stringify(approval.transactions, null, 1)}</pre></details>
            <div className="row"><button className="btn buy" onClick={() => approve(true)}>Approve {approval.transactions.length} transfers</button><button className="btn ghost" onClick={() => approve(false)}>Reject</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

function Output({ out }: { out: any }) {
  if (Array.isArray(out)) {
    const total = out.reduce((s, r) => s + Number(r.amountOut || 0), 0);
    return (
      <>
        <table><thead><tr><th>Swept</th><th className="r">Amount in</th><th className="r">Received</th><th>Status</th><th>Privacy</th></tr></thead><tbody>
          {out.map((r, i) => <tr key={i}><td>{r.symbol}</td><td className="r">{r.amountIn}</td><td className="r">{Number(r.amountOut).toFixed(4)}</td><td><span className={'pill ' + (r.status === 'SUCCESS' ? 'ok' : 'bad')}>{r.status}</span></td><td><span className={'pill ' + (r.confidentiality === 'basic' ? 'sealed' : '')}>{r.confidentiality === 'basic' ? 'confidential' : 'public'}</span></td></tr>)}
        </tbody></table>
        <p className="small" style={{ marginBottom: 0 }}><b>{total.toFixed(4)}</b> consolidated at the fresh address. Scam airdrops were never touched.</p>
      </>
    );
  }
  if (out?.title) return (<><h3 className="serif" style={{ fontWeight: 500, fontSize: 20 }}>{out.title}</h3><table className="small"><tbody>{out.flagged.map((f: any) => <tr key={f.contract}><td><b>{f.symbol}</b><div className="muted hash">{f.contract}</div></td><td>{f.reason}</td></tr>)}</tbody></table></>);
  return <pre className="codebox">{JSON.stringify(out, null, 1)}</pre>;
}

interface Row { title: string; sub?: string; source: string; logs: string[]; state?: 'fail'; sealed?: boolean }
function timeline(events: Ev[]): Row[] {
  const rows: Row[] = [];
  let part: Row | null = null;
  for (const e of events) {
    const d = e.data;
    switch (e.type) {
      case 'quote': rows.push({ title: 'Quote from 1Click', sub: `${d.quote.amountInFormatted} in → ${usd(d.quote.amountOut, 2)} USDC to ${d.request.recipient}`, source: 'NEAR Intents', logs: [] }); break;
      case 'deposit_submitted': rows.push({ title: 'Deposit sent to the Intents deposit address', sub: `tx ${short(d.txHash, 8, 6)}`, source: 'NEAR Intents', logs: [] }); break;
      case 'status': { const last = rows.at(-1); if (last?.title.startsWith('Deposit')) last.logs.push(`1Click: ${d.status}`); break; }
      case 'run_requested': rows.push({ title: 'Solver delivered via ft_transfer_call: run escrowed on-chain', sub: `tx ${short(d.tx, 8, 6)} · block ${d.height}`, source: 'contract', logs: [] }); break;
      case 'accepted': rows.push({ title: `Runner ${d.runner_id} accepted the job`, sub: d.tee === 'local-dev' ? 'local-dev runner (no hardware TEE)' : 'Intel TDX', source: 'runner', logs: [] }); break;
      case 'verified': rows.push({ title: 'Runner checked the on-chain commitments', source: 'runner', logs: d.checks.map((c: any) => `${c.ok ? '✓' : '✕'} ${c.label}`) }); break;
      case 'rechecked': rows.push({ title: d.ok ? 'Runner re-priced the job before executing: quote still holds' : 'Wallet changed since the quote: run aborted', sub: `threshold ${d.threshold_bps / 100}% of the quoted promise`, source: 'runner', logs: [], ...(d.ok ? {} : { state: 'fail' as const }) }); break;
      case 'recheck': { const last = rows.at(-1); if (last) { last.logs.push(`fresh promise ${usd(d.fresh_promised, 2)} vs quoted ${usd(d.quoted_promised, 2)}`); last.sealed = true; } break; }
      case 'refunded': rows.push({ title: 'Runner reported the failure: refunded now', sub: 'signed fail report, no waiting for the reclaim timeout', source: 'runner', logs: [] }); break;
      case 'checkpoint': (part ?? rows.at(-1))?.logs.push(`checkpoint #${d.local_seq} stored, sealed to the runner${d.mid_part ? ' (before an irreversible step)' : ''}`); break;
      case 'run_checkpoint': rows.push({ title: d.payouts.length ? `Checkpoint on-chain: ${d.payouts.map((p: any) => p.role.slice(5).split('@')[0]).join(', ')} paid` : 'Heartbeat checkpoint on-chain', sub: `seq ${d.seq} · billed so far ${usd(d.billed, 2)} · timeout extended`, source: 'contract', logs: [] }); break;
      case 'runner_lost': rows.push({ title: 'Runner stopped mid-run', sub: d.checkpoint ? `last stored checkpoint #${d.checkpoint}; the marketplace asks it to resume` : 'no checkpoint yet; the run restarts from the beginning', source: 'market', logs: [], state: 'fail' }); break;
      case 'resuming': rows.push({ title: 'Runner resumed from its checkpoint', sub: `checkpoint #${d.local_seq} verified and opened inside the runner: ${d.completed_parts} parts already done${d.mid_part ? `, continuing inside ${d.mid_part}` : ''}`, source: 'runner', logs: [] }); break;
      case 'payment_rejected': rows.push({ title: 'Contract rejected the payment and refunded it', sub: d.error, source: 'contract', logs: [], state: 'fail' }); break;
      case 'decrypted': rows.push({ title: 'Recipe and inputs decrypted inside the runner', sub: 'plaintext never leaves the runner process', source: 'runner', logs: [] }); break;
      case 'part_start': part = { title: d.name, sub: `by ${d.author} · ${usd(d.fee, 2)} per call`, source: 'part', logs: [] }; rows.push(part); break;
      case 'part_log': if (part) { part.logs.push(d.msg); part.sealed = true; } break;
      case 'part_done': if (part) part.sub += ` · ${d.ms} ms`; break;
      case 'part_error': rows.push({ title: 'Part failed', sub: d.error, source: 'runner', logs: [], state: 'fail' }); break;
      case 'approval_required': part?.logs.push(`wallet approval requested: ${d.transactions.length} transfers`); break;
      case 'approval_result': part?.logs.push(d.approved ? `approved, ${d.transfers} transfers sent` : 'rejected by buyer'); break;
      case 'signed': rows.push({ title: 'Runner signed the report', sub: d.message.length > 100 ? d.message.slice(0, 100) + '…' : d.message, source: 'runner', logs: [] }); break;
      case 'frs_settlement': rows.push({ title: 'report_run verified the ed25519 signature and settled', sub: `tx ${short(d.tx, 8, 6)} · ${d.payouts.length} payees + guarantee deposit`, source: 'contract', logs: [] }); break;
      case 'run_refunded': rows.push({ title: 'Run refunded to the buyer', sub: d.reason, source: 'contract', logs: [] }); break;
      case 'failed': rows.push({ title: 'Run failed', sub: d.error, source: 'runner', logs: [], state: 'fail' }); break;
      case 'completed': if (!d.ok) rows.push({ title: d.outcome === 'abort' ? 'Run aborted and refunded' : 'Run failed and was refunded', sub: d.reason ?? d.error, source: 'runner', logs: [], state: 'fail' }); break;
    }
  }
  return rows;
}
