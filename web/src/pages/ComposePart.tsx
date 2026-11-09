import { useEffect, useMemo, useState } from 'react';
import { withdrawalRisk, type Catalog, type PartManifest, type Diagnostic } from '../../../core/src/srs';
import { lintPartSource, partTemplate, validatePartManifest } from '../../../core/src/partkit';
import { hashObject, sha256Hex } from '../../../core/src/canonical';
import { partTier, reviewedManifestHash, securityScan, submissionMessage, TIER_INFO, type ReleaseRecord } from '../../../core/src/review';
import { base64 } from '../../../core/src/seal';
import { demoWalletSign } from '../../../core/src/creator';
import { TierPill, admissionLine, TiersTip } from '../components/Admission';
import { api, short, txRef, usd, usePoll } from '../api';
import { useApp } from '../App';
import { RiskPill } from './ComposeRecipe';
import { CAT, Icon } from '../icons';
import { Tip } from '../ui';

/**
 * Compose › Part: build a part from scratch, or open any part to see its internals (every part in this demo is
 * public). Live SRS-1 conformance checks on the manifest, static and security checks on the code, and the admission
 * tier the manifest puts the part in (SRS-1 §11). Registering puts the manifest hash on-chain; submitting sends the
 * signed code to the review queue; the part runs once it is admitted and shipped in a runner release.
 */
type Port = { name: string; type: string; description?: string };
type Param = { name: string; type: string; default: string; secret: boolean; description?: string };
interface Draft {
  id: string; name: string; category: PartManifest['category']; author: string; summary: string;
  inputs: Port[]; outputs: Port[]; params: Param[];
  hosts: string[]; wallet: boolean; fee: string;
  limits: { max_ms: number; max_http_calls: number; max_model_calls: number; max_output_bytes: number };
  model: { kind: 'none' | 'open-weights' | 'closed'; name: string; host: string };
  instructions: 'open' | 'sealed' | 'closed'; verification: 'open' | 'sealed' | 'closed'; runtime: 'bundled' | 'remote';
  visibility: 'public' | 'private';
}
const CATS: [PartManifest['category'], string, string][] = [
  ['source', 'Read', 'fetches data (balances, keys, positions). No side effects.'],
  ['guard', 'Check', 'judges or filters what a source returned.'],
  ['transform', 'Decide', 'computes what to act on. Pure: no network.'],
  ['action', 'Act', 'prepares transactions for the buyer to sign (wallet:approve).'],
  ['sink', 'Report', 'turns results into a report for the buyer.'],
];

