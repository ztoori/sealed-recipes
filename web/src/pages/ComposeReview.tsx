import { useEffect, useMemo, useState } from 'react';
import { checklistFor, diffLines, reviewMessage, TIER_INFO, type Tier } from '../../../core/src/review';
import { base64 } from '../../../core/src/seal';
import { demoWalletSign } from '../../../core/src/creator';
import type { Diagnostic, PartManifest } from '../../../core/src/srs';
import { api, usePoll } from '../api';
import { useApp } from '../App';
import { Icon } from '../icons';
import { Empty, Tip } from '../ui';
import { TierPill, TierTable, TiersTip } from '../components/Admission';

/**
 * Compose › Review: the admission queue (SRS-1 §11). Everyone can read every submission, its automated checks and its
 * code; only the owner-appointed reviewers can approve, never their own parts. Open-tier parts need no reviewer.
 */
type Summary = { id: string; part: string; name: string; author: string; tier: Tier; status: string; submitted_at: string; passed: boolean | null; approvals: number; needed: number; released_at?: string };
const STATUS: Record<string, [string, string]> = {
  checking: ['Checking', 'warn'], failed_checks: ['Failed checks', 'bad'], in_review: ['In review', 'warn'],
  approved: ['Approved', 'ok'], changes_requested: ['Changes requested', 'bad'], released: ['Released', 'ok'],
};
const FILTERS: [string, string][] = [['all', 'All'], ['in_review', 'In review'], ['approved', 'Approved'], ['released', 'Released'], ['failed_checks', 'Failed'], ['changes_requested', 'Changes']];

export function ComposeReview({ id }: { id?: string }) {
  const { go } = useApp();
  const [list] = usePoll<Summary[]>('/api/parts/submissions', 2500);
  const [adm] = usePoll<any>('/api/parts/admission', 60000);
  const [filter, setFilter] = useState('all');
  const shown = (list ?? []).filter((s) => filter === 'all' || s.status === filter);
  const sel = id ?? undefined;
  const counts = useMemo(() => {
    const c: Partial<Record<Tier, number>> = {};
    for (const r of adm?.records ?? []) c[r.tier as Tier] = (c[r.tier as Tier] ?? 0) + 1;
    return c;
  }, [adm]);
  return (
    <div className="grid reviewpage">
      <aside className="stack">
        <div className="panel partlist">
          <header><Icon name="shieldCheck" size={16} className="hd-ic" /><h2>Submissions</h2><TiersTip /><span className="spacer" /><span className="count">{list?.length ?? 0}</span></header>
          <div className="body chips" style={{ paddingBottom: 6 }}>
            {FILTERS.map(([k, label]) => <button key={k} className={'chip' + (filter === k ? ' on' : '')} aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}</button>)}
          </div>
          <ul className="plist">
            {shown.map((s) => (
              <li key={s.id}><button aria-current={s.id === sel ? 'true' : undefined} onClick={() => go({ page: 'compose', sub: 'review', part: s.id })}>
                <b>{s.name || s.part}</b>
                <span>{s.part} · by {s.author}</span>
                <span className="row" style={{ gap: 4, marginTop: 3 }}><TierPill tier={s.tier} /><span className={'pill ' + STATUS[s.status]?.[1]}>{STATUS[s.status]?.[0] ?? s.status}</span>{s.needed > 0 && s.status === 'in_review' && <span className="muted">{s.approvals}/{s.needed}</span>}</span>
              </button></li>
            ))}
            {list && !shown.length && <li className="muted small" style={{ padding: '8px 9px' }}>{list.length ? 'Nothing with this status.' : 'No submissions yet.'}</li>}
          </ul>
        </div>
        <div className="panel">
          <header><Icon name="users" size={16} className="hd-ic" /><h2>Reviewers</h2><Tip wide>Appointed by the owner ({adm?.reviewers?.owner ?? '…'}). The set is in standard/reviewers.json, which the runner’s code hash covers, so changing it is itself a release. A reviewer never reviews their own part, and parts that ask buyers to sign need two different reviewers.</Tip></header>
          <div className="body small grid" style={{ gap: 4 }}>
            {(adm?.reviewers?.reviewers ?? []).map((r: any) => <div key={r.account} className="row"><Icon name="user" size={13} />{r.account}</div>)}
            <div className="muted">Release {adm?.release ?? '…'} is running.</div>
          </div>
        </div>
      </aside>

      {sel ? <Detail key={sel} id={sel} /> : (
        <section className="panel" style={{ minWidth: 0, gridColumn: 'span 2' }}>
          <header><Icon name="shieldCheck" size={16} className="hd-ic" /><h2>How parts are admitted</h2></header>
          <div className="body grid" style={{ gap: 14 }}>
            <p className="small" style={{ margin: 0 }}>Parts run inside other people’s sealed recipes, on buyers’ wallets, so a bad one is a real attack. How much a part must prove depends on what its manifest lets it do. Every submission gets the automated checks; people only review what a sandbox cannot judge.</p>
            <TierTable counts={counts} />
            <ol className="submit-steps small">
              <li><span className="sn">1</span><span><b>Submit</b>: the author registers the manifest on-chain and submits the code, signed.</span></li>
              <li><span className="sn">2</span><span><b>Automated checks</b>: SRS-1 conformance, static and security checks, and a behaviour test in the sandbox (as a quote and as a run).</span></li>
              <li><span className="sn">3</span><span><b>Review, by tier</b>: none for open parts, one appointed reviewer or two independent ones for the rest.</span></li>
              <li><span className="sn">4</span><span><b>Release</b>: the owner cuts a runner release. Its code hash covers the code and the review log, and the runner refuses any part whose record does not verify.</span></li>
            </ol>
            {list && !list.length && <Empty icon="code" action={<button className="btn ghost sm" onClick={() => go({ page: 'compose', sub: 'part' })}><Icon name="plus" size={13} />Build a part</button>}>No submissions yet.</Empty>}
          </div>
        </section>
      )}
    </div>
  );
}

