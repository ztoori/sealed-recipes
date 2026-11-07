import { useCallback, useEffect, useMemo, useState } from 'react';
import { ReactFlow, Background, Controls, Handle, Position, applyNodeChanges, type Connection, type Edge, type Node, type NodeChange, type NodeProps, type EdgeChange, ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { compatibleSwaps, swapPart, validateRecipe, withdrawalRisk, isAssignable, type PartManifest, type Catalog, type Recipe, type FormField, type Diagnostic, type JobType } from '../../../core/src/srs';
import { addPartAutoWired, recipeFromJob, sourcesFor, suggestNext } from '../../../core/src/partkit';
import { ASSET_LABEL, usd, usePoll } from '../api';
import { useApp, useStoryOnce } from '../App';
import { SealModal } from '../components/SealModal';
import CLNP from '../../../seed/recipes/CLNP.json';

/**
 * Compose › Recipe: a no-code builder. 1) pick the job the recipe will compete for (that fixes the buyer form),
 * 2) add parts: each one wires itself to the previous step's matching output, and every wire can be changed from a
 * plain list, 3) name it, price it, seal it. Recipes are private, so nothing here loads anyone else's recipe.
 */
const RUNNER_FEE = 30000n;
const PROTOCOL_BPS = 200n;
const CAT_ORDER = ['source', 'guard', 'transform', 'action', 'sink'] as const;
const CAT_LABEL: Record<string, [string, string]> = {
  source: ['Read', 'fetch data: balances, keys, stakes, contracts'],
  guard: ['Check', 'judge or filter: scam tokens, risky keys, contracts'],
  transform: ['Decide', 'pick what to act on: dust, excess, timing'],
  action: ['Act', 'do it, with the buyer’s wallet approval'],
  sink: ['Report', 'turn results into a readable report'],
};
const CREATOR_COPY_OF_CLNP = CLNP as unknown as Recipe; // the story's creator composing her own recipe, step by step

type PartData = { manifest: PartManifest; errors: number; isResult: boolean };
function PartNode({ data, selected }: NodeProps<Node<PartData>>) {
  const m = data.manifest;
  return (
    <div className={'fnode' + (selected ? ' selected' : '') + (data.errors ? ' err' : '') + (data.isResult ? ' result' : '')}>
      <div className="hd"><span className={'cat cat-' + m.category}>{CAT_LABEL[m.category][0]}</span><b>{m.name}</b><span>{m.author} · {usd(m.fee_per_call, 2)}</span></div>
      <div className="ports">
        <div>{Object.entries(m.inputs).map(([p, s]) => (<div key={p} className="port"><Handle type="target" position={Position.Left} id={p} style={{ left: -6 }} />{p}<i>{s.type}</i></div>))}</div>
        <div>{Object.entries(m.outputs).map(([p, s]) => (<div key={p} className="port out"><Handle type="source" position={Position.Right} id={p} style={{ right: -6 }} />{p}<i>{s.type}</i></div>))}</div>
      </div>
      {data.isResult && <div className="resulttag">recipe result</div>}
    </div>
  );
}
function FormNode({ data, selected }: NodeProps<Node<{ fields: FormField[]; consts: [string, { type: string; value: unknown }][] }>>) {
  return (
    <div className={'fnode form' + (selected ? ' selected' : '')}>
      <div className="hd"><b>Buyer’s form</b><span>filled in once per job</span></div>
      <div className="ports" style={{ gridTemplateColumns: '1fr' }}>
        {data.fields.map((f) => (<div key={f.id} className="port out"><Handle type="source" position={Position.Right} id={f.id} style={{ right: -6 }} />{f.label}<i>{f.type}</i></div>))}
        {data.consts.map(([k, c]) => (<div key={'c' + k} className="port out"><Handle type="source" position={Position.Right} id={'const:' + k} style={{ right: -6 }} />fixed: {ASSET_LABEL[String(c.value)] ?? String(c.value)}<i>{c.type}</i></div>))}
        {!data.fields.length && <div className="port muted">Pick a job first</div>}
      </div>
    </div>
  );
}
const nodeTypes = { part: PartNode, form: FormNode };

/** Diagnostics in the words a no-code builder needs. */
function friendly(d: Diagnostic, name: (id?: string) => string): string {
  switch (d.code) {
    case 'port.unwired': return `${name(d.node)}: “${d.port}” has no value yet. Select the part and choose where it comes from.`;
    case 'recipe.output': return 'Choose which part’s output is the recipe’s result (select the last part, then “Use as the result”).';
    case 'recipe.empty': return 'Add at least one part.';
    case 'meta.ticker': return 'Give it a short code: 3 to 6 capital letters or digits.';
    case 'meta.name': return 'Give it a name buyers will understand.';
    case 'job.output': return `The result must be what the job promises: ${d.message.split('expects output ')[1]?.split(',')[0] ?? 'see the job'}.`;
    case 'node.deadend': return `${name(d.node)}: nothing uses its output, but you would still pay its fee. Connect it or remove it.`;
    case 'form.unused': return `The buyer’s “${d.message.match(/"([^"]+)"/)?.[1]}” is not used by any part yet.`;
    default: return (d.node ? `${name(d.node)}: ` : '') + d.message;
  }
}

export function ComposeRecipe() { return <ReactFlowProvider><Builder /></ReactFlowProvider>; }

/** the draft survives leaving the page (e.g. to read how a part works) for the rest of the visit */
let savedDraft: Recipe | null = null;

function Builder() {
  const { story, toast, go, acting } = useApp();
  const once = useStoryOnce();
  const [cat] = usePoll<Catalog & { onchain: Record<string, unknown> }>('/api/catalog', 60000);
  const [listings] = usePoll<any[]>('/api/listings', 5000);
  const catalog = cat as Catalog | undefined;
  const jobs = catalog?.jobs ?? [];
  const [recipe, setRecipe] = useState<Recipe | null>(() => savedDraft);
  useEffect(() => { savedDraft = recipe; }, [recipe]);
  const job = jobs.find((j) => j.id === recipe?.implements);
  const [sel, setSel] = useState<string | null>(null);
  const [sealing, setSealing] = useState(false);
  const [find, setFind] = useState('');
  const [dims, setDims] = useState<Record<string, { width: number; height: number }>>({});
  const [formPos, setFormPos] = useState({ x: -280, y: 80 });
  const rf = useReactFlow();
  const manifests = useMemo(() => new Map((catalog?.parts ?? []).map((b) => [b.id, b])), [catalog]);
  const v = useMemo(() => (catalog && recipe ? validateRecipe(recipe, catalog) : null), [recipe, catalog]);
  const nodeName = (id?: string) => manifests.get(recipe?.nodes.find((n) => n.id === id)?.part ?? '')?.name ?? id ?? '';
  const fit = (ms = 120) => setTimeout(() => rf.fitView({ padding: 0.12, duration: 250 }), ms);

  const startJob = (j: JobType) => {
    setRecipe((r) => (r && r.nodes.length && !confirm('Start over for a different job? The parts you added will be removed.') ? r : recipeFromJob(j, acting)));
    setSel(null); fit();
  };
  useEffect(() => { setRecipe((r) => (r ? { ...r, meta: { ...r.meta, creator: acting } } : r)); }, [acting]);

  /** add a part: wired automatically, placed after the step it reads from */
  const add = (partId: string, at?: { x: number; y: number }) => {
    if (!recipe || !catalog) return;
    const a = addPartAutoWired(recipe, partId, catalog, job);
    const n = a.recipe.nodes.find((x) => x.id === a.nodeId)!;
    const fromNodes = Object.values(n.inputs).map((ref) => recipe.nodes.find((x) => x.id === ref.split('.')[0])).filter(Boolean) as typeof recipe.nodes;
    const x = at?.x ?? (fromNodes.length ? Math.max(...fromNodes.map((f) => f.ui?.x ?? 0)) + 270 : 0);
    let y = at?.y ?? (fromNodes[0]?.ui?.y ?? 80);
    while (!at && recipe.nodes.some((o) => Math.abs((o.ui?.x ?? 0) - x) < 200 && Math.abs((o.ui?.y ?? 0) - y) < 150)) y += 170;
    setRecipe({ ...a.recipe, nodes: a.recipe.nodes.map((o) => (o.id === a.nodeId ? { ...o, ui: { x, y } } : o)) });
    setSel(a.nodeId);
    if (a.unwired.length) toast(`${manifests.get(partId)?.name}: choose where ${a.unwired.map((p) => `“${p}”`).join(', ')} comes from`);
    fit(80);
  };
  const remove = (id: string) => setRecipe((r) => r && ({ ...r, output: r.output.startsWith(id + '.') ? '' : r.output, nodes: r.nodes.filter((n) => n.id !== id).map((n) => ({ ...n, inputs: Object.fromEntries(Object.entries(n.inputs).filter(([, ref]) => !ref.startsWith(id + '.'))) })) }));

  // ---------- recipe <-> flow ----------
  const nodes: Node[] = useMemo(() => !recipe ? [] : [
    { id: 'form', type: 'form', position: formPos, measured: dims.form, data: { fields: recipe.form, consts: Object.entries(recipe.consts ?? {}) }, selected: false, deletable: false, selectable: false },
    ...recipe.nodes.filter((n) => manifests.has(n.part)).map((n) => ({ id: n.id, type: 'part', position: n.ui ?? { x: 0, y: 0 }, measured: dims[n.id], selected: sel === n.id, data: { manifest: manifests.get(n.part)!, errors: v?.diagnostics.filter((d) => d.node === n.id && d.severity === 'error').length ?? 0, isResult: recipe.output.startsWith(n.id + '.') } })),
  ], [recipe, manifests, sel, v, formPos, dims]);
  const edges: Edge[] = useMemo(() => !recipe ? [] : recipe.nodes.flatMap((n) => Object.entries(n.inputs).map(([port, ref]) => {
    const [src, ...rest] = ref.split('.'); const p = rest.join('.');
    const bad = v?.diagnostics.some((d) => d.node === n.id && d.port === port && d.severity === 'error');
    return { id: `${n.id}:${port}`, source: src === 'const' || src === 'form' ? 'form' : src, sourceHandle: src === 'const' ? 'const:' + p : p, target: n.id, targetHandle: port, animated: story.step === 1, style: { stroke: bad ? '#b8364a' : '#15233f', strokeWidth: 1.5 } } as Edge;
  })), [recipe, v, story.step]);
  const onNodesChange = useCallback((ch: NodeChange[]) => {
    const dimCh = ch.filter((c) => c.type === 'dimensions' && (c as { dimensions?: unknown }).dimensions) as { id: string; dimensions: { width: number; height: number } }[];
    if (dimCh.length) setDims((d) => { const n = { ...d }; for (const c of dimCh) n[c.id] = c.dimensions; return n; });
    if (ch.every((c) => c.type === 'dimensions')) return;
    const moved = applyNodeChanges(ch, nodes);
    const fp = moved.find((n) => n.id === 'form'); if (fp) setFormPos(fp.position);
    for (const c of ch) { if (c.type === 'remove') remove((c as { id: string }).id); if (c.type === 'select' && c.selected) setSel(c.id); }
    setRecipe((r) => r && ({ ...r, nodes: r.nodes.map((n) => { const mv = moved.find((x) => x.id === n.id); return mv ? { ...n, ui: { x: Math.round(mv.position.x), y: Math.round(mv.position.y) } } : n; }) }));
  }, [nodes]);
  const onEdgesChange = useCallback((ch: EdgeChange[]) => {
    const rm = ch.filter((c) => c.type === 'remove').map((c) => (c as { id: string }).id);
    if (rm.length) setRecipe((r) => r && ({ ...r, nodes: r.nodes.map((n) => ({ ...n, inputs: Object.fromEntries(Object.entries(n.inputs).filter(([p]) => !rm.includes(`${n.id}:${p}`))) })) }));
  }, []);
  const wire = (nodeId: string, port: string, ref: string) => setRecipe((r) => r && ({ ...r, nodes: r.nodes.map((n) => (n.id === nodeId ? { ...n, inputs: { ...n.inputs, [port]: ref } } : n)) }));
  const onConnect = useCallback((c: Connection) => {
    if (!c.target || !c.targetHandle || !c.sourceHandle) return;
    wire(c.target, c.targetHandle, c.source === 'form' ? (c.sourceHandle.startsWith('const:') ? 'const.' + c.sourceHandle.slice(6) : 'form.' + c.sourceHandle) : `${c.source}.${c.sourceHandle}`);
  }, []);
  const onDrop = (e: React.DragEvent) => { e.preventDefault(); const id = e.dataTransfer.getData('application/srs-part'); if (manifests.has(id)) add(id, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })); };

  // ---------- story step 1: the creator composes CLNP by adding its parts one by one, then seals it ----------
  useEffect(() => {
    if (story.step !== 1 || !catalog || !listings || !once('compose')) return;
    if (listings.some((l) => l.ticker === 'CLNP')) { toast('CLNP is already published: on to the buyer'); setTimeout(() => story.advance(1), 1500); return; }
    (async () => {
      const t = structuredClone(CREATOR_COPY_OF_CLNP);
      const jb = catalog.jobs!.find((j) => j.id === t.implements)!;
      let r: Recipe = { ...recipeFromJob(jb, 'chef.testnet'), meta: { ...t.meta, creator: 'chef.testnet' }, listing: t.listing };
      setRecipe(r); setSel(null); fit(30);
      for (const n of t.nodes) {
        await new Promise((ok) => setTimeout(ok, 700));
        const a = addPartAutoWired(r, n.part, catalog, jb);
        // her private settings for this step (the prompt, thresholds, routing): sealed when she publishes
        r = { ...a.recipe, nodes: a.recipe.nodes.map((x) => (x.id === a.nodeId ? { ...x, params: n.params, ui: n.ui } : x)) };
        setRecipe(r); setSel(a.nodeId); fit(60);
      }
      await new Promise((ok) => setTimeout(ok, 1600));
      setSel(r.nodes.find((x) => x.part.startsWith('ai.spam-shield'))?.id ?? null);
      await new Promise((ok) => setTimeout(ok, 1800));
      setSealing(true);
    })();
  }, [story.step, story.run, !!catalog, !!listings]);

  if (!catalog) return <div className="panel body muted">Loading the part catalog…</div>;

  // ---------- step 1: choose the job ----------
  if (!recipe) {
    return (
      <div className="panel">
        <header><h2>1. What job will your recipe do?</h2><span className="small muted">Buyers ask for a job; every recipe that does it competes with a signed quote.</span></header>
        <div className="body jobgrid">
          {jobs.map((j) => {
            const n = (listings ?? []).filter((l) => l.implements === j.id).length;
            return (
              <button key={j.id} className="jobcard" onClick={() => startJob(j)}>
                <b>{j.name}</b>
                <span className="small muted">{j.description}</span>
                <span className="small">Buyers fill in: {Object.values(j.inputs).map((f: any) => f.label.replace(/\s*\(.*\)$/, '')).join(' · ')}</span>
                <span className="small muted">{n ? `${n} recipe${n > 1 ? 's' : ''} already compete` : 'no recipe yet: you would be the first'}</span>
              </button>
            );
          })}
        </div>
        <div className="body small muted" style={{ paddingTop: 0 }}>Need a job that is not here? Job types are part of the SRS-1 standard (see Documentation); until one exists, buyers can request it on Recipes and post a bounty.</div>
      </div>
    );
  }

  // ---------- steps 2-3: parts, then listing ----------
  const s = find.trim().toLowerCase();
  const visible = catalog.parts.filter((p) => !s || `${p.name} ${p.summary} ${p.id} ${p.author}`.toLowerCase().includes(s));
  const next = suggestNext(recipe, catalog, job).slice(0, 4);
  const done = !!recipe.output && !!v && !v.diagnostics.some((d) => d.severity === 'error' && d.code !== 'meta.ticker' && d.code !== 'meta.name');
  const selNode = recipe.nodes.find((n) => n.id === sel);
  const selM = selNode ? manifests.get(selNode.part) : undefined;
  const fees = v?.partFees ?? 0n;
  const price = BigInt(recipe.listing.price_per_run || '0');
  const band = recipe.listing.pricing;
  const floor = band ? BigInt(band.price_floor || '0') : price;
  const ceiling = band ? BigInt(band.price_ceiling || '0') : price;
  const floorNeed = fees + RUNNER_FEE + (floor * PROTOCOL_BPS) / 10000n;
  const protocol = (price * PROTOCOL_BPS) / 10000n;
  const left = price - fees - RUNNER_FEE - protocol > 0n ? price - fees - RUNNER_FEE - protocol : 0n;
  const bandOk = floor <= price && price <= ceiling && (!band || (band.target_runs >= 1 && band.target_runs <= 1_000_000));
  const taken = (listings ?? []).some((l) => l.ticker === recipe.meta.ticker);
  const errors = (v?.diagnostics ?? []).filter((d) => d.severity === 'error');
  const progress: [string, boolean][] = [
    [`Job: ${job?.name}`, !!job],
    ['Parts added', recipe.nodes.length > 0],
    ['Every input has a value', !errors.some((d) => d.code === 'port.unwired' || d.code === 'port.type' || d.code === 'port.ref')],
    ['A result that matches the job', !!recipe.output && !errors.some((d) => d.code === 'recipe.output' || d.code === 'job.output')],
    ['Short code and name', /^[A-Z0-9]{3,6}$/.test(recipe.meta.ticker) && !!recipe.meta.name && !taken],
    ['Price covers the fees', floor >= floorNeed && bandOk],
  ];
  const canPublish = !!v?.ok && progress.every(([, ok]) => ok);
  const setMeta = (k: keyof Recipe['meta'], val: string) => setRecipe((r) => r && ({ ...r, meta: { ...r.meta, [k]: val } }));
  const setListing = (k: keyof Recipe['listing'], val: string | number) => setRecipe((r) => r && ({ ...r, listing: { ...r.listing, [k]: val } }));
  const setBand = (k: 'price_floor' | 'price_ceiling' | 'target_runs', val: string | number) => setRecipe((r) => r && ({ ...r, listing: { ...r.listing, pricing: { ...(r.listing.pricing ?? { price_floor: r.listing.price_per_run, price_ceiling: r.listing.price_per_run, target_runs: 2 }), [k]: val } } }));
  const toUnits = (x: string) => String(Math.round(Number(x) * 1e6));
  const setParam = (k: string, val: unknown) => setRecipe((r) => r && ({ ...r, nodes: r.nodes.map((n) => (n.id === sel ? { ...n, params: { ...n.params, [k]: val } } : n)) }));

  const partItem = (b: PartManifest, hint?: string) => (
    <div key={b.id} className="item" draggable onDragStart={(e) => e.dataTransfer.setData('application/srs-part', b.id)} title={b.summary}>
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}><b>{b.name}</b><span>{b.author} · {usd(b.fee_per_call, 2)} per run{hint ? ` · ${hint}` : ''}</span></div>
        <button className="btn sm" onClick={() => add(b.id)} aria-label={`Add ${b.name}`}>Add</button>
      </div>
      <div className="sum">{b.summary}</div>
    </div>
  );

  return (
    <div className="grid composer">
      <aside className="panel palette" aria-label="Parts">
        <header><h2>2. Add parts</h2><span className="small muted">they connect themselves</span></header>
        <div className="body" style={{ paddingBottom: 4 }}>
          <div className="small"><span className="muted">Job:</span> <b>{job?.name}</b> <button className="linkbtn" onClick={() => { if (!recipe.nodes.length || confirm('Start over with a different job?')) { setRecipe(null); setSel(null); } }}>change</button></div>
          <input className="search" type="search" placeholder="Search parts" value={find} onChange={(e) => setFind(e.target.value)} aria-label="Search parts" style={{ marginTop: 8 }} />
        </div>
        {!s && done && <div className="body small gain" style={{ paddingTop: 4, paddingBottom: 4 }}>Your recipe already produces what the job promises. Add more parts only if they improve the result, or go to step 3.</div>}
        {!s && !done && next.length > 0 && <><div className="cat">Suggested next</div>{next.map((b) => partItem(b, CAT_LABEL[b.category][0].toLowerCase()))}</>}
        {CAT_ORDER.map((c) => {
          const items = visible.filter((b) => b.category === c);
          return items.length ? <div key={c}><div className="cat">{CAT_LABEL[c][0]} <span className="muted">· {CAT_LABEL[c][1]}</span></div>{items.map((b) => partItem(b))}</div> : null;
        })}
      </aside>

      <section className="panel canvas" onDragOver={(e) => e.preventDefault()} onDrop={onDrop} aria-label="Recipe canvas">
        <div className="canvas-bar">
          <span className="small muted">{recipe.nodes.length ? 'Drag parts to rearrange · drag from an output to an input to rewire · select a part to edit it' : 'Start with a “Read” part: it fetches what the job is about.'}</span>
          <span className="spacer" />
          {recipe.nodes.length > 0 && <button className="btn ghost sm" onClick={() => { const last = recipe.nodes.at(-1)!; remove(last.id); setSel(null); }}>Remove last part</button>}
          {recipe.nodes.length > 0 && <button className="btn ghost sm" onClick={() => { if (confirm('Remove every part and start this job again?')) { setRecipe(recipeFromJob(job!, acting)); setSel(null); } }}>Start over</button>}
        </div>
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onPaneClick={() => setSel(null)} fitView minZoom={0.3} proOptions={{ hideAttribution: true }}>
          <Background gap={22} color="#d7dde6" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </section>

      <aside className="grid" style={{ alignContent: 'start', overflow: 'auto', minWidth: 0 }}>
        {selNode && selM && (
          <div className="panel">
            <header><h2>{selM.name}</h2><span className="small muted">{CAT_LABEL[selM.category][0]} · {usd(selM.fee_per_call, 2)} to {selM.author}</span></header>
            <div className="body grid" style={{ gap: 10 }}>
              <div className="small muted">{selM.summary} <button className="linkbtn" onClick={() => go({ page: 'compose', sub: 'part', part: selM.id })}>How it works</button></div>
              <div className="row wrap small" style={{ gap: 6 }}><RiskPill risk={withdrawalRisk(selM.disclosure)} label />{selM.capabilities.includes('wallet:approve') && <span className="pill">asks the buyer to sign</span>}</div>
              <InputsEditor recipe={recipe} nodeId={selNode.id} m={selM} catalog={catalog} wire={wire} setRecipe={setRecipe as never} />
              {Object.keys(selM.params).length > 0 && <div className="grid" style={{ gap: 8 }}>
                <div className="sectlabel">Your settings <span className="muted">· sealed: only the runner sees them</span></div>
                {Object.entries(selM.params).map(([k, ps]) => (
                  <div className="field" key={k}>
                    <label htmlFor={'p-' + k}>{k.replace(/_/g, ' ')}{ps.description ? ` · ${ps.description}` : ''}</label>
                    {ps.type === 'string' && (k === 'policy' || String(selNode.params[k] ?? '').length > 40)
                      ? <textarea id={'p-' + k} value={String(selNode.params[k] ?? '')} onChange={(e) => setParam(k, e.target.value)} placeholder="Your instructions: part of your edge, sealed" />
                      : <input id={'p-' + k} value={Array.isArray(selNode.params[k]) ? (selNode.params[k] as string[]).join(', ') : String(selNode.params[k] ?? '')} placeholder={ps.type === 'string[]' ? 'comma, separated, values' : ''}
                        onChange={(e) => setParam(k, ps.type === 'number' ? Number(e.target.value) : ps.type === 'string[]' ? e.target.value.split(',').map((x) => x.trim()).filter(Boolean) : e.target.value)} />}
                  </div>
                ))}
              </div>}
              {job && Object.entries(selM.outputs).some(([, o]) => isAssignable(catalog.types, o.type, job.output)) && (
                <label className="row small"><input type="checkbox" checked={recipe.output.startsWith(selNode.id + '.')} onChange={(e) => { const port = Object.entries(selM.outputs).find(([, o]) => isAssignable(catalog.types, o.type, job.output))![0]; setRecipe((r) => r && ({ ...r, output: e.target.checked ? `${selNode.id}.${port}` : '' })); }} /> Use as the recipe’s result (what the buyer gets)</label>
              )}
              <SwapList recipe={recipe} nodeId={selNode.id} current={selM} catalog={catalog} onSwap={(id) => setRecipe(swapPart(recipe, selNode.id, id, catalog))} />
              <button className="btn ghost sm" onClick={() => { remove(selNode.id); setSel(null); }}>Remove this part</button>
            </div>
          </div>
        )}

        <div className="panel">
          <header><h2>3. Name, price and publish</h2></header>
          <div className="body grid" style={{ gap: 8, gridTemplateColumns: '1fr 1fr' }}>
            <div className="field" style={{ gridColumn: '1 / 3' }}><label htmlFor="nm">Name buyers will see</label><input id="nm" value={recipe.meta.name} onChange={(e) => setMeta('name', e.target.value)} placeholder="e.g. Clean up and protect" /></div>
            <div className="field"><label htmlFor="tk">Short code</label><input id="tk" value={recipe.meta.ticker} onChange={(e) => setMeta('ticker', e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} maxLength={6} placeholder="ABCD" />{taken && <span className="small loss">taken</span>}</div>
            <div className="field"><label htmlFor="pr">Starting price (USDC)</label><input id="pr" value={Number(recipe.listing.price_per_run) / 1e6} onChange={(e) => setListing('price_per_run', toUnits(e.target.value))} inputMode="decimal" /></div>
            <div className="field" style={{ gridColumn: '1 / 3' }}><label htmlFor="ds">One-line description</label><input id="ds" value={recipe.meta.description} onChange={(e) => setMeta('description', e.target.value)} placeholder="What the buyer gets, in their words" /></div>
            <details style={{ gridColumn: '1 / 3' }} className="small">
              <summary>Market price band, guarantee deposit</summary>
              <div className="grid" style={{ gap: 8, gridTemplateColumns: '1fr 1fr', marginTop: 8 }}>
                <label className="small" style={{ gridColumn: '1 / 3', display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="checkbox" checked={!!band} onChange={(e) => setRecipe((r) => r && ({ ...r, listing: { ...r.listing, pricing: e.target.checked ? { price_floor: String((BigInt(r.listing.price_per_run || '0') * 6n) / 10n), price_ceiling: String(BigInt(r.listing.price_per_run || '0') * 2n), target_runs: 2 } : undefined } }))} />
                  Price follows demand inside a band</label>
                {band && <>
                  <div className="field"><label htmlFor="pf">Floor (USDC)</label><input id="pf" value={Number(band.price_floor) / 1e6} onChange={(e) => setBand('price_floor', toUnits(e.target.value))} inputMode="decimal" /></div>
                  <div className="field"><label htmlFor="pc">Ceiling (USDC)</label><input id="pc" value={Number(band.price_ceiling) / 1e6} onChange={(e) => setBand('price_ceiling', toUnits(e.target.value))} inputMode="decimal" /></div>
                  <div className="field" style={{ gridColumn: '1 / 3' }}><label htmlFor="pt">Target paid runs per period</label><input id="pt" value={band.target_runs} onChange={(e) => setBand('target_runs', Math.max(0, Math.round(Number(e.target.value) || 0)))} inputMode="numeric" /></div>
                  <div className="muted" style={{ gridColumn: '1 / 3' }}>More paid runs than the target raise the price by up to 12.5% a period; fewer lower it. It never leaves the band. A quote locks the price.</div>
                </>}
                <div className="field"><label htmlFor="bd">Guarantee deposit (USDC)</label><input id="bd" value={Number(recipe.listing.bond ?? '0') / 1e6} onChange={(e) => setListing('bond', toUnits(e.target.value))} inputMode="decimal" /></div>
                <div className="field"><label htmlFor="rs">Keep in it (% of your cut)</label><input id="rs" value={(recipe.listing.reserve_bps ?? 0) / 100} onChange={(e) => setListing('reserve_bps', Math.max(0, Math.min(10000, Math.round(Number(e.target.value) * 100))))} inputMode="decimal" /></div>
                <div className="muted" style={{ gridColumn: '1 / 3' }}>Your collateral: a buyer is paid from it if a run delivers less than its signed quote promised. It earns nothing, and you can withdraw the free part at any time.</div>
              </div>
            </details>
          </div>
        </div>

        <div className="panel">
          <header><h2>Ready to publish?</h2>{v && <span className={'pill ' + (canPublish ? 'ok' : 'warn')}>{canPublish ? 'ready' : `${progress.filter(([, ok]) => !ok).length} to go`}</span>}{v && recipe.nodes.length > 0 && <RiskPill risk={v.risk} label />}</header>
          <div className="body">
            <ul className="progress">{progress.map(([label, ok]) => <li key={label} className={ok ? 'ok' : ''}><span>{ok ? '✓' : '○'}</span>{label}</li>)}</ul>
            {errors.length > 0 && <div style={{ marginTop: 6 }}>{errors.slice(0, 5).map((d, i) => <div key={i} className="diag error">{friendly(d, nodeName)}</div>)}</div>}
            {(v?.diagnostics ?? []).filter((d) => d.severity === 'warning').slice(0, 3).map((d, i) => <div key={'w' + i} className="diag warning">{friendly(d, nodeName)}</div>)}
            {floor < floorNeed && recipe.nodes.length > 0 && <div className="diag error">{band ? 'The floor' : 'The price'} must cover the fees: at least {usd(floorNeed)}.</div>}
            <dl className="kv" style={{ marginTop: 8 }}>
              <dt>Part fees</dt><dd>{usd(fees)}</dd>
              <dt>Sealed runner</dt><dd>{usd(RUNNER_FEE)}</dd>
              <dt>Protocol (2%)</dt><dd>{usd(protocol)}</dd>
              <dt>You earn per run</dt><dd>{usd(left)}</dd>
            </dl>
            <button className="btn seal" style={{ width: '100%', marginTop: 12 }} disabled={!canPublish} onClick={() => setSealing(true)}>Seal and publish as {recipe.meta.creator}</button>
            <div className="small muted" style={{ marginTop: 6 }}>Sealing encrypts the recipe in this browser to the attested runner. Nobody else, including this marketplace, can read your wiring or settings.</div>
          </div>
        </div>
      </aside>

      {sealing && <SealModal recipe={{ ...recipe, meta: { ...recipe.meta, creator: story.step === 1 ? 'chef.testnet' : acting } }} catalog={catalog} auto={story.step === 1}
        onClose={(published) => { setSealing(false); if (!published) return; const t = recipe.meta.ticker; setRecipe(null); setSel(null); if (story.step === 1) setTimeout(() => story.advance(1), 600); else go({ page: 'recipes', ticker: t }); }} />}
    </div>
  );
}

/** Where each input of the selected part comes from: any compatible earlier output, the buyer's form, or a fixed value. */
function InputsEditor({ recipe, nodeId, m, catalog, wire, setRecipe }: { recipe: Recipe; nodeId: string; m: PartManifest; catalog: Catalog; wire: (n: string, p: string, ref: string) => void; setRecipe: (f: (r: Recipe) => Recipe) => void }) {
  const node = recipe.nodes.find((n) => n.id === nodeId)!;
  const all = sourcesFor(recipe, nodeId, catalog);
  if (!Object.keys(m.inputs).length) return null;
  const setFixed = (port: string, type: string, value: unknown) => {
    const key = `${nodeId}_${port}`;
    setRecipe((r) => ({ ...r, consts: { ...(r.consts ?? {}), [key]: { type, value } }, nodes: r.nodes.map((n) => (n.id === nodeId ? { ...n, inputs: { ...n.inputs, [port]: `const.${key}` } } : n)) }));
  };
  return (
    <div className="grid" style={{ gap: 8 }}>
      <div className="sectlabel">Inputs <span className="muted">· where each value comes from</span></div>
      {Object.entries(m.inputs).map(([port, spec]) => {
        const opts = all.filter((s) => isAssignable(catalog.types, s.type, spec.type));
        const ref = node.inputs[port] ?? '';
        const fixedKey = ref.startsWith('const.') ? ref.slice(6) : null;
        const fixable = ['asset.id', 'usd', 'percent', 'near.account', 'address.near'].includes(spec.type);
        return (
          <div key={port} className={'field' + (ref ? '' : ' missing')}>
            <label htmlFor={`in-${port}`}>{port} <span className="muted">({spec.type})</span></label>
            <select id={`in-${port}`} value={fixedKey ? '__fixed' : ref} onChange={(e) => e.target.value === '__fixed' ? setFixed(port, spec.type, spec.type === 'asset.id' ? Object.keys(ASSET_LABEL)[0] : '') : wire(nodeId, port, e.target.value)}>
              {!ref && <option value="">choose…</option>}
              {opts.map((s) => <option key={s.ref} value={s.ref}>{s.label}</option>)}
              {fixable && <option value="__fixed">A fixed value you choose…</option>}
            </select>
            {fixedKey && (spec.type === 'asset.id'
              ? <select aria-label="Fixed asset" value={String(recipe.consts?.[fixedKey]?.value ?? '')} onChange={(e) => setFixed(port, spec.type, e.target.value)}>{Object.entries(ASSET_LABEL).map(([id, l]) => <option key={id} value={id}>{l}</option>)}</select>
              : <input aria-label="Fixed value" value={String(recipe.consts?.[fixedKey]?.value ?? '')} onChange={(e) => setFixed(port, spec.type, spec.type === 'usd' || spec.type === 'percent' ? Number(e.target.value) : e.target.value)} />)}
            {!opts.length && !fixable && <span className="small loss">Nothing produces a {spec.type} yet: add a part that does, before this one.</span>}
          </div>
        );
      })}
    </div>
  );
}

function SwapList({ recipe, nodeId, current, catalog, onSwap }: { recipe: Recipe; nodeId: string; current: PartManifest; catalog: Catalog; onSwap: (id: string) => void }) {
  const swaps = compatibleSwaps(recipe, nodeId, catalog);
  if (!swaps.length) return null;
  return (
    <details className="small">
      <summary>{swaps.length} drop-in alternative{swaps.length > 1 ? 's' : ''} (same inputs and outputs)</summary>
      <div className="grid" style={{ gap: 6, marginTop: 6 }}>
        {swaps.map((b) => (
          <div className="swap-opt" key={b.id}>
            <div className="row between"><b>{b.name} <RiskPill risk={withdrawalRisk(b.disclosure)} /></b><span>{usd(b.fee_per_call, 2)} vs {usd(current.fee_per_call, 2)}</span></div>
            <div className="muted">{b.summary}</div>
            <button className="btn ghost sm" onClick={() => onSwap(b.id)}>Use this instead</button>
          </div>
        ))}
      </div>
    </details>
  );
}

export function RiskPill({ risk, label }: { risk: 'low' | 'medium' | 'high'; label?: boolean }) {
  return <span className={'pill ' + (risk === 'low' ? 'ok' : risk === 'high' ? 'bad' : 'warn')} title="Withdrawal risk: can this be rebuilt if its supplier disappears? Open-weights or bundled code: low. Remote services: medium. Closed models or closed harnesses: high.">{label ? `${risk} withdrawal risk` : risk}</span>;
}