function fromManifest(m: PartManifest): Draft {
  return {
    id: m.id, name: m.name, category: m.category, author: m.author, summary: m.summary ?? '',
    inputs: Object.entries(m.inputs).map(([name, s]) => ({ name, type: s.type, description: s.description })),
    outputs: Object.entries(m.outputs).map(([name, s]) => ({ name, type: s.type, description: s.description })),
    params: Object.entries(m.params).map(([name, s]) => ({ name, type: s.type, default: s.default === undefined ? '' : Array.isArray(s.default) ? (s.default as string[]).join(', ') : String(s.default), secret: !!s.secret, description: s.description })),
    hosts: m.capabilities.filter((c) => c.startsWith('net:')).map((c) => c.slice(4)), wallet: m.capabilities.includes('wallet:approve'), fee: m.fee_per_call,
    limits: m.limits ?? { max_ms: 10000, max_http_calls: 4, max_model_calls: 0, max_output_bytes: 32000 },
    model: { kind: m.disclosure.model.kind, name: m.disclosure.model.name ?? '', host: m.disclosure.model.host ?? '' },
    instructions: m.disclosure.instructions, verification: m.disclosure.verification, runtime: m.disclosure.runtime,
    visibility: m.disclosure.harness === 'open' ? 'public' : 'private',
  };
}
function toManifest(d: Draft): PartManifest {
  const val = (p: Param) => (p.default === '' ? undefined : p.type === 'number' ? Number(p.default) : p.type === 'boolean' ? p.default === 'true' : p.type === 'string[]' ? p.default.split(',').map((x) => x.trim()).filter(Boolean) : p.default);
  return {
    id: d.id, name: d.name, category: d.category, author: d.author, summary: d.summary,
    inputs: Object.fromEntries(d.inputs.map((p) => [p.name, { type: p.type, ...(p.description ? { description: p.description } : {}) }])),
    outputs: Object.fromEntries(d.outputs.map((p) => [p.name, { type: p.type, ...(p.description ? { description: p.description } : {}) }])),
    params: Object.fromEntries(d.params.map((p) => [p.name, { type: p.type, ...(val(p) !== undefined ? { default: val(p) } : {}), ...(p.secret ? { secret: true } : {}), ...(p.description ? { description: p.description } : {}) }])),
    capabilities: [...d.hosts.map((h) => `net:${h}`), ...(d.wallet ? ['wallet:approve'] : [])],
    fee_per_call: d.fee,
    disclosure: { model: d.model.kind === 'none' ? { kind: 'none' } : { kind: d.model.kind, name: d.model.name, ...(d.model.host ? { host: d.model.host } : {}) }, instructions: d.instructions, harness: d.visibility === 'public' ? 'open' : 'sealed', verification: d.verification, runtime: d.runtime },
    limits: d.limits,
  } as PartManifest;
}
const blankDraft = (author: string): Draft => ({
  id: `${author.split('.')[0].replace(/[^a-z0-9-]/g, '') || 'me'}.my-part@1.0.0`, name: '', category: 'guard', author, summary: '',
  inputs: [{ name: 'holdings', type: 'token.holdings' }], outputs: [{ name: 'clean', type: 'token.holdings' }], params: [],
  hosts: [], wallet: false, fee: '10000', limits: { max_ms: 5000, max_http_calls: 0, max_model_calls: 0, max_output_bytes: 32000 },
  model: { kind: 'none', name: '', host: '' }, instructions: 'open', verification: 'open', runtime: 'bundled', visibility: 'public',
});

let savedPart: { draft: Draft; code: string; touched: boolean } | null = null;