function Diags({ title, list }: { title: string; list: Diagnostic[] }) {
  if (!list.length) return <div className="row small gain"><Icon name="check" size={13} />{title}: no findings</div>;
  return <div className="grid" style={{ gap: 4 }}><div className="sectlabel">{title}</div>{list.map((d, i) => <div key={i} className={'diag ' + d.severity}>{d.message}</div>)}</div>;
}

function Detail({ id }: { id: string }) {
  const { acting, toast } = useApp();
  const [s, refresh] = usePoll<any>(`/api/parts/submissions/${id}`, 2500, [id]);
  const [view, setView] = useState<'diff' | 'source'>('diff');
  const [ticks, setTicks] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  useEffect(() => { setTicks([]); setNotes(''); }, [id]);
  if (!s) return <section className="panel body muted loading" style={{ minWidth: 0 }}><span className="spinner" />Loading submission</section>;
  const m = s.manifest as PartManifest;
  const items = checklistFor(m);
  const isReviewer = (s.reviewers as string[]).includes(acting);
  const already = s.reviews.some((r: any) => r.reviewer === acting);
  const canReview = isReviewer && acting !== s.author && s.status === 'in_review' && !already;
  const approvals = s.reviews.filter((r: any) => r.verdict === 'approve');
  const diff = s.previous ? diffLines(s.previous.source, s.source) : null;
  const send = async (verdict: 'approve' | 'reject') => {
    const checklist = verdict === 'approve' ? ticks : ticks;
    const signature = base64.enc(demoWalletSign(acting, reviewMessage(s.id, s.part, s.manifest_hash, s.source_sha256, acting, verdict, checklist)));
    try { await api(`/api/parts/submissions/${s.id}/review`, { reviewer: acting, verdict, checklist, notes, signature }); toast(verdict === 'approve' ? `Approved ${s.part}` : `Changes requested on ${s.part}`); refresh(); }
    catch (e) { toast((e as Error).message, true); }
  };
  const c = s.checks;
  return (
    <>
      <section className="grid" style={{ minWidth: 0, alignContent: 'start' }}>
        <div className="panel">
          <header><h2>{m.name || s.part}</h2><span className="small muted">{s.part} · by {s.author}</span><span className="spacer" /><span className={'pill ' + STATUS[s.status]?.[1]}>{STATUS[s.status]?.[0]}</span></header>
          <div className="body grid" style={{ gap: 8 }}>
            <div className="small">{m.summary}</div>
            <div className="row wrap small" style={{ gap: 8 }}><TierPill tier={s.tier} long /><span className="muted">because it {s.tier_reasons.join('; ')}.</span></div>
            <div className="small muted">{TIER_INFO[s.tier as Tier].runs}</div>
          </div>
        </div>

        <div className="panel">
          <header><Icon name="cpu" size={16} className="hd-ic" /><h2>Automated checks</h2><Tip wide>Run by the marketplace on every submission. The behaviour test runs the part in the sandbox with sample inputs, answers HTTP calls from local mocks of the declared hosts only, declines every wallet request, and records what the part tried.</Tip><span className="spacer" />{!c ? <span className="pill warn">running</span> : <span className={'pill ' + (c.passed ? 'ok' : 'bad')}>{c.passed ? 'passed' : 'failed'}</span>}</header>
          {c && <div className="body grid" style={{ gap: 10 }}>
            <Diags title="Manifest (SRS-1 §2)" list={c.manifest} />
            <Diags title="Code (static checks)" list={c.lint} />
            <Diags title="Security scan" list={c.scan} />
            {c.notes.map((n: string, i: number) => <div key={i} className="diag warning">{n}</div>)}
            {c.behaviour.map((b: any) => (
              <div key={b.mode} className="behave">
                <div className="row small" style={{ gap: 6 }}><b>{b.mode === 'quote' ? 'As a quote (dry run)' : 'As a run'}</b><span className="muted">{b.ms} ms</span><span className="spacer" />{b.violations.length ? <span className="pill bad">{b.violations.length} violation{b.violations.length > 1 ? 's' : ''}</span> : <span className="pill ok">no violations</span>}</div>
                <dl className="kv small">
                  <dt>Hosts reached</dt><dd>{b.hosts.join(', ') || 'none'}</dd>
                  <dt>Asked the buyer to sign</dt><dd>{b.approvals.length ? b.approvals.map((a: any, i: number) => <div key={i}>{a.title}: {a.transactions.map((t: any) => `${t.receiverId} (${t.actions.map((x: any) => x.params?.methodName ?? x.type).join(', ')})`).join('; ') || (a.sign_message ? 'an off-chain message' : 'nothing')}</div>) : 'no'}</dd>
                  <dt>Saved state</dt><dd>{b.saves}×</dd>
                  <dt>Result</dt><dd>{b.ok ? Object.entries(b.outputs).map(([p, v]) => `${p}: ${v}`).join(', ') : b.approvals.length && b.mode === 'run' ? <span className="muted">stopped after the test declined the wallet request (expected)</span> : <span className="muted">stopped: {b.error}</span>}</dd>
                </dl>
                {b.violations.map((v: string, i: number) => <div key={i} className="diag error">{v}</div>)}
              </div>
            ))}
            {(c.facts.receivers.length > 0 || c.facts.methods.length > 0) && <div className="small"><span className="muted">Transaction receivers in code:</span> {c.facts.receivers.join(', ') || '—'} · <span className="muted">methods:</span> {c.facts.methods.join(', ') || '—'}</div>}
            <div className="small muted">Imports: {c.facts.imports.join(', ') || 'none'}</div>
          </div>}
        </div>

        <div className="panel">
          <header><Icon name="code" size={16} className="hd-ic" /><h2>Code</h2><span className="spacer" />
            <div className="subnav inner" role="tablist">
              {diff && <button role="tab" aria-selected={view === 'diff'} onClick={() => setView('diff')}>Changes since {s.previous.id}</button>}
              <button role="tab" aria-selected={view === 'source' || !diff} onClick={() => setView('source')}>Full source</button>
            </div>
          </header>
          {diff && view === 'diff'
            ? <pre className="code diff">{diff.map((l, i) => <div key={i} className={l.op === '+' ? 'add' : l.op === '-' ? 'del' : ''}>{l.op} {l.text}</div>)}</pre>
            : <pre className="code">{s.source}</pre>}
        </div>
      </section>

      <aside className="stack">
        <div className="panel">
          <header><Icon name="check" size={16} className="hd-ic" /><h2>Review</h2><span className="spacer" />{s.needed > 0 && <span className="pill">{approvals.length}/{s.needed} approvals</span>}</header>
          <div className="body grid" style={{ gap: 10 }}>
            {s.needed === 0 && <div className="small">{s.status === 'failed_checks' ? 'Open-tier parts are admitted on the automated checks alone, and these did not pass.' : 'Open tier: no reviewer needed. It is admitted once the automated checks pass, and runs in the sandbox.'}</div>}
            {s.reviews.map((r: any) => (
              <div key={r.reviewer} className={'diag ' + (r.verdict === 'approve' ? 'ok' : 'error')}><b>{r.reviewer}</b> {r.verdict === 'approve' ? 'approved' : 'requested changes'}{r.notes ? `: ${r.notes}` : ''}</div>
            ))}
            {s.needed > 0 && s.status === 'in_review' && !isReviewer && <div className="small muted">Only appointed reviewers can approve ({(s.reviewers as string[]).join(', ')}). Switch “Acting as” to one of them.</div>}
            {isReviewer && acting === s.author && <div className="small muted">You wrote this part, so you cannot review it.</div>}
            {already && <div className="small muted">You reviewed this submission.</div>}
            {canReview && <>
              <div className="sectlabel">Confirm each point<Tip wide>Your approval is signed by your wallet over the exact manifest and code, and goes into the release log. It is public, with your name on it.</Tip></div>
              {items.map((it) => (
                <label key={it.id} className="row small" style={{ alignItems: 'flex-start', gap: 8 }}>
                  <input type="checkbox" checked={ticks.includes(it.id)} onChange={(e) => setTicks((t) => (e.target.checked ? [...t, it.id] : t.filter((x) => x !== it.id)))} style={{ marginTop: 3 }} />{it.label}
                </label>
              ))}
              <div className="field"><label htmlFor="rv-notes">Notes (required to request changes)</label><textarea id="rv-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What you checked, or what has to change" /></div>
              <div className="row" style={{ gap: 6 }}>
                <button className="btn primary" disabled={!items.every((i) => ticks.includes(i.id))} onClick={() => send('approve')}><Icon name="check" size={14} />Approve</button>
                <button className="btn ghost" disabled={!notes.trim()} onClick={() => send('reject')}>Request changes</button>
              </div>
            </>}
          </div>
        </div>
        <div className="panel">
          <header><Icon name="vault" size={16} className="hd-ic" /><h2>Release</h2></header>
          <div className="body small grid" style={{ gap: 6 }}>
            {s.status === 'released' ? <div className="gain row"><Icon name="check" size={13} />Released {s.released_at}. Its record is in the runner’s release log.</div>
              : s.status === 'approved' ? <div>Admitted. It ships in the next runner release, when the owner runs <code>npm run release:parts</code>: the code, the manifest and this record go into a release whose code hash every buyer checks.</div>
                : <div className="muted">Ships after admission, in the next runner release cut by the owner.</div>}
            <div className="muted">Manifest {s.manifest_hash.slice(0, 12)}… · code {s.source_sha256.slice(0, 12)}…</div>
          </div>
        </div>
      </aside>
    </>
  );
}
