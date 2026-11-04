import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, Controls, Handle, Position, applyNodeChanges, type Connection, type Edge, type Node, type NodeChange, type NodeProps, type EdgeChange, ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { compatibleSwaps, swapPart, validateRecipe, withdrawalRisk, type PartManifest, type Catalog, type Recipe, type FormField } from '../../../core/src/frs';
import { api, money, usd, usePoll } from '../api';
import { useApp } from '../App';
import { SealModal } from '../components/SealModal';
import { open, type SealedEnvelope } from '../../../core/src/seal';
import { creatorKeyFromSignature, creatorKeyMessage, demoWalletSign } from '../../../core/src/creator';
import CLNP from '../../../seed/recipes/CLNP.json';
import SWPR from '../../../seed/recipes/SWPR.json';

const TEMPLATES: Record<string, Recipe> = { CLNP: CLNP as unknown as Recipe, SWPR: SWPR as unknown as Recipe };
const RUNNER_FEE = 30000n;
const PROTOCOL_BPS = 200n;
const CAT_ORDER = ['source', 'guard', 'transform', 'action', 'sink'];
const CAT_LABEL: Record<string, string> = { source: 'Sources', guard: 'Guards', transform: 'Transforms', action: 'Actions', sink: 'Outputs' };

function blank(): Recipe {
  return { frs: '1.0', kind: 'recipe', meta: { ticker: '', name: 'Untitled recipe', creator: 'chef.testnet', description: '' }, form: [], nodes: [], output: '', listing: { price_per_run: '500000', royalty_bps: 1000, total_shares: '1000000' } };
}

type PartData = { manifest: PartManifest; label: string; errors: number };
function PartNode({ data, selected }: NodeProps<Node<PartData>>) {
  const m = data.manifest;
  const ins = Object.entries(m.inputs), outs = Object.entries(m.outputs);
  return (
    <div className={'fnode' + (selected ? ' selected' : '') + (data.errors ? ' err' : '')}>
      <div className="hd"><b>{m.name}</b><span className={'cat-' + m.category}>{m.category}</span> <span>· {m.author} · {usd(m.fee_per_call, 2)}</span></div>
      <div className="ports">
        <div>{ins.map(([p, s]) => (<div key={p} className="port"><Handle type="target" position={Position.Left} id={p} style={{ left: -6 }} />{p}<i>{s.type}</i></div>))}</div>
        <div>{outs.map(([p, s]) => (<div key={p} className="port out"><Handle type="source" position={Position.Right} id={p} style={{ right: -6 }} />{p}<i>{s.type}</i></div>))}</div>
      </div>
    </div>
  );
}
function FormNode({ data, selected }: NodeProps<Node<{ fields: FormField[]; consts: [string, { type: string }][] }>>) {
  return (
    <div className={'fnode form' + (selected ? ' selected' : '')}>
      <div className="hd"><b>Buyer form</b><span>what the buyer fills in, one short form</span></div>
      <div className="ports" style={{ gridTemplateColumns: '1fr' }}>
        {data.fields.map((f) => (<div key={f.id} className="port out"><Handle type="source" position={Position.Right} id={f.id} style={{ right: -6 }} />{f.label}<i>{f.type}</i></div>))}
        {data.consts.map(([k, c]) => (<div key={'c' + k} className="port out"><Handle type="source" position={Position.Right} id={'const:' + k} style={{ right: -6 }} />const {k}<i>{c.type}</i></div>))}
        {!data.fields.length && <div className="port muted">Add fields in the inspector</div>}
      </div>
    </div>
  );
}
const nodeTypes = { part: PartNode, form: FormNode };

export function Compose() { return <ReactFlowProvider><ComposeInner /></ReactFlowProvider>; }