export function ComposePart({ part }: { part?: string }) {
  const { acting, go, toast } = useApp();
  const [cat] = usePoll<Catalog & { onchain: Record<string, { manifest_hash: string }> }>('/api/catalog', 60000);
  const catalog = cat as Catalog | undefined;
  const viewing = catalog?.parts.find((p) => p.id === part);
  const [draft, setDraft] = useState<Draft>(() => savedPart?.draft ?? blankDraft(acting));
  const [code, setCode] = useState(() => savedPart?.code ?? '');
  const [codeTouched, setCodeTouched] = useState(() => savedPart?.touched ?? false);
  const [src, setSrc] = useState<{ source: string; path: string; helpers: string[] } | null>(null);
  const [tab, setTab] = useState<'manifest' | 'code' | 'preview'>('manifest');
  const [q, setQ] = useState('');
  const [registered, setRegistered] = useState<{ tx: string } | null>(null);

  // viewing a published part: its manifest and source, read-only
  useEffect(() => {
    setSrc(null);
    if (!viewing) { if (savedPart) { setDraft(savedPart.draft); setCode(savedPart.code); setCodeTouched(savedPart.touched); } return; }
    setDraft(fromManifest(viewing)); setTab('code');
    api(`/api/parts/${encodeURIComponent(viewing.id)}/source`).then(setSrc).catch(() => setSrc(null));
  }, [viewing?.id]);
  const readOnly = !!viewing;
  useEffect(() => { if (!readOnly) savedPart = { draft, code, touched: codeTouched }; }, [draft, code, codeTouched, readOnly]);
  const m = useMemo(() => toManifest(draft), [draft]);
  // a new part's code follows its manifest until the builder edits it
  useEffect(() => { if (!readOnly && !codeTouched) setCode(partTemplate(m)); }, [m, readOnly, codeTouched]);
  const shownCode = readOnly ? src?.source ?? 'Loading…' : code;
  const manifestDiags = catalog ? validatePartManifest(m, catalog, { isNew: !readOnly }) : [];
  const codeDiags = readOnly && catalog && catalog.parts.filter((p) => p.implementation === viewing?.implementation).length > 1
    ? lintPartSource(shownCode, m).filter((d) => !d.code.startsWith('capability') && d.code !== 'output.missing') // a file shared by several parts
    : lintPartSource(shownCode, m);
  const scanDiags = readOnly ? [] : securityScan(shownCode, m).diagnostics;
  const all = [...manifestDiags.map((d) => ({ ...d, where: 'manifest' })), ...codeDiags.map((d) => ({ ...d, where: 'code' })), ...scanDiags.map((d) => ({ ...d, where: 'security' }))];
  const tier = partTier(m);
  const [subs] = usePoll<{ id: string; part: string; status: string; approvals: number; needed: number }[]>('/api/parts/submissions', 4000);
  const mine = (subs ?? []).find((x) => x.part === m.id);
  const [adm] = usePoll<{ records: ReleaseRecord[] }>('/api/parts/admission', 60000);
  const record = viewing ? adm?.records.find((r) => r.part === viewing.id) : undefined;
  const onchainHash = (cat as any)?.onchain?.[m.id]?.manifest_hash;
  const isRegistered = !!registered || onchainHash === hashObject(m);
  const errs = all.filter((d) => d.severity === 'error');
  const types = Object.keys(catalog?.types ?? {});
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => { setDraft((d) => ({ ...d, [k]: v })); setRegistered(null); };

  const startNew = () => { go({ page: 'compose', sub: 'part' }); setDraft(blankDraft(acting)); setCodeTouched(false); setTab('manifest'); setRegistered(null); };
  const copyFrom = () => {
    if (!viewing) return;
    const ns = acting.split('.')[0].replace(/[^a-z0-9-]/g, '') || 'me';
    const base = viewing.id.split('@')[0].split('.').slice(1).join('.') || 'part';
    const d = { ...fromManifest(viewing), id: `${ns}.${base}@1.0.0`, author: acting, name: viewing.name + ' (mine)' };
    go({ page: 'compose', sub: 'part' });
    setTimeout(() => { setDraft(d); setCode(src?.source ?? ''); setCodeTouched(true); setTab('manifest'); }, 0);
  };
  const download = () => {
    const blob = new Blob([JSON.stringify({ manifest: m, manifest_hash: hashObject(m), source: { path: `runner/src/parts/${m.id.split('@')[0].split('.').pop()}.ts`, code } }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${m.id.replace('@', '-')}.srs-part.json`; a.click();
  };
  const submit = async () => {
    try {
      const sig = base64.enc(demoWalletSign(acting, submissionMessage(m.id, reviewedManifestHash(m), sha256Hex(code.replace(/\r\n/g, '\n')), acting)));
      const r = await api('/api/parts/submissions', { manifest: m, source: code, signature: sig });
      toast(`Submitted ${m.id}: automated checks running`); go({ page: 'compose', sub: 'review', part: r.id });
    } catch (e) { toast((e as Error).message, true); }
  };
  const register = async () => {
    try {
      const r = await api('/api/chain/tx', { signer: acting, method: 'register_part', args: { id: m.id, version: m.id.split('@')[1], fee_per_call: m.fee_per_call, manifest_hash: hashObject(m) } });
      setRegistered({ tx: r.tx }); toast(`Registered ${m.id} · ${txRef(r.tx)}`);
    } catch (e) { toast((e as Error).message, true); }
  };

  const list = (catalog?.parts ?? []).filter((p) => !q || `${p.name} ${p.id} ${p.author} ${p.summary}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="grid">
    <div className="banner" role="note"><BrandSeal /><div><b className="big">Build a part, get paid on every run.</b> <Tip wide>A part is a building block other people put inside private recipes and pay for on every run. It may only read its declared inputs, reach its declared hosts, ask for signatures if it is an “Act” part, and must be read-only during quotes. The conformance checks must pass before it can be registered, and the code is reviewed before it ships in the audited runner.</Tip><div className="small">Every part follows SRS-1: typed ports, declared capabilities, read-only quotes.</div></div></div>
    <div className="grid partpage">
      <aside className="stack">
        <div className="panel partlist">
          <header><Icon name="box" size={16} className="hd-ic" /><h2>Parts</h2><Tip>All public in this demo: open one to read its code.</Tip></header>
          <div className="body" style={{ paddingBottom: 6 }}>
            <button className="btn primary" style={{ width: '100%' }} onClick={startNew}><Icon name="plus" size={15} />New part</button>
            <label className="search-wrap" style={{ marginTop: 10 }}><Icon name="search" size={15} /><input className="search" type="search" placeholder="Search parts" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search parts" /></label>
          </div>
          <ul className="plist">
            {CATS.map(([c, label]) => {
              const items = list.filter((p) => p.category === c);
              return items.length ? [<li key={c} className="cat" style={{ color: CAT[c]?.color }}><Icon name={CAT[c]?.icon ?? 'box'} size={13} />{label}</li>, ...items.map((p) => (
                <li key={p.id}><button aria-current={p.id === part ? 'true' : undefined} onClick={() => go({ page: 'compose', sub: 'part', part: p.id })}><b>{p.name}</b><span>{p.id}</span></button></li>
              ))] : null;
            })}
          </ul>
        </div>
        <div className="panel standard">
          <header><Icon name="shieldCheck" size={16} className="hd-ic" /><h2>The rules</h2><Tip>A recipe author never sees your code, and buyers never see the recipe. What makes that safe is that every part does exactly what its manifest declares, and the runner enforces it.</Tip></header>
          <div className="body small grid" style={{ gap: 6 }}>
            <ul>
              <li><Icon name="link" size={15} /><span><b>Typed ports</b> <Tip>Inputs and outputs use the spec’s types, so parts snap together and can be swapped.</Tip></span></li>
              <li><Icon name="globe" size={15} /><span><b>Declared hosts only</b> <Tip>The part can only reach the hosts it lists (net:…); only Act parts may ask the buyer to sign (wallet:approve), and they never sign themselves.</Tip></span></li>
              <li><Icon name="eye" size={15} /><span><b>Read-only quotes</b> <Tip>With ctx.mode = "quote" the part must be read-only.</Tip></span></li>
              <li><Icon name="refresh" size={15} /><span><b>Durable</b> <Tip>Save state before any irreversible step; resume after a restart without asking twice.</Tip></span></li>
              <li><Icon name="info" size={15} /><span><b>Disclosure</b> <Tip>Name the model, and say which layers are open, sealed or closed. It sets the withdrawal risk buyers see.</Tip></span></li>
              <li><Icon name="clock" size={15} /><span><b>Limits</b> <Tip>Time, HTTP calls, model calls and output size are capped per run.</Tip></span></li>
              <li><Icon name="shieldCheck" size={15} /><span><b>Admission by tier</b> <Tip wide>Open parts (pure, or reading public NEAR data) are admitted on automated checks and run in a sandbox. Parts that send buyer data somewhere new need one appointed reviewer; parts that ask buyers to sign need two.</Tip></span></li>
            </ul>
            <button className="linkbtn" onClick={() => go({ page: 'docs', sub: 'spec' })}><Icon name="docs" size={13} />Full spec</button>
          </div>
        </div>
      </aside>

      <section className="panel" style={{ minWidth: 0 }}>
        <header>
          <h2>{readOnly ? viewing!.name : draft.name || 'New part'}</h2>
          <span className="small muted">{readOnly ? `${viewing!.id} · public · read-only` : 'draft'}</span>
          <span className="spacer" />
          {readOnly && <button className="btn sm" onClick={copyFrom}><Icon name="plus" size={13} />Use as a starting point</button>}
        </header>
        <div className="subnav inner" role="tablist">
          {(['manifest', 'code', 'preview'] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t === 'manifest' ? 'Manifest' : t === 'code' ? 'Code' : 'Preview'}</button>)}
        </div>
        {tab === 'manifest' && (
          <fieldset className="plainset body grid manifest" disabled={readOnly}>
            <div className="grid two">
              <div className="field"><label>Id (namespace.name@version)</label><input value={draft.id} onChange={(e) => set('id', e.target.value.trim())} /></div>
              <div className="field"><label>Name in the palette</label><input value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Price Guard" /></div>
            </div>
            <div className="field"><label>What it does, in one sentence (buyers and creators read this)</label><input value={draft.summary} onChange={(e) => set('summary', e.target.value)} /></div>
            <div className="field"><label>Kind of step</label>
              <div className="catpick">{CATS.map(([c, label, help]) => <label key={c} className={draft.category === c ? 'on' : ''} style={{ ['--cc' as any]: CAT[c]?.color }} title={help}><input type="radio" name="cat" checked={draft.category === c} onChange={() => { set('category', c); if (c !== 'action') set('wallet', false); }} /><b><Icon name={CAT[c]?.icon ?? 'box'} size={14} />{label}</b><span>{help}</span></label>)}</div>
            </div>
            <PortTable title="Inputs" ports={draft.inputs} types={types} onChange={(v) => set('inputs', v)} />
            <PortTable title="Outputs" ports={draft.outputs} types={types} onChange={(v) => set('outputs', v)} />
            <ParamTable params={draft.params} onChange={(v) => set('params', v)} />
            <div className="grid two">
              <div className="field"><label>Hosts it may call (one per line)</label><textarea value={draft.hosts.join('\n')} onChange={(e) => set('hosts', e.target.value.split(/\s+/).map((x) => x.trim()).filter(Boolean))} placeholder="rpc.mainnet.fastnear.com" /></div>
              <div className="grid" style={{ gap: 6, alignContent: 'start' }}>
                <label className="row small"><input type="checkbox" checked={draft.wallet} disabled={draft.category !== 'action' || readOnly} onChange={(e) => set('wallet', e.target.checked)} /> Asks the buyer to sign transactions (wallet:approve)</label>
                <div className="field"><label>Fee per run (USDC), paid to {draft.author}</label><input value={Number(draft.fee) / 1e6} inputMode="decimal" onChange={(e) => set('fee', String(Math.max(0, Math.round(Number(e.target.value) * 1e6) || 0)))} /></div>
              </div>
            </div>
            <div className="grid four">
              <div className="field"><label>Max time (ms)</label><input value={draft.limits.max_ms} inputMode="numeric" onChange={(e) => set('limits', { ...draft.limits, max_ms: Number(e.target.value) || 0 })} /></div>
              <div className="field"><label>HTTP calls</label><input value={draft.limits.max_http_calls} inputMode="numeric" onChange={(e) => set('limits', { ...draft.limits, max_http_calls: Number(e.target.value) || 0 })} /></div>
              <div className="field"><label>Model calls</label><input value={draft.limits.max_model_calls} inputMode="numeric" onChange={(e) => set('limits', { ...draft.limits, max_model_calls: Number(e.target.value) || 0 })} /></div>
              <div className="field"><label>Output bytes</label><input value={draft.limits.max_output_bytes} inputMode="numeric" onChange={(e) => set('limits', { ...draft.limits, max_output_bytes: Number(e.target.value) || 0 })} /></div>
            </div>
            <div className="sectlabel">Disclosure (SRS-1 §2.1) <RiskPill risk={withdrawalRisk(m.disclosure)} label /></div>
            <div className="grid four">
              <div className="field"><label>Model</label><select value={draft.model.kind} onChange={(e) => set('model', { ...draft.model, kind: e.target.value as Draft['model']['kind'] })}><option value="none">none (plain code)</option><option value="open-weights">open-weights</option><option value="closed">closed</option></select></div>
              {draft.model.kind !== 'none' && <div className="field" style={{ gridColumn: 'span 2' }}><label>Model name</label><input value={draft.model.name} onChange={(e) => set('model', { ...draft.model, name: e.target.value })} placeholder="Qwen/Qwen3-30B-A3B-Instruct-2507" /></div>}
              <div className="field"><label>Runs</label><select value={draft.runtime} onChange={(e) => set('runtime', e.target.value as Draft['runtime'])}><option value="bundled">bundled in the runner</option><option value="remote">remote service</option></select></div>
              <div className="field"><label>Instructions</label><select value={draft.instructions} onChange={(e) => set('instructions', e.target.value as Draft['instructions'])}><option>open</option><option>sealed</option><option>closed</option></select></div>
              <div className="field"><label>Verification</label><select value={draft.verification} onChange={(e) => set('verification', e.target.value as Draft['verification'])}><option>open</option><option>sealed</option><option>closed</option></select></div>
              <div className="field" style={{ gridColumn: 'span 2' }}><label>Code visibility</label>
                <select value={draft.visibility} onChange={(e) => set('visibility', e.target.value as Draft['visibility'])}><option value="public">public: anyone can read the source</option><option value="private">private: source sealed to the runner</option></select></div>
            </div>
            <div className="small muted">{draft.visibility === 'public' ? 'Public parts can be audited by anyone, which makes them easy to trust and to swap in.' : 'Private parts keep your code secret from creators and buyers. It is escrowed to the attested runner (harness: sealed), so it can still be rebuilt if you disappear; buyers see that it is private.'}</div>
          </fieldset>
        )}
        {tab === 'code' && (
          <div className="body grid" style={{ gap: 8 }}>
            <div className="row small wrap" style={{ gap: 8 }}>
              <span className="muted">{readOnly ? `${src?.path ?? ''}${src?.helpers?.length ? ` · uses ${src.helpers.join(', ')}` : ''}` : 'TypeScript. Starts from a template generated from your manifest.'}</span>
              <span className="spacer" />
              {!readOnly && codeTouched && <button className="btn ghost sm" onClick={() => { setCodeTouched(false); }}>Regenerate from the manifest</button>}
            </div>
            <textarea className="code" spellCheck={false} readOnly={readOnly} value={shownCode} onChange={(e) => { setCode(e.target.value); setCodeTouched(true); }} aria-label="Part source code" />
          </div>
        )}
        {tab === 'preview' && (
          <div className="body grid" style={{ gap: 12 }}>
            <div className="sectlabel">In the Recipe composer’s palette</div>
            <div className="palette" style={{ maxWidth: 360 }}><div className="item"><b>{m.name || 'Untitled'}</b><span>{m.author} · {usd(m.fee_per_call || '0', 2)} per run</span><div className="sum">{m.summary}</div></div></div>
            <div className="sectlabel">Manifest (registered on-chain as its hash)</div>
            <pre className="codebox" style={{ maxHeight: 360 }}>{JSON.stringify(m, null, 2)}</pre>
            <div className="small">manifest_hash <span className="hash">{hashObject(m)}</span></div>
          </div>
        )}
      </section>

      <aside className="stack">
        <div className="panel">
          <header><Icon name="shieldCheck" size={16} className="hd-ic" /><h2>Conformance</h2><span className="spacer" /><span className={'pill ' + (errs.length ? 'bad' : 'ok')}>{errs.length ? `${errs.length} to fix` : 'conforms'}</span></header>
          <div className="body">
            {!all.length && <div className="small gain row"><Icon name="check" size={14} />Conforms to SRS-1</div>}
            {all.map((d, i) => <Diag key={i} d={d} where={d.where} />)}
            <div className="small muted row" style={{ marginTop: 8 }}>Static and security checks <Tip wide>They catch common mistakes and the usual ways code escapes its manifest (other modules, process, code generation, hidden strings, undeclared hosts). They are a filter, not a proof: after you submit, the part is also run in the sandbox, and parts that send data somewhere new or ask buyers to sign are read by appointed reviewers.</Tip></div>
          </div>
        </div>
        {!readOnly && (
          <div className="panel">
            <header><Icon name="flag" size={16} className="hd-ic" /><h2>Admission</h2><TiersTip /><span className="spacer" /><TierPill tier={tier.tier} /></header>
            <div className="body grid" style={{ gap: 8 }}>
              <div className="small">This part {tier.reasons.join('; ')}, so it needs <b>{TIER_INFO[tier.tier].short}</b>.</div>
              <ol className="submit-steps small">
                <li className={isRegistered ? 'done' : ''}><span className="sn">{isRegistered ? <Icon name="check" size={12} /> : 1}</span><span><b>Register on-chain</b> <Tip>As {acting}: id, fee and manifest hash. You are paid the fee in every settlement that uses the part.</Tip></span></li>
                <li className={mine ? 'done' : ''}><span className="sn">{mine ? <Icon name="check" size={12} /> : 2}</span><span><b>Submit for review</b> <Tip>Your code, signed by your wallet. The marketplace runs the automated checks: conformance, security scan, and a behaviour test in the sandbox.</Tip></span></li>
                <li className={mine && ['approved', 'released'].includes(mine.status) ? 'done' : ''}><span className="sn">3</span><span><b>{tier.tier === 'open' ? 'Admitted on the checks' : tier.tier === 'reviewed' ? 'One reviewer approves' : 'Two reviewers approve'}</b> <Tip wide>{TIER_INFO[tier.tier].runs}</Tip></span></li>
                <li className={mine?.status === 'released' ? 'done' : ''}><span className="sn">4</span><span><b>Released</b> <Tip>The owner ships admitted parts in the next runner release. Its code hash covers your code and its review record; the runner refuses any part whose record does not verify.</Tip></span></li>
                <li><span className="sn">5</span><span><b>Earn per run</b> <Tip>Creators can add it in Compose, and any recipe using it pays you per run.</Tip></span></li>
              </ol>
              {draft.author !== acting && <div className="diag warning">The author is {draft.author}; switch “Acting as” to that account to register and submit.</div>}
              {mine && <button className="linkbtn" onClick={() => go({ page: 'compose', sub: 'review', part: mine.id })}><Icon name="shieldCheck" size={13} />Submission: {mine.status.replace('_', ' ')}{mine.needed ? ` · ${mine.approvals}/${mine.needed} approvals` : ''}</button>}
              <button className="btn" disabled={!!errs.length || isRegistered || draft.author !== acting} onClick={register}>{isRegistered ? <><Icon name="check" size={14} />Registered{registered ? ` · ${txRef(registered.tx)}` : ''}</> : 'Register on-chain'}</button>
              <button className="btn primary" disabled={!!errs.length || !isRegistered || draft.author !== acting || !!(mine && mine.status !== 'failed_checks' && mine.status !== 'changes_requested')} onClick={submit}><Icon name="shieldCheck" size={14} />Submit for review</button>
              <button className="btn ghost" disabled={!!errs.length} onClick={download}><Icon name="download" size={14} />Download submission</button>
            </div>
          </div>
        )}
        {readOnly && viewing && (
          <div className="panel">
            <header><Icon name="vault" size={16} className="hd-ic" /><h2>On-chain</h2></header>
            <dl className="kv body small">
              <dt>Author (paid per run)</dt><dd>{viewing.author}</dd>
              <dt>Fee</dt><dd>{usd(viewing.fee_per_call, 2)}</dd>
              <dt>Manifest hash</dt><dd className="hash">{short((cat as any)?.onchain?.[viewing.id]?.manifest_hash ?? '', 10, 6)}</dd>
              <dt>Can reach</dt><dd>{viewing.capabilities.join(', ') || 'nothing (pure)'}</dd>
            </dl>
          </div>
        )}
        {readOnly && viewing && (
          <div className="panel">
            <header><Icon name="shieldCheck" size={16} className="hd-ic" /><h2>Admission</h2><TiersTip /><span className="spacer" /><TierPill tier={partTier(viewing).tier} /></header>
            <div className="body small grid" style={{ gap: 6 }}>
              <div>{admissionLine(record)}</div>
              <div className="muted">{TIER_INFO[partTier(viewing).tier].runs}</div>
              {record && <div className="muted hash">code {record.source_sha256.slice(0, 16)}…</div>}
            </div>
          </div>
        )}
      </aside>
    </div>
    </div>
  );
}

const BrandSeal = () => <svg width="34" height="34" viewBox="0 0 32 32" aria-hidden><path d="M16 2l2.4 1.9 3-.4.9 2.9 2.7 1.4-.7 3 1.4 2.7-2.4 1.9-.1 3-3 .4-1.7 2.5-2.8-1-2.8 1-1.7-2.5-3-.4-.1-3-2.4-1.9 1.4-2.7-.7-3 2.7-1.4.9-2.9 3 .4z" transform="translate(0 4)" fill="#F2C14E" stroke="#9A5F00" strokeWidth=".9" /><path d="M11.5 16.5l3 3 6-6.5" stroke="#5A3700" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>;

function Diag({ d, where }: { d: Diagnostic; where: string }) {
  return <div className={'diag ' + d.severity}><span className="pill" style={{ marginRight: 6 }}>{where}</span>{d.message}</div>;
}

function PortTable({ title, ports, types, onChange }: { title: string; ports: Port[]; types: string[]; onChange: (p: Port[]) => void }) {
  return (
    <div className="grid" style={{ gap: 4 }}>
      <div className="sectlabel">{title}</div>
      {ports.map((p, i) => (
        <div key={i} className="porttbl">
          <input aria-label={`${title} name`} value={p.name} onChange={(e) => onChange(ports.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="name" />
          <select aria-label={`${title} type`} value={p.type} onChange={(e) => onChange(ports.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}>{types.map((t) => <option key={t}>{t}</option>)}</select>
          <button className="btn ghost sm" aria-label="Remove" onClick={() => onChange(ports.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button className="btn ghost sm" style={{ justifySelf: 'start' }} onClick={() => onChange([...ports, { name: '', type: types[0] ?? 'report' }])}>Add {title.toLowerCase().slice(0, -1)}</button>
    </div>
  );
}

function ParamTable({ params, onChange }: { params: Param[]; onChange: (p: Param[]) => void }) {
  return (
    <div className="grid" style={{ gap: 4 }}>
      <div className="sectlabel">Settings the recipe creator fills in <span className="muted">· “sealed” values are part of the creator’s edge</span></div>
      {params.map((p, i) => (
        <div key={i} className="porttbl param">
          <input aria-label="Setting name" value={p.name} onChange={(e) => onChange(params.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="name" />
          <select aria-label="Setting type" value={p.type} onChange={(e) => onChange(params.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}><option>string</option><option>number</option><option>string[]</option><option>boolean</option></select>
          <input aria-label="Default" value={p.default} onChange={(e) => onChange(params.map((x, j) => (j === i ? { ...x, default: e.target.value } : x)))} placeholder="default" />
          <label className="small row" style={{ gap: 4 }}><input type="checkbox" checked={p.secret} onChange={(e) => onChange(params.map((x, j) => (j === i ? { ...x, secret: e.target.checked } : x)))} />sealed</label>
          <button className="btn ghost sm" aria-label="Remove" onClick={() => onChange(params.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button className="btn ghost sm" style={{ justifySelf: 'start' }} onClick={() => onChange([...params, { name: '', type: 'string', default: '', secret: true }])}>Add setting</button>
    </div>
  );
}
