import { useEffect, useMemo, useRef, useState } from 'react';
import nacl from 'tweetnacl';
import { seal, open, type SealedEnvelope } from '../../../core/src/seal';
import { verifyRunnerAttestation } from '../../../core/src/attestation';
import { api, ASSET_LABEL, money, PAY_ASSETS, runnerAttestation, short, usd, usePoll } from '../api';
import { useApp } from '../App';
import { SettlementFlow } from '../components/Sankey';

const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const RUNNER_ID = 'tee-runner-1.testnet';
type Ev = { seq: number; at: number; source: string; type: string; data: any; sealed?: boolean };

export function Run() {
  const { ticker, setTicker, acting, story, toast, go } = useApp();
  const [listings] = usePoll<any[]>('/api/listings', 4000);
  const listing = listings?.find((l) => l.ticker === ticker) ?? listings?.[0];
  const [values, setValues] = useState<Record<string, string>>({});
  const [freshKey, setFreshKey] = useState<{ account: string; sk: Uint8Array } | null>(null);
  const [payAsset, setPayAsset] = useState(PAY_ASSETS[0].id);
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
  const reply = useRef<nacl.BoxKeyPair | null>(null); // one-time key; the runner seals everything about this run to it
  const runToken = useRef('');

  useEffect(() => { if (listing && listing.ticker !== ticker) setTicker(listing.ticker); }, [listing]);
  // defaults for the form
  useEffect(() => {
    if (!listing) return;
    const v: Record<string, string> = {};
    for (const f of listing.form) v[f.id] = f.type === 'near.account' ? 'bob.testnet' : f.default != null ? String(f.default) : '';
    setValues(v); setFreshKey(null); setQuote(null); setRunId(null); setEvents([]); setShown(0);
  }, [listing?.ticker]);

  const genFresh = (fid: string) => { const kp = nacl.sign.keyPair(); const account = hex(kp.publicKey); setFreshKey({ account, sk: kp.secretKey }); setValues((v) => ({ ...v, [fid]: account })); };
  const downloadKey = () => {
    if (!freshKey) return;
    const blob = new Blob([JSON.stringify({ account_id: freshKey.account, public_key: 'ed25519:' + freshKey.account, secret_key_hex: hex(freshKey.sk), note: 'Fresh implicit NEAR account generated in your browser by Fungible Recipes. Keep this file private.' }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `fresh-${freshKey.account.slice(0, 8)}.json`; a.click();
  };

  const getQuote = async () => {
    if (!listing) return;
    setBusy(true);
    try {
      const nonce = hex(crypto.getRandomValues(new Uint8Array(32)));
      const { attestation, onchain } = await runnerAttestation(nonce);
      const v = verifyRunnerAttestation(attestation, { nonce, signing_pk: onchain.signing_pk, enc_pk_hex: onchain.enc_pk_hex, codehash: onchain.codehash });
      setRunnerOk({ ok: v.ok, hardware: v.hardware });
      if (!v.ok) throw new Error('runner attestation failed; refusing to send inputs');
      const inputs: Record<string, unknown> = {};
      for (const f of listing.form) inputs[f.id] = f.type === 'usd' ? Number(values[f.id]) : values[f.id];
      reply.current = nacl.box.keyPair();
      const sealed = seal({ inputs, reply_to: hex(reply.current.publicKey) }, onchain.enc_pk_hex, 'inputs');
      const pa = PAY_ASSETS.find((p) => p.id === payAsset)!;
      const q = await api('/api/runs/quote', { recipe_id: listing.ticker, buyer: acting, pay_asset: payAsset, refund_to: pa.refund, sealed_inputs: sealed });
      runToken.current = q.run_token;
      setQuote(q); setRunId(q.run_id); setEvents([]); setShown(0);
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
  const approve = async (ok: boolean) => { try { await api(`/api/runs/${runId}/approve?token=${runToken.current}`, { approved: ok, transactions: ok ? approval?.transactions : [] }); } catch (e) { toast((e as Error).message, true); } };

  // ---------- story automation (steps 2-4) ----------
  useEffect(() => {
    if (story.step !== 2 || !listing || listing.ticker !== 'CLNP' || storyStage.current > 0) return;
    storyStage.current = 1;
    (async () => {
      await new Promise((r) => setTimeout(r, 900));
      const f = listing.form.find((x: any) => x.generator === 'fresh-implicit');
      if (f) genFresh(f.id);
      await new Promise((r) => setTimeout(r, 1400));
      document.getElementById('get-quote')?.click();
    })();
  }, [story.step, listing]);
  useEffect(() => { if (story.step === 2 && quote && !quote.paid && storyStage.current === 1) { storyStage.current = 2; setTimeout(() => document.getElementById('pay-btn')?.click(), 2600); } }, [quote, story.step]);
  useEffect(() => { if (story.step === 2 && events.some((e) => e.type === 'decrypted')) story.next(); }, [events, story.step]);
  useEffect(() => { if (story.step === 3 && approval) { const t = setTimeout(() => approve(true), 2600); return () => clearTimeout(t); } }, [approval, story.step]);
  useEffect(() => { if (story.step === 3 && completed) { story.next(); setTimeout(() => document.getElementById('settlement')?.scrollIntoView({ behavior: 'smooth' }), 400); } }, [completed, story.step]);
  useEffect(() => { if (story.step === 4) { const t = setTimeout(story.next, 9000); return () => clearTimeout(t); } }, [story.step]);

  if (!listing) return <div className="panel body">No recipes listed yet.</div>;
  const rows = timeline(events);
  const settlement = completed?.data?.settlement;
  const pool = settlement ? Number(events.find((e) => e.type === 'frs_settlement')?.data?.shareholder_pool ?? 0) : 0;

  return (
    <div className="grid runpage">
      <section className="grid">
        <div className="panel">
          <header><h2>Run a recipe</h2><span className="small muted">as {acting}</span></header>
          <div className="body grid" style={{ gap: 10 }}>
            <div className="field"><label htmlFor="rsel">Recipe</label>
              <select id="rsel" value={listing.ticker} onChange={(e) => setTicker(e.target.value)}>{listings!.map((l) => <option key={l.ticker} value={l.ticker}>{l.ticker}: {l.name} ({money(Number(l.price_per_run) / 1e6)} per run)</option>)}</select></div>
            <div className="small muted">{listing.description}</div>
            {listing.form.map((f: any) => (
              <div className="field" key={f.id}>
                <label htmlFor={'f-' + f.id}>{f.label}</label>
                {f.options ? (
                  <select id={'f-' + f.id} value={values[f.id] ?? ''} onChange={(e) => setValues({ ...values, [f.id]: e.target.value })}>{f.options.map((o: string) => <option key={o} value={o}>{ASSET_LABEL[o] ?? o}</option>)}</select>
                ) : f.generator === 'fresh-implicit' ? (
                  <div className="row"><input id={'f-' + f.id} style={{ flex: 1 }} value={values[f.id] ? short(values[f.id], 12, 8) : ''} readOnly placeholder="not generated yet" />
                    <button className="btn ghost sm" onClick={() => genFresh(f.id)}>Generate</button>
                    {freshKey && <button className="btn ghost sm" onClick={downloadKey}>Save key</button>}</div>
                ) : (
                  <input id={'f-' + f.id} value={values[f.id] ?? ''} placeholder={f.placeholder} onChange={(e) => setValues({ ...values, [f.id]: e.target.value })} />
                )}
                {f.generator === 'fresh-implicit' && <span className="small muted">A new keypair made in this browser. Only the address goes into the sealed inputs; the key never leaves your device.</span>}
              </div>
            ))}
            <div className="field"><label htmlFor="pay">Pay with (NEAR Intents)</label>
              <select id="pay" value={payAsset} onChange={(e) => setPayAsset(e.target.value)}>{PAY_ASSETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></div>
            <button id="get-quote" className="btn" disabled={busy || !!runId && !completed && !failed} onClick={getQuote}>Seal inputs and get a quote</button>
            {runnerOk && <div className="small">{runnerOk.ok ? <span className="pill ok">runner attestation verified</span> : <span className="pill bad">runner attestation failed</span>} {!runnerOk.hardware && <span className="pill warn">local-dev: no hardware quote</span>}</div>}
          </div>
        </div>

        {quote && (
          <div className="panel">
            <header><h2>Pay through NEAR Intents</h2><span className="small muted">1Click EXACT_OUTPUT</span></header>
            <div className="body grid" style={{ gap: 8 }}>
              <dl className="kv">
                <dt>You send</dt><dd>{quote.quote.quote.amountInFormatted} {PAY_ASSETS.find((p) => p.id === payAsset)?.label}</dd>
                <dt>Contract receives</dt><dd>{usd(quote.quote.quote.amountOut, 2)} USDC</dd>
                <dt>Deposit address</dt><dd className="hash">{short(quote.quote.quote.depositAddress, 10, 8)}</dd>
                <dt>Run ticket</dt><dd className="hash">{quote.run_id}</dd>
                <dt>Inputs commitment</dt><dd className="hash">{short(quote.inputs_hash, 10, 8)}</dd>
              </dl>
              <details className="small"><summary>customRecipientMsg sent to the contract</summary><pre className="codebox">{JSON.stringify(JSON.parse(quote.msg), null, 1)}</pre></details>
              <button id="pay-btn" className="btn buy" disabled={busy || quote.paid} onClick={pay}>{quote.paid ? 'Deposit sent' : `Pay ${quote.quote.quote.amountInFormatted} and run`}</button>
            </div>
          </div>
        )}
      </section>

      <section className="grid" style={{ minWidth: 0 }}>
        <div className="panel">
          <header><h2>Execution</h2><span className="small muted">payment → on-chain escrow → sealed runner → settlement</span></header>
          {!rows.length && <div className="body muted">Fill the form and pay. Every step of the run appears here as it happens: the Intents payment, the runner's checks of the on-chain commitments, each block with its author and fee, and the settlement.</div>}
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
            <header><h2>Settlement</h2><span className="small muted">tx {short(settlement.tx, 8, 6)} · block {settlement.block} · one receipt</span></header>
            <div className="body">
              <SettlementFlow price={Number(listing.price_per_run)} payouts={settlement.payouts} pool={pool} />
              <div className="row wrap"><button className="btn ghost sm" onClick={() => go('exchange', listing.ticker)}>See it on the exchange</button><button className="btn ghost sm" onClick={() => go('trust')}>Inspect the proofs</button></div>
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
  let block: Row | null = null;
  for (const e of events) {
    const d = e.data;
    switch (e.type) {
      case 'quote': rows.push({ title: 'Quote from 1Click', sub: `${d.quote.amountInFormatted} in → ${usd(d.quote.amountOut, 2)} USDC to ${d.request.recipient}`, source: 'NEAR Intents', logs: [] }); break;
      case 'deposit_submitted': rows.push({ title: 'Deposit sent to the Intents deposit address', sub: `tx ${short(d.txHash, 8, 6)}`, source: 'NEAR Intents', logs: [] }); break;
      case 'status': { const last = rows.at(-1); if (last?.title.startsWith('Deposit')) last.logs.push(`1Click: ${d.status}`); break; }
      case 'run_requested': rows.push({ title: 'Solver delivered via ft_transfer_call: run escrowed on-chain', sub: `tx ${short(d.tx, 8, 6)} · block ${d.block}`, source: 'contract', logs: [] }); break;
      case 'payment_rejected': rows.push({ title: 'Contract rejected the payment', sub: d.error, source: 'contract', logs: [], state: 'fail' }); break;
      case 'accepted': rows.push({ title: `Runner ${d.runner_id} accepted the job`, sub: d.tee === 'local-dev' ? 'local-dev runner (no hardware TEE)' : 'Intel TDX', source: 'runner', logs: [] }); break;
      case 'verified': rows.push({ title: 'Runner checked the on-chain commitments', source: 'runner', logs: d.checks.map((c: any) => `${c.ok ? '✓' : '✕'} ${c.label}`) }); break;
      case 'decrypted': rows.push({ title: 'Recipe and inputs decrypted inside the runner', sub: 'plaintext never leaves the runner process', source: 'runner', logs: [] }); break;
      case 'block_start': block = { title: d.name, sub: `by ${d.author} · ${usd(d.fee, 2)} per call`, source: 'block', logs: [] }; rows.push(block); break;
      case 'block_log': if (block) { block.logs.push(d.msg); block.sealed = true; } break;
      case 'block_done': if (block) block.sub += ` · ${d.ms} ms`; break;
      case 'block_error': rows.push({ title: 'Block failed', sub: d.error, source: 'runner', logs: [], state: 'fail' }); break;
      case 'approval_required': block?.logs.push(`wallet approval requested: ${d.transactions.length} transfers`); break;
      case 'approval_result': block?.logs.push(d.approved ? `approved, ${d.transfers} transfers sent` : 'rejected by buyer'); break;
      case 'signed': rows.push({ title: 'Runner signed the report', sub: d.message.length > 100 ? d.message.slice(0, 100) + '…' : d.message, source: 'runner', logs: [] }); break;
      case 'frs_settlement': rows.push({ title: 'report_run verified the ed25519 signature and settled', sub: `tx ${short(d.tx, 8, 6)} · ${d.payouts.length} payees + shareholders`, source: 'contract', logs: [] }); break;
      case 'run_refunded': rows.push({ title: 'Run refunded to the buyer', sub: d.reason, source: 'contract', logs: [] }); break;
      case 'failed': rows.push({ title: 'Run failed', sub: d.error, source: 'runner', logs: [], state: 'fail' }); break;
      case 'completed': if (!d.ok) rows.push({ title: 'Run failed and was refunded', sub: d.error, source: 'runner', logs: [], state: 'fail' }); break;
    }
  }
  return rows;
}