function ComposeInner() {
  const { story, toast, go, acting } = useApp();
  const [cat] = usePoll<Catalog & { onchain: Record<string, unknown> }>('/api/catalog', 60000);
  const [recipe, setRecipe] = useState<Recipe>(blank);
  const [formPos, setFormPos] = useState({ x: -260, y: 110 });
  const [sel, setSel] = useState<string | null>(null);
  const [ipo, setIpo] = useState({ price: 0.085, float_pct: 20 });
  const [sealing, setSealing] = useState(false);
  const [dims, setDims] = useState<Record<string, { width: number; height: number }>>({});
  const rf = useReactFlow();
  const storyRan = useRef(false);

  const catalog = cat as Catalog | undefined;
  const manifests = useMemo(() => new Map((catalog?.parts ?? []).map((b) => [b.id, b])), [catalog]);
  const v = useMemo(() => (catalog ? validateRecipe(recipe, catalog) : null), [recipe, catalog]);

  // ---------- recipe <-> flow ----------
  const nodes: Node[] = useMemo(() => [
    { id: 'form', type: 'form', position: formPos, measured: dims.form, data: { fields: recipe.form, consts: Object.entries(recipe.consts ?? {}) }, selected: sel === 'form', deletable: false },
    ...recipe.nodes.filter((n) => manifests.has(n.part)).map((n) => ({ id: n.id, type: 'part', position: n.ui ?? { x: 0, y: 0 }, measured: dims[n.id], selected: sel === n.id, data: { manifest: manifests.get(n.part)!, label: n.id, errors: v?.diagnostics.filter((d) => d.node === n.id && d.severity === 'error').length ?? 0 } })),
  ], [recipe, manifests, sel, v, formPos, dims]);
  const edges: Edge[] = useMemo(() => recipe.nodes.flatMap((n) => Object.entries(n.inputs).map(([port, ref]) => {
    const [src, ...rest] = ref.split('.'); const p = rest.join('.');
    const bad = v?.diagnostics.some((d) => d.node === n.id && d.port === port && d.severity === 'error');
    const sourceHandle = src === 'const' ? 'const:' + p : p;
    const source = src === 'const' ? 'form' : src;
    const t = src === 'form' ? recipe.form.find((f) => f.id === p)?.type : src === 'const' ? recipe.consts?.[p]?.type : manifests.get(recipe.nodes.find((x) => x.id === src)?.part ?? '')?.outputs[p]?.type;
    return { id: `${n.id}:${port}`, source, sourceHandle, target: n.id, targetHandle: port, ariaLabel: t, animated: story.step === 1, style: { stroke: bad ? '#b8364a' : '#15233f', strokeWidth: 1.5 }, labelStyle: { fontSize: 10, fill: '#5b6b84' }, labelBgStyle: { fill: '#edf0f3' } } as Edge;
  })), [recipe, v, manifests, story.step]);

  const onNodesChange = useCallback((ch: NodeChange[]) => {
    const dimCh = ch.filter((c) => c.type === 'dimensions' && (c as { dimensions?: unknown }).dimensions) as { id: string; dimensions: { width: number; height: number } }[];
    if (dimCh.length) setDims((d) => { const n = { ...d }; for (const c of dimCh) n[c.id] = c.dimensions; return n; });
    if (ch.every((c) => c.type === 'dimensions')) return;
    const moved = applyNodeChanges(ch, nodes);
    const fp = moved.find((n) => n.id === 'form'); if (fp) setFormPos(fp.position);
    const removed = ch.filter((c) => c.type === 'remove').map((c) => (c as { id: string }).id);
    setRecipe((r) => ({ ...r, nodes: r.nodes.filter((n) => !removed.includes(n.id)).map((n) => { const m = moved.find((x) => x.id === n.id); return m ? { ...n, ui: { x: Math.round(m.position.x), y: Math.round(m.position.y) } } : n; }).map((n) => ({ ...n, inputs: Object.fromEntries(Object.entries(n.inputs).filter(([, ref]) => !removed.includes(ref.split('.')[0]))) })) }));
    for (const c of ch) if (c.type === 'select' && c.selected) setSel(c.id);
  }, [nodes]);
  const onEdgesChange = useCallback((ch: EdgeChange[]) => {
    const rm = ch.filter((c) => c.type === 'remove').map((c) => (c as { id: string }).id);
    if (rm.length) setRecipe((r) => ({ ...r, nodes: r.nodes.map((n) => ({ ...n, inputs: Object.fromEntries(Object.entries(n.inputs).filter(([p]) => !rm.includes(`${n.id}:${p}`))) })) }));
  }, []);
  const onConnect = useCallback((c: Connection) => {
    if (!c.target || !c.targetHandle || !c.sourceHandle) return;
    const ref = c.source === 'form' ? (c.sourceHandle.startsWith('const:') ? 'const.' + c.sourceHandle.slice(6) : 'form.' + c.sourceHandle) : `${c.source}.${c.sourceHandle}`;
    setRecipe((r) => {
      const nodes2 = r.nodes.map((n) => (n.id === c.target ? { ...n, inputs: { ...n.inputs, [c.targetHandle!]: ref } } : n));
      // the last node in the graph becomes the recipe output if none is set
      const target = nodes2.find((n) => n.id === c.target)!;
      const m = manifests.get(target.part);
      const output = r.output || (m ? `${target.id}.${Object.keys(m.outputs)[0]}` : '');
      return { ...r, nodes: nodes2, output };
    });
  }, [manifests]);

  const addPart = (m: PartManifest, pos?: { x: number; y: number }) => {
    const base = m.id.split('@')[0].split('.').pop()!.replace(/[^a-z]/g, '').slice(0, 16) || 'node';
    let id = base, i = 2; while (recipe.nodes.some((n) => n.id === id) || id === 'form') id = base + i++;
    const params = Object.fromEntries(Object.entries(m.params).map(([k, s]) => [k, s.default ?? '']));
    setRecipe((r) => ({ ...r, nodes: [...r.nodes, { id, part: m.id, inputs: {}, params, ui: pos ?? { x: 120 + r.nodes.length * 60, y: 60 + r.nodes.length * 40 } }] }));
    setSel(id);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('application/frs-part'); const m = manifests.get(id); if (!m) return;
    addPart(m, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
  };

  // creators reopen any published version from the copy sealed to their own key (re-derived from a wallet signature)
  const [mine, setMine] = useState<string[]>([]);
  useEffect(() => { api<any[]>('/api/listings').then((ls) => setMine(ls.filter((l) => l.creator === acting).map((l) => l.ticker))).catch(() => setMine([])); }, [acting]);
  const reopen = async (ticker: string) => {
    try {
      const c = await api<{ envelope: SealedEnvelope; sealed_hash: string }>(`/api/vault/${ticker}/creator-copy`);
      const { secretKey } = creatorKeyFromSignature(demoWalletSign(acting, creatorKeyMessage(acting)));
      const r = open<Recipe>(c.envelope, secretKey);
      setRecipe(r); setSel(null); setFormPos({ x: -260, y: 110 }); setTimeout(() => rf.fitView({ padding: 0.08 }), 120);
      toast(`Reopened ${ticker} (version ${c.sealed_hash.slice(0, 8)}…) from your own sealed copy`);
    } catch (e) { toast('Could not reopen: ' + (e as Error).message, true); }
  };
  const loadTemplate = (t: string) => { const r = structuredClone(TEMPLATES[t]); r.meta.creator = acting; setRecipe(r); setSel(null); setFormPos({ x: -260, y: 110 }); setTimeout(() => rf.fitView({ padding: 0.08 }), 120); };

  // ---------- story step 1: build CLNP live, then seal ----------
  useEffect(() => {
    if (story.step !== 1 || storyRan.current || !catalog) return;
    storyRan.current = true;
    (async () => {
      const listings = await api<any[]>('/api/listings');
      if (listings.some((l) => l.ticker === 'CLNP')) { toast('CLNP is already published, continuing with the buyer'); setTimeout(story.next, 1500); return; }
      const t = structuredClone(TEMPLATES.CLNP); t.meta.creator = 'chef.testnet';
      setRecipe({ ...t, nodes: [], output: '' });
      setTimeout(() => rf.fitView({ padding: 0.2 }), 30);
      for (let i = 0; i < t.nodes.length; i++) {
        await new Promise((r) => setTimeout(r, 650));
        setRecipe((r) => ({ ...r, nodes: t.nodes.slice(0, i + 1), output: i === t.nodes.length - 1 ? t.output : '' }));
        setSel(t.nodes[i].id);
        setTimeout(() => rf.fitView({ padding: 0.08, duration: 300 }), 80);
      }
      setFormPos({ x: -260, y: 110 });
      await new Promise((r) => setTimeout(r, 1400));
      setSel('shield');
      await new Promise((r) => setTimeout(r, 1800));
      setSealing(true);
    })();
  }, [story.step, catalog]);

  const selNode = recipe.nodes.find((n) => n.id === sel);
  const selManifest = selNode ? manifests.get(selNode.part) : undefined;
  const swaps = selNode && catalog ? compatibleSwaps(recipe, selNode.id, catalog) : [];
  const fees = v?.partFees ?? 0n;
  const price = BigInt(recipe.listing.price_per_run || '0');
  const protocol = (price * PROTOCOL_BPS) / 10000n;
  const minOk = price >= fees + RUNNER_FEE + protocol;
  const canPublish = !!v?.ok && minOk && /^[A-Z0-9]{3,6}$/.test(recipe.meta.ticker);

  const setMeta = (k: keyof Recipe['meta'], val: string) => setRecipe((r) => ({ ...r, meta: { ...r.meta, [k]: val } }));
  const setListing = (k: keyof Recipe['listing'], val: string | number) => setRecipe((r) => ({ ...r, listing: { ...r.listing, [k]: val } }));
  const setParam = (k: string, val: unknown) => setRecipe((r) => ({ ...r, nodes: r.nodes.map((n) => (n.id === sel ? { ...n, params: { ...n.params, [k]: val } } : n)) }));

  return (
    <div className="grid composer">
      <aside className="panel palette" aria-label="Part palette">
        <header><h2>Parts</h2><span className="small muted">drag onto the canvas</span></header>
        {CAT_ORDER.map((c) => (
          <div key={c}>
            <div className="cat">{CAT_LABEL[c]}</div>
            {(catalog?.parts ?? []).filter((b) => b.category === c).map((b) => (
              <div key={b.id} className="item" draggable onDragStart={(e) => e.dataTransfer.setData('application/frs-part', b.id)} onDoubleClick={() => addPart(b)} title={b.summary} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && addPart(b)}>
                <b>{b.name}</b><span>{b.author} · {usd(b.fee_per_call, 2)} per call</span>
              </div>
            ))}
          </div>
        ))}
        <div style={{ padding: 10 }}><OpenDemand /></div>
      </aside>

      <section className="panel canvas" onDragOver={(e) => e.preventDefault()} onDrop={onDrop} aria-label="Recipe canvas">
        <div className="row" style={{ position: 'absolute', top: 10, left: 10, zIndex: 5, gap: 6 }}>
          <button className="btn ghost sm" onClick={() => loadTemplate('CLNP')}>Load “Clean up and protect”</button>
          <button className="btn ghost sm" onClick={() => loadTemplate('SWPR')}>Load “Dust sweeper”</button>
          <button className="btn ghost sm" onClick={() => { setRecipe(blank()); setSel(null); }}>Clear</button>
          {mine.length > 0 && <select className="sm" aria-label="Reopen one of your published recipes" value="" onChange={(e) => e.target.value && reopen(e.target.value)}>
            <option value="">Reopen my published recipe…</option>{mine.map((t) => <option key={t} value={t}>{t}</option>)}</select>}
        </div>
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onPaneClick={() => setSel(null)} fitView minZoom={0.3} proOptions={{ hideAttribution: true }}>
          <Background gap={22} color="#d7dde6" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </section>

      <aside className="grid" style={{ alignContent: 'start', overflow: 'auto' }}>
        {sel === 'form' ? <FormInspector recipe={recipe} setRecipe={setRecipe} types={Object.keys(catalog?.types ?? {})} /> : selNode && selManifest ? (
          <div className="panel">
            <header><h2>{selManifest.name}</h2><span className="small muted">node “{selNode.id}”</span></header>
            <div className="body grid" style={{ gap: 10 }}>
              <div className="small muted">{selManifest.summary}</div>
              <div className="small">Can reach: {selManifest.capabilities.length ? selManifest.capabilities.join(', ') : 'nothing (pure)'}</div>
              {selManifest.disclosure && <Disclosure m={selManifest} />}
              {Object.entries(selManifest.params).map(([k, s]) => (
                <div className="field" key={k}>
                  <label htmlFor={'p-' + k}>{k} {s.secret && <span className="pill sealed">sealed</span>}</label>
                  {k === 'policy' ? <textarea id={'p-' + k} value={String(selNode.params[k] ?? '')} onChange={(e) => setParam(k, e.target.value)} /> :
                    <input id={'p-' + k} value={Array.isArray(selNode.params[k]) ? (selNode.params[k] as string[]).join(',') : String(selNode.params[k] ?? '')} onChange={(e) => setParam(k, s.type === 'number' ? Number(e.target.value) : s.type === 'string[]' ? e.target.value.split(',').map((x) => x.trim()).filter(Boolean) : e.target.value)} />}
                </div>
              ))}
              {swaps.length > 0 && <div className="grid" style={{ gap: 6 }}>
                <div className="small muted">Drop-in replacements (same ports, type-checked)</div>
                {swaps.map((b) => (
                  <div className="swap-opt" key={b.id}>
                    <div className="row between"><b className="small">{b.name} <RiskPill risk={withdrawalRisk(b.disclosure)} /></b><span className="small">{usd(b.fee_per_call, 2)} vs {usd(selManifest.fee_per_call, 2)}</span></div>
                    <div className="small muted">{b.summary}</div>
                    <button className="btn ghost sm" onClick={() => catalog && setRecipe(swapPart(recipe, selNode.id, b.id, catalog))}>Swap in</button>
                  </div>
                ))}
              </div>}
              <label className="row small"><input type="radio" checked={recipe.output.startsWith(selNode.id + '.')} onChange={() => setRecipe((r) => ({ ...r, output: `${selNode.id}.${Object.keys(selManifest.outputs)[0]}` }))} /> This part's output is the recipe result</label>
            </div>
          </div>
        ) : (
          <div className="panel"><div className="body small muted">Select a part to edit its parameters or swap it for a compatible one. Select “Buyer form” to edit the fields buyers fill in.</div></div>
        )}

        <div className="panel">
          <header><h2>Listing</h2></header>
          <div className="body grid" style={{ gap: 8, gridTemplateColumns: '1fr 1fr' }}>
            <div className="field"><label htmlFor="tk">Ticker</label><input id="tk" value={recipe.meta.ticker} onChange={(e) => setMeta('ticker', e.target.value.toUpperCase())} maxLength={6} /></div>
            <div className="field"><label htmlFor="pr">Price per run (USDC)</label><input id="pr" value={Number(recipe.listing.price_per_run) / 1e6} onChange={(e) => setListing('price_per_run', String(Math.round(Number(e.target.value) * 1e6)))} inputMode="decimal" /></div>
            <div className="field" style={{ gridColumn: '1 / 3' }}><label htmlFor="nm">Name</label><input id="nm" value={recipe.meta.name} onChange={(e) => setMeta('name', e.target.value)} /></div>
            <div className="field"><label htmlFor="ry">Creator royalty %</label><input id="ry" value={recipe.listing.royalty_bps / 100} onChange={(e) => setListing('royalty_bps', Math.round(Number(e.target.value) * 100))} /></div>
            <div className="field"><label htmlFor="sh">Shares</label><input id="sh" value={recipe.listing.total_shares} onChange={(e) => setListing('total_shares', e.target.value.replace(/\D/g, ''))} /></div>
            <div className="field"><label htmlFor="ip">IPO price per share</label><input id="ip" value={ipo.price} onChange={(e) => setIpo({ ...ipo, price: Number(e.target.value) })} /></div>
            <div className="field"><label htmlFor="fl">Float offered %</label><input id="fl" value={ipo.float_pct} onChange={(e) => setIpo({ ...ipo, float_pct: Number(e.target.value) })} /></div>
            <div className="field" style={{ gridColumn: '1 / 3' }}><label htmlFor="jb">Competes for job</label>
              <select id="jb" value={recipe.implements ?? ''} onChange={(e) => setRecipe((r) => ({ ...r, implements: e.target.value || undefined }))}>
                <option value="">none (direct runs only)</option>
                {(catalog?.jobs ?? []).map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
              </select></div>
            <div className="field" style={{ gridColumn: '1 / 3' }}><label htmlFor="bd">Bond backing your quotes (USDC)</label><input id="bd" value={Number(recipe.listing.bond ?? '0') / 1e6} onChange={(e) => setListing('bond', String(Math.round(Number(e.target.value) * 1e6)))} inputMode="decimal" /></div>
            <div className="small muted" style={{ gridColumn: '1 / 3' }}>Shares are optional funding: sell part of the recipe's future run revenue in batch auctions. The bond pays buyers if a run delivers less than its signed quote.</div>
          </div>
        </div>

        <div className="panel">
          <header><h2>Checks</h2>{v && <span className={'pill ' + (v.ok && minOk ? 'ok' : 'bad')}>{v.ok && minOk ? 'ready to publish' : 'needs fixes'}</span>}{v && <RiskPill risk={v.risk} label />}</header>
          <div className="body">
            {v?.diagnostics.map((d, i) => <div key={i} className={'diag ' + d.severity}>{d.node ? `${d.node}: ` : ''}{d.message}</div>)}
            {!minOk && <div className="diag error">Price per run must cover fees: at least {usd(fees + RUNNER_FEE + protocol)}</div>}
            <dl className="kv" style={{ marginTop: 8 }}>
              <dt>Part fees</dt><dd>{usd(fees)}</dd>
              <dt>TEE runner</dt><dd>{usd(RUNNER_FEE)}</dd>
              <dt>Protocol (2%)</dt><dd>{usd(protocol)}</dd>
              <dt>Left for you and shareholders</dt><dd>{usd(price - fees - RUNNER_FEE - protocol > 0n ? price - fees - RUNNER_FEE - protocol : 0n)}</dd>
            </dl>
            <button className="btn seal" style={{ width: '100%', marginTop: 12 }} disabled={!canPublish} onClick={() => setSealing(true)}>Seal and publish as {recipe.meta.creator}</button>
          </div>
        </div>
      </aside>

      {sealing && catalog && <SealModal recipe={{ ...recipe, meta: { ...recipe.meta, creator: story.step === 1 ? 'chef.testnet' : acting } }} catalog={catalog} ipo={ipo} auto={story.step === 1}
        onClose={(published) => { setSealing(false); if (published && story.step === 1) setTimeout(story.next, 600); else if (published) go('exchange', recipe.meta.ticker); }} />}
    </div>
  );
}

function FormInspector({ recipe, setRecipe, types }: { recipe: Recipe; setRecipe: (f: (r: Recipe) => Recipe) => void; types: string[] }) {
  const [id, setId] = useState(''); const [label, setLabel] = useState(''); const [type, setType] = useState('near.account');
  return (
    <div className="panel">
      <header><h2>Buyer form</h2><span className="small muted">FRS-1 recommends six fields or fewer</span></header>
      <div className="body grid" style={{ gap: 8 }}>
        {recipe.form.map((f) => (
          <div key={f.id} className="row between small"><span><b>{f.label}</b> <span className="muted">{f.id}: {f.type}</span></span>
            <button className="btn ghost sm" onClick={() => setRecipe((r) => ({ ...r, form: r.form.filter((x) => x.id !== f.id) }))}>Remove</button></div>
        ))}
        <div className="field"><label htmlFor="fid">Field id</label><input id="fid" value={id} onChange={(e) => setId(e.target.value.replace(/[^a-z_]/g, ''))} /></div>
        <div className="field"><label htmlFor="flb">Label</label><input id="flb" value={label} onChange={(e) => setLabel(e.target.value)} /></div>
        <div className="field"><label htmlFor="fty">Type</label><select id="fty" value={type} onChange={(e) => setType(e.target.value)}>{types.map((t) => <option key={t}>{t}</option>)}</select></div>
        <button className="btn ghost sm" disabled={!id || !label} onClick={() => { setRecipe((r) => ({ ...r, form: [...r.form, { id, label, type, required: true, ...(type === 'address.near' ? { generator: 'fresh-implicit' as const } : {}) }] })); setId(''); setLabel(''); }}>Add field</button>
      </div>
    </div>
  );
}

function RiskPill({ risk, label }: { risk: 'low' | 'medium' | 'high'; label?: boolean }) {
  return <span className={'pill ' + (risk === 'low' ? 'ok' : risk === 'high' ? 'bad' : 'warn')} title="Withdrawal risk: can this be rebuilt if its supplier disappears? Open-weights or bundled code: low. Remote services: medium. Closed models or closed harnesses: high.">{label ? `${risk} withdrawal risk` : risk}</span>;
}

function Disclosure({ m }: { m: PartManifest }) {
  const d = m.disclosure, l = m.limits;
  return (
    <div className="swap-opt">
      <div className="row between"><b className="small">Disclosure</b><RiskPill risk={withdrawalRisk(d)} label /></div>
      <dl className="disc">
        <dt>Model</dt><dd>{d.model.kind === 'none' ? 'none (code)' : `${d.model.kind}${d.model.name ? ': ' + d.model.name : ''}`}</dd>
        <dt>Instructions</dt><dd>{d.instructions}</dd>
        <dt>Harness</dt><dd>{d.harness}</dd>
        <dt>Verification</dt><dd>{d.verification}</dd>
        <dt>Runs</dt><dd>{d.runtime === 'bundled' ? 'bundled in the attested runner (pinned by hash)' : 'remote, operated by the supplier'}</dd>
        {l && <><dt>Limits</dt><dd>{(l.max_ms / 1000).toFixed(0)} s, {l.max_http_calls} HTTP{l.max_model_calls ? `, ${l.max_model_calls} model` : ''} calls, {(l.max_output_bytes / 1000).toFixed(0)} kB out</dd></>}
      </dl>
    </div>
  );
}

export function OpenDemand() {
  const [d] = usePoll<{ job_type: string; at: string }[]>('/api/demand', 5000);
  if (!d?.length) return null;
  const counts = d.reduce<Record<string, number>>((m, x) => ({ ...m, [x.job_type]: (m[x.job_type] ?? 0) + 1 }), {});
  return (
    <div className="panel">
      <header><h2>Open demand</h2><span className="small muted">jobs nobody serves yet</span></header>
      <div className="body small">{Object.entries(counts).map(([k, n]) => <div key={k}>{k}: {n} request{n > 1 ? 's' : ''}</div>)}</div>
    </div>
  );
}
