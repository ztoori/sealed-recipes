import { useCallback, useEffect, useMemo, useState } from 'react';
import { ReactFlow, Background, Controls, Handle, Position, applyNodeChanges, type Connection, type Edge, type Node, type NodeChange, type NodeProps, type EdgeChange, ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { compatibleSwaps, swapPart, validateRecipe, withdrawalRisk, isAssignable, type PartManifest, type Catalog, type Recipe, type FormField, type Diagnostic } from '../../../core/src/srs';
import { addBuyerField, addPartAutoWired, blankRecipe, BUYER_TYPES, sourcesFor, suggestNext } from '../../../core/src/partkit';
import { open, type SealedEnvelope } from '../../../core/src/seal';
import { creatorKeyFromSignature, creatorKeyMessage, demoWalletSign } from '../../../core/src/creator';
import { api, ASSET_LABEL, money, usd, usePoll } from '../api';
import { useApp, useStoryOnce } from '../App';
import { SealModal } from '../components/SealModal';
import { CAT, Icon } from '../icons';
import { Empty, Seal, Tip } from '../ui';
import CLNP from '../../../seed/recipes/CLNP.json';

/**
 * Compose › Recipe: start a new recipe, or open one of your own published recipes to change it.
 * The builder is no-code: add parts and each one wires itself to the previous step's matching output; a value nothing
 * earlier provides is asked from the buyer (the buyer's form grows as you go), and every wire can be changed from a
 * plain list. Then name it, price it and seal it. Recipes are private: you can only open your own, from the copy
 * sealed to your wallet key when you published it.
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
    <div className={'fnode' + (selected ? ' selected' : '') + (data.errors ? ' err' : '') + (data.isResult ? ' result' : '')} style={{ ['--cc' as any]: CAT[m.category]?.color }}>
      <div className="hd"><span className="cat"><Icon name={CAT[m.category]?.icon ?? 'box'} size={12} />{CAT_LABEL[m.category][0]}</span><b>{m.name}</b><span>{m.author} · {usd(m.fee_per_call, 2)}</span></div>
      <div className="ports">
        <div>{Object.entries(m.inputs).map(([p, s]) => (<div key={p} className="port"><Handle type="target" position={Position.Left} id={p} style={{ left: -6 }} />{p}<i>{s.type}</i></div>))}</div>
        <div>{Object.entries(m.outputs).map(([p, s]) => (<div key={p} className="port out"><Handle type="source" position={Position.Right} id={p} style={{ right: -6 }} />{p}<i>{s.type}</i></div>))}</div>
      </div>
      {data.isResult && <div className="resulttag"><Icon name="check" size={12} />result</div>}
    </div>
  );
}
function FormNode({ data, selected }: NodeProps<Node<{ fields: FormField[]; consts: [string, { type: string; value: unknown }][] }>>) {
  return (
    <div className={'fnode form' + (selected ? ' selected' : '')}>
      <div className="hd"><span className="cat"><Icon name="user" size={12} />Buyer</span><b>Buyer’s form</b></div>
      <div className="ports" style={{ gridTemplateColumns: '1fr' }}>
        {data.fields.map((f) => (<div key={f.id} className="port out"><Handle type="source" position={Position.Right} id={f.id} style={{ right: -6 }} />{f.label}<i>{f.type}</i></div>))}
        {data.consts.map(([k, c]) => (<div key={'c' + k} className="port out"><Handle type="source" position={Position.Right} id={'const:' + k} style={{ right: -6 }} />fixed: {ASSET_LABEL[String(c.value)] ?? String(c.value)}<i>{c.type}</i></div>))}
        {!data.fields.length && !data.consts.length && <div className="port muted">Nothing asked yet</div>}
      </div>
    </div>
  );
}
const nodeTypes = { part: PartNode, form: FormNode };

/** Diagnostics in the words a no-code builder needs. */
function friendly(d: Diagnostic, name: (id?: string) => string): string {
  switch (d.code) {
    case 'port.unwired': return `${name(d.node)}: “${d.port}” has no value yet. Select the part and choose where it comes from.`;
    case 'recipe.output': return 'Choose which part’s output the buyer gets (select a part, then “Use as the result”).';
    case 'recipe.empty': return 'Add at least one part.';
    case 'meta.ticker': return 'Give it a short code: 3 to 6 capital letters or digits.';
    case 'meta.name': return 'Give it a name buyers will understand.';
    case 'node.deadend': return `${name(d.node)}: nothing uses its output, but you would still pay its fee. Connect it or remove it.`;
    case 'form.unused': return `The buyer’s “${d.message.match(/"([^"]+)"/)?.[1]}” is not used by any part yet.`;
    default: return (d.node ? `${name(d.node)}: ` : '') + d.message;
  }
}

export function ComposeRecipe() { return <ReactFlowProvider><Builder /></ReactFlowProvider>; }

/** The published version a draft was opened from: what a new version may change, and what it may not. */
interface Baseline { ticker: string; version: number; pending: boolean; parts: string[]; form: string; outputType?: string; opened: string }

/** the draft survives leaving the page (e.g. to read how a part works) for the rest of the visit */
let savedDraft: { recipe: Recipe; base: Baseline | null } | null = null;
const formKey = (form: FormField[]) => JSON.stringify(form);
const partSet = (ids: string[]) => [...new Set(ids)].sort();
/** what a new version seals: the wiring and settings (canvas positions don't count as a change) */
const sealedKey = (r: Recipe) => JSON.stringify({ nodes: r.nodes.map(({ ui: _ui, ...n }) => n), consts: r.consts ?? {}, output: r.output });

function Builder() {
  const { story, toast, go, acting } = useApp();
  const once = useStoryOnce();
  const [cat] = usePoll<Catalog & { onchain: Record<string, unknown> }>('/api/catalog', 60000);
  const [listings] = usePoll<any[]>('/api/listings', 5000);
  const catalog = cat as Catalog | undefined;
  const [recipe, setRecipe] = useState<Recipe | null>(() => savedDraft?.recipe ?? null);
  const [base, setBase] = useState<Baseline | null>(() => savedDraft?.base ?? null);
  useEffect(() => { savedDraft = recipe ? { recipe, base } : null; }, [recipe, base]);
  const [q, setQ] = useState('');
  const [opening, setOpening] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [sealing, setSealing] = useState(false);
  const [find, setFind] = useState('');
  const [dims, setDims] = useState<Record<string, { width: number; height: number }>>({});
  const [formPos, setFormPos] = useState({ x: -280, y: 80 });
  const rf = useReactFlow();
  const manifests = useMemo(() => new Map((catalog?.parts ?? []).map((b) => [b.id, b])), [catalog]);
  const v = useMemo(() => (catalog && recipe ? validateRecipe(recipe, catalog) : null), [recipe, catalog]);
  const nodeName = (id?: string) => manifests.get(recipe?.nodes.find((n) => n.id === id)?.part ?? '')?.name ?? id ?? '';
  const fit = (ms = 120) => setTimeout(() => rf.fitView({ padding: 0.2, duration: 250, maxZoom: 1 }), ms);

  const startNew = () => { setRecipe(blankRecipe(acting)); setBase(null); setSel(null); fit(); };
  /** reopen one of your published recipes: its creator copy is sealed to a key only your wallet signature re-derives */
  const openMine = async (l: any) => {
    setOpening(l.ticker);
    try {
      const c = await api<{ envelope: SealedEnvelope }>(`/api/vault/${l.ticker}/creator-copy`);
      const r = open<Recipe>(c.envelope, creatorKeyFromSignature(demoWalletSign(acting, creatorKeyMessage(acting))).secretKey);
      const v = catalog ? validateRecipe(r, catalog) : undefined;
      setRecipe(r); setSel(null); fit();
      setBase({ ticker: l.ticker, version: l.onchain?.version ?? 1, pending: !!l.onchain?.pending_sealed_hash, parts: partSet(l.parts), form: formKey(r.form), outputType: v?.outputType, opened: sealedKey(r) });
    } catch { toast(`Could not open ${l.ticker}: only the account that published it can`, true); }
    finally { setOpening(''); }
  };
  // cleared here, not only in the effect: publishing navigates away before the effect would run
  const clearDraft = () => { savedDraft = null; setRecipe(null); setBase(null); setSel(null); };
  const close = () => { if (!recipe?.nodes.length || base || confirm('Leave this draft? The parts you added will be removed.')) clearDraft(); };
  // a new recipe belongs to whoever you are acting as; a published one stays its creator's (switching closes it)
  useEffect(() => { if (base && base.ticker && recipe && recipe.meta.creator !== acting) { setRecipe(null); setBase(null); } else setRecipe((r) => (r ? { ...r, meta: { ...r.meta, creator: acting } } : r)); }, [acting]);

  /** add a part: wired automatically, placed after the step it reads from */
  const add = (partId: string, at?: { x: number; y: number }) => {
    if (!recipe || !catalog) return;
    const a = addPartAutoWired(recipe, partId, catalog, { askBuyer: true });
    const n = a.recipe.nodes.find((x) => x.id === a.nodeId)!;
    const fromNodes = Object.values(n.inputs).map((ref) => recipe.nodes.find((x) => x.id === ref.split('.')[0])).filter(Boolean) as typeof recipe.nodes;
    const x = at?.x ?? (fromNodes.length ? Math.max(...fromNodes.map((f) => f.ui?.x ?? 0)) + 270 : 0);
    let y = at?.y ?? (fromNodes[0]?.ui?.y ?? 80);
    while (!at && recipe.nodes.some((o) => Math.abs((o.ui?.x ?? 0) - x) < 200 && Math.abs((o.ui?.y ?? 0) - y) < 150)) y += 170;
    setRecipe({ ...a.recipe, nodes: a.recipe.nodes.map((o) => (o.id === a.nodeId ? { ...o, ui: { x, y } } : o)) });
    setSel(a.nodeId);
    if (a.unwired.length) toast(`${manifests.get(partId)?.name}: choose where ${a.unwired.map((p) => `“${p}”`).join(', ')} comes from`);
    else if (a.asked.length) toast(`Added to the buyer’s form: ${a.asked.map((id) => a.recipe.form.find((f) => f.id === id)?.label).join(', ')}`);
    fit(80);
  };
  const remove = (id: string) => setRecipe((r) => r && ({ ...r, output: r.output.startsWith(id + '.') ? '' : r.output, nodes: r.nodes.filter((n) => n.id !== id).map((n) => ({ ...n, inputs: Object.fromEntries(Object.entries(n.inputs).filter(([, ref]) => !ref.startsWith(id + '.'))) })) }));

  // ---------- recipe <-> flow ----------
  const nodes: Node[] = useMemo(() => !recipe ? [] : [
    { id: 'form', type: 'form', position: formPos, measured: dims.form, data: { fields: recipe.form, consts: Object.entries(recipe.consts ?? {}) }, selected: sel === 'form', deletable: false },
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
      let r: Recipe = { ...blankRecipe('chef.testnet'), meta: { ...t.meta, creator: 'chef.testnet' }, form: t.form, listing: t.listing };
      setRecipe(r); setBase(null); setSel(null); fit(30);
      for (const n of t.nodes) {
        await new Promise((ok) => setTimeout(ok, 700));
        const a = addPartAutoWired(r, n.part, catalog);
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

  // ---------- start: a new recipe, or one of yours ----------
  if (!recipe) {
    const mine = (listings ?? []).filter((l) => l.creator === acting);
    const s = q.trim().toLowerCase();
    const shown = mine.filter((l) => !s || [l.ticker, l.name, l.description, ...l.parts.map((p: string) => p.split('@')[0])].join(' ').toLowerCase().includes(s));
    return (
      <div className="grid compose-start">
        <button className="panel newcard" onClick={startNew}>
          <span className="plus"><Icon name="plus" size={26} /></span>
          <b>New recipe</b>
          <span className="small muted">Start from a blank canvas and add parts. The buyer’s form builds itself from what the parts need.</span>
        </button>
        <section className="panel mine" aria-label="Your recipes">
          <header><Icon name="compose" size={16} className="hd-ic" /><h2>Your recipes</h2><span className="small muted">as {acting}</span><span className="spacer" /><span className="count">{mine.length}</span></header>
          <div className="body" style={{ paddingBottom: 6 }}>
            <label className="search-wrap"><Icon name="search" size={16} /><input className="search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your recipes, parts" aria-label="Search your recipes" /></label>
          </div>
          {shown.length > 0 && <ul className="rlist mine-list">
            {shown.map((l) => (
              <li key={l.ticker} className="rcp">
                <button className="pick" onClick={() => openMine(l)} disabled={!!opening} title={`Open ${l.ticker} in the builder`}>
                  <Seal ticker={l.ticker} kind={l.output_type} size={38} />
                  <span className="nm"><b>{l.name}</b><span className="sub"><span className="tk">{l.ticker}</span>v{l.onchain?.version ?? 1} · {l.parts.length} parts{l.onchain?.pending_sealed_hash ? ' · new version pending' : ''}</span></span>
                  <span className="px"><b>{money(l.record.pricePerRun)}</b><span className="edit">{opening === l.ticker ? 'Opening…' : <><Icon name="compose" size={13} />Edit</>}</span></span>
                </button>
              </li>
            ))}
          </ul>}
          {listings && !mine.length && <Empty icon="compose">Nothing published as {acting} yet. Recipes you publish show up here, ready to edit.</Empty>}
          {listings && mine.length > 0 && !shown.length && <Empty icon="search">None of your recipes match “{q}”.</Empty>}
        </section>
      </div>
    );
  }

  // ---------- steps 2-3: parts, then listing ----------
  const s = find.trim().toLowerCase();
  const visible = catalog.parts.filter((p) => !s || `${p.name} ${p.summary} ${p.id} ${p.author}`.toLowerCase().includes(s));
  const next = suggestNext(recipe, catalog).slice(0, 4);
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
  // editing a published recipe: a new version may change wiring and settings; the parts list (on-chain), the buyer's
  // form and the result type (in the public listing) are what buyers chose it by, so changing those makes a new recipe
  const sameShape = !!base && !!v && partSet(v.partsUsed).join() === base.parts.join() && formKey(recipe.form) === base.form && v.outputType === base.outputType;
  const asVersion = sameShape && recipe.meta.ticker === base!.ticker;
  const taken = !asVersion && (listings ?? []).some((l) => l.ticker === recipe.meta.ticker);
  const errors = (v?.diagnostics ?? []).filter((d) => d.severity === 'error');
  const progress: [string, boolean][] = [
    ['Parts added', recipe.nodes.length > 0],
    ['Every input has a value', !errors.some((d) => d.code === 'port.unwired' || d.code === 'port.type' || d.code === 'port.ref')],
    ['A result for the buyer', !!recipe.output && !errors.some((d) => d.code === 'recipe.output')],
    ...(asVersion ? [] : [['Short code and name', /^[A-Z0-9]{3,6}$/.test(recipe.meta.ticker) && !!recipe.meta.name && !taken] as [string, boolean], ['Price covers the fees', floor >= floorNeed && bandOk] as [string, boolean]]),
    ...(asVersion ? [['Wiring or settings changed', sealedKey(recipe) !== base!.opened] as [string, boolean], ['No other new version waiting', !base!.pending] as [string, boolean]] : []),
  ];
  const canPublish = !!v?.ok && progress.every(([, ok]) => ok);
  const setMeta = (k: keyof Recipe['meta'], val: string) => setRecipe((r) => r && ({ ...r, meta: { ...r.meta, [k]: val } }));
  const setListing = (k: keyof Recipe['listing'], val: string | number) => setRecipe((r) => r && ({ ...r, listing: { ...r.listing, [k]: val } }));
  const setBand = (k: 'price_floor' | 'price_ceiling' | 'target_runs', val: string | number) => setRecipe((r) => r && ({ ...r, listing: { ...r.listing, pricing: { ...(r.listing.pricing ?? { price_floor: r.listing.price_per_run, price_ceiling: r.listing.price_per_run, target_runs: 2 }), [k]: val } } }));
  const toUnits = (x: string) => String(Math.round(Number(x) * 1e6));
  const setParam = (k: string, val: unknown) => setRecipe((r) => r && ({ ...r, nodes: r.nodes.map((n) => (n.id === sel ? { ...n, params: { ...n.params, [k]: val } } : n)) }));

  const partItem = (b: PartManifest, hint?: string) => (
    <div key={b.id} className="item" style={{ ['--cc' as any]: CAT[b.category]?.color }} draggable onDragStart={(e) => e.dataTransfer.setData('application/srs-part', b.id)} title={b.summary}>
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}><b>{b.name}</b><span>{usd(b.fee_per_call, 2)} · {b.author}{hint ? ` · ${hint}` : ''}</span></div>
        <button className="btn sm icon-only" onClick={() => add(b.id)} aria-label={`Add ${b.name}`} title="Add (or drag onto the canvas)"><Icon name="plus" size={14} /></button>
      </div>
      <div className="sum">{b.summary}</div>
    </div>
  );

  return (
    <div className="grid composer">
      <aside className="panel palette" aria-label="Parts">
        <header><Icon name="box" size={16} className="hd-ic" /><h2>Parts</h2><Tip>Add a part and it wires itself to the previous step’s matching output. Drag to the canvas, or press +.</Tip></header>
        <div className="body" style={{ paddingBottom: 4 }}>
          <div className="row small" style={{ gap: 8 }}><Seal ticker={recipe.meta.ticker || null} kind={v?.outputType} size={26} /><b style={{ flex: 1, minWidth: 0 }}>{base ? <>{base.ticker} <span className="muted" style={{ fontWeight: 400 }}>v{base.version}</span></> : recipe.meta.name || 'New recipe'}</b><button className="linkbtn" onClick={close}><Icon name="back" size={13} />Your recipes</button></div>
          <label className="search-wrap" style={{ marginTop: 10 }}><Icon name="search" size={15} /><input className="search" type="search" placeholder="Search parts" value={find} onChange={(e) => setFind(e.target.value)} aria-label="Search parts" /></label>
        </div>
        {!s && done && <div className="body small gain row" style={{ paddingTop: 4, paddingBottom: 4 }}><Icon name="check" size={14} />Hands the buyer a result. Add more only to improve it.</div>}
        {!s && next.length > 0 && <><div className="cat" style={{ ['--cc' as any]: 'var(--wax)' }}><Icon name="sparkles" size={14} />Suggested next</div>{next.map((b) => partItem(b, CAT_LABEL[b.category][0].toLowerCase()))}</>}
        {CAT_ORDER.map((c) => {
          const items = visible.filter((b) => b.category === c);
          return items.length ? <div key={c}><div className="cat" style={{ ['--cc' as any]: CAT[c].color }} title={CAT_LABEL[c][1]}><Icon name={CAT[c].icon} size={14} />{CAT_LABEL[c][0]}</div>{items.map((b) => partItem(b))}</div> : null;
        })}
      </aside>

      <section className="panel canvas" onDragOver={(e) => e.preventDefault()} onDrop={onDrop} aria-label="Recipe canvas">
        <div className="canvas-bar">
          <span className="hint">{recipe.nodes.length ? <><Icon name="compose" size={14} />Drag to arrange · output → input to rewire · click to edit</> : <><Icon name="database" size={14} />Start with a Read part</>}</span>
          <span className="spacer" />
          {recipe.nodes.length > 0 && <button className="btn ghost sm" onClick={() => { const last = recipe.nodes.at(-1)!; remove(last.id); setSel(null); }} title="Remove the last part"><Icon name="back" size={13} />Undo part</button>}
          {recipe.nodes.length > 0 && <button className="btn ghost sm icon-only" aria-label="Start over" title="Start over" onClick={() => { if (confirm('Remove every part and the buyer’s form, and start again?')) { setRecipe({ ...blankRecipe(recipe.meta.creator), meta: recipe.meta, listing: recipe.listing }); setSel(null); } }}><Icon name="refresh" size={14} /></button>}
        </div>
        <ReactFlow colorMode="dark" nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onPaneClick={() => setSel(null)} fitView fitViewOptions={{ maxZoom: 1, padding: 0.2 }} minZoom={0.3} proOptions={{ hideAttribution: true }}>
          <Background gap={22} color="#25314e" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </section>

      <aside className="grid" style={{ alignContent: 'start', overflow: 'auto', minWidth: 0 }}>
        {selNode && selM && (
          <div className="panel">
            <header><span style={{ color: CAT[selM.category]?.color, display: 'flex' }}><Icon name={CAT[selM.category]?.icon ?? 'box'} size={16} /></span><h2>{selM.name}</h2><Tip>{selM.summary}</Tip><span className="spacer" /><span className="small muted">{usd(selM.fee_per_call, 2)}</span></header>
            <div className="body grid" style={{ gap: 10 }}>
              <div className="small muted row">by {selM.author}<span className="spacer" /><button className="linkbtn" onClick={() => go({ page: 'compose', sub: 'part', part: selM.id })}><Icon name="code" size={13} />Code</button></div>
              <div className="row wrap small" style={{ gap: 6 }}><RiskPill risk={withdrawalRisk(selM.disclosure)} label />{selM.capabilities.includes('wallet:approve') && <span className="pill">asks the buyer to sign</span>}</div>
              <InputsEditor recipe={recipe} nodeId={selNode.id} m={selM} catalog={catalog} wire={wire} setRecipe={setRecipe as never} />
              {Object.keys(selM.params).length > 0 && <div className="grid" style={{ gap: 8 }}>
                <div className="sectlabel"><Icon name="lock" size={13} />Your settings<Tip>Sealed: only the runner sees them.</Tip></div>
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
              {Object.entries(selM.outputs).map(([port, o]) => (
                <label key={port} className="row small"><input type="radio" name="result" checked={recipe.output === `${selNode.id}.${port}`} onChange={() => setRecipe((r) => r && ({ ...r, output: `${selNode.id}.${port}` }))} /> Use {Object.keys(selM.outputs).length > 1 ? <>“{port}” </> : ''}as the recipe’s result (what the buyer gets)<span className="muted">{o.type}</span></label>
              ))}
              <SwapList recipe={recipe} nodeId={selNode.id} current={selM} catalog={catalog} onSwap={(id) => setRecipe(swapPart(recipe, selNode.id, id, catalog))} />
              <button className="btn ghost sm" onClick={() => { remove(selNode.id); setSel(null); }}><Icon name="trash" size={13} />Remove part</button>
            </div>
          </div>
        )}

        {sel === 'form' && <FormEditor recipe={recipe} setRecipe={setRecipe as never} published={!!base} />}

        <div className="panel">
          <header><Icon name="ticket" size={16} className="hd-ic" /><h2>Listing</h2>{asVersion && <span className="pill">as published</span>}</header>
          <fieldset disabled={asVersion} className="body grid" style={{ gap: 8, gridTemplateColumns: '1fr 1fr', border: 0, margin: 0, minInlineSize: 0 }}>
            {asVersion && <div className="small muted" style={{ gridColumn: '1 / 3' }}>A new version changes the sealed wiring and settings only. The name, price and deposit stay as listed; change the price band on the recipe’s page.</div>}
            <div className="field" style={{ gridColumn: '1 / 3' }}><label htmlFor="nm">Name</label><input id="nm" value={recipe.meta.name} onChange={(e) => setMeta('name', e.target.value)} placeholder="e.g. Clean up and protect" /></div>
            <div className="field"><label htmlFor="tk">Ticker</label><input id="tk" value={recipe.meta.ticker} onChange={(e) => setMeta('ticker', e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} maxLength={6} placeholder="ABCD" />{taken && <span className="small loss">{base && recipe.meta.ticker === base.ticker ? 'yours: a changed recipe needs a new code' : 'taken'}</span>}</div>
            <div className="field"><label htmlFor="pr">Price (USDC)</label><input id="pr" value={Number(recipe.listing.price_per_run) / 1e6} onChange={(e) => setListing('price_per_run', toUnits(e.target.value))} inputMode="decimal" /></div>
            <div className="field" style={{ gridColumn: '1 / 3' }}><label htmlFor="ds">One line for buyers</label><input id="ds" value={recipe.meta.description} onChange={(e) => setMeta('description', e.target.value)} placeholder="What the buyer gets, in their words" /></div>
            <details style={{ gridColumn: '1 / 3' }} className="small">
              <summary>Price band and guarantee</summary>
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
          </fieldset>
        </div>

        <div className="panel">
          <header><Icon name="lock" size={16} className="hd-ic" /><h2>Publish</h2><span className="spacer" />{v && recipe.nodes.length > 0 && <RiskPill risk={v.risk} />}{v && <span className={'pill ' + (canPublish ? 'ok' : 'warn')}>{canPublish ? 'ready' : `${progress.filter(([, ok]) => !ok).length} to go`}</span>}</header>
          <div className="body">
            <div className="meter"><i style={{ width: `${(progress.filter(([, ok]) => ok).length / progress.length) * 100}%` }} /></div>
            <ul className="progress">{progress.map(([label, ok]) => <li key={label} className={ok ? 'ok' : ''}><span className="pi">{ok && <Icon name="check" size={11} />}</span>{label}</li>)}</ul>
            {recipe.nodes.length > 0 && errors.length > 0 && <div style={{ marginTop: 6 }}>{errors.slice(0, 3).map((d, i) => <div key={i} className="diag error">{friendly(d, nodeName)}</div>)}</div>}
            {recipe.nodes.length > 0 && (v?.diagnostics ?? []).filter((d) => d.severity === 'warning').slice(0, 2).map((d, i) => <div key={'w' + i} className="diag warning">{friendly(d, nodeName)}</div>)}
            {floor < floorNeed && recipe.nodes.length > 0 && <div className="diag error">{band ? 'The floor' : 'The price'} must cover the fees: at least {usd(floorNeed)}.</div>}
            <div className="earn"><span className="small muted">You earn per run <Tip>{`Price minus part fees ${usd(fees)}, sealed runner ${usd(RUNNER_FEE)} and protocol 2% ${usd(protocol)}.`}</Tip></span><b>{usd(left)}</b></div>
            {base && !sameShape && recipe.nodes.length > 0 && <div className="diag warning">You changed the parts, the buyer’s form or the result, which buyers chose {base.ticker} by. This publishes as a new recipe with its own short code; {base.ticker} stays listed as it is.</div>}
            {asVersion && base!.pending && <div className="diag error">{base!.ticker} already has a new version waiting to take effect.</div>}
            <button className="btn seal lg" style={{ width: '100%', marginTop: 12 }} disabled={!canPublish} onClick={() => setSealing(true)}><Icon name="lock" size={16} />{asVersion ? `Seal version ${base!.version + 1}` : 'Seal and publish'}</button>
            <div className="small muted row" style={{ marginTop: 8, justifyContent: 'center' }}>Encrypted in this browser. Nobody else can read it. <Tip>Sealed to the attested runner. Not even this marketplace can read your wiring or settings.</Tip></div>
          </div>
        </div>
      </aside>

      {sealing && <SealModal recipe={{ ...recipe, meta: { ...recipe.meta, creator: story.step === 1 ? 'chef.testnet' : acting } }} catalog={catalog} auto={story.step === 1} asVersion={asVersion}
        onClose={(published) => {
          setSealing(false); if (!published) return;
          const t = recipe.meta.ticker; clearDraft();
          if (story.step === 1) setTimeout(() => story.advance(1), 600);
          else if (asVersion) toast(`${t} version ${base!.version + 1} announced: it takes effect after the notice period`);
          else go({ page: 'recipes', ticker: t });
        }} />}
    </div>
  );
}

/** The buyer's form: what a buyer fills in before asking for a quote. Parts add fields; the creator words them. */
function FormEditor({ recipe, setRecipe, published }: { recipe: Recipe; setRecipe: (f: (r: Recipe) => Recipe) => void; published: boolean }) {
  const [adding, setAdding] = useState(Object.keys(BUYER_TYPES)[0]);
  const users = (id: string) => recipe.nodes.filter((n) => Object.values(n.inputs).includes(`form.${id}`)).length;
  const set = (id: string, patch: Partial<FormField>) => setRecipe((r) => ({ ...r, form: r.form.map((f) => (f.id === id ? { ...f, ...patch } : f)) }));
  const drop = (id: string) => setRecipe((r) => ({ ...r, form: r.form.filter((f) => f.id !== id) }));
  return (
    <div className="panel">
      <header><Icon name="user" size={16} className="hd-ic" /><h2>Buyer’s form</h2><Tip>What the buyer fills in before asking for a quote. When a part needs a value nothing earlier provides, it adds a field here; word it for buyers, set a default, or add more.</Tip></header>
      <div className="body grid" style={{ gap: 10 }}>
        {published && <div className="small muted">Buyers chose this recipe by its form: changing it publishes a new recipe instead of a new version.</div>}
        {!recipe.form.length && <div className="small muted">Nothing asked yet. Add a Read part and it asks for the wallet it reads.</div>}
        {recipe.form.map((f) => {
          const n = users(f.id);
          return (
            <div key={f.id} className="formfield">
              <div className="row small" style={{ gap: 6 }}><code>{f.id}</code><span className="muted">{f.type}</span><span className="spacer" /><span className="muted">{n ? `used by ${n} part${n > 1 ? 's' : ''}` : 'not used yet'}</span>
                <button className="btn ghost sm icon-only" aria-label={`Remove ${f.label}`} title={n ? 'Used by a part: wire that input elsewhere first' : 'Remove this field'} disabled={n > 0} onClick={() => drop(f.id)}><Icon name="trash" size={13} /></button></div>
              <div className="field"><label htmlFor={'ff-' + f.id}>Question the buyer sees</label><input id={'ff-' + f.id} value={f.label} onChange={(e) => set(f.id, { label: e.target.value })} /></div>
              {f.type === 'asset.id' && <div className="field"><label htmlFor={'fd-' + f.id}>Default</label><select id={'fd-' + f.id} value={String(f.default ?? '')} onChange={(e) => set(f.id, { default: e.target.value || undefined, options: Object.keys(ASSET_LABEL) })}><option value="">none</option>{Object.entries(ASSET_LABEL).map(([id, l]) => <option key={id} value={id}>{l}</option>)}</select></div>}
              {(f.type === 'usd' || f.type === 'percent') && <div className="field"><label htmlFor={'fd-' + f.id}>Default</label><input id={'fd-' + f.id} inputMode="decimal" value={f.default == null ? '' : String(f.default)} onChange={(e) => set(f.id, { default: e.target.value === '' ? undefined : Number(e.target.value) })} /></div>}
              {f.type === 'address.near' && <label className="row small"><input type="checkbox" checked={f.generator === 'fresh-implicit'} onChange={(e) => set(f.id, { generator: e.target.checked ? 'fresh-implicit' : undefined })} /> Generate a fresh address in the buyer’s browser</label>}
              <label className="row small"><input type="checkbox" checked={!!f.required} onChange={(e) => set(f.id, { required: e.target.checked })} /> Required</label>
            </div>
          );
        })}
        <div className="row" style={{ gap: 6, alignItems: 'stretch' }}>
          <div className="field" style={{ flex: 1 }}><select aria-label="Type of field to add" value={adding} onChange={(e) => setAdding(e.target.value)}>{Object.entries(BUYER_TYPES).map(([t, d]) => <option key={t} value={t}>{d.label} ({t})</option>)}</select></div>
          <button className="btn ghost sm" onClick={() => setRecipe((r) => addBuyerField(r, adding).recipe)}><Icon name="plus" size={13} />Add a field</button>
        </div>
      </div>
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
  const askBuyer = (port: string, type: string) => setRecipe((r) => {
    const a = addBuyerField(r, type, type === 'near.account' || type === 'address.near' ? {} : { id: port });
    return { ...a.recipe, nodes: a.recipe.nodes.map((n) => (n.id === nodeId ? { ...n, inputs: { ...n.inputs, [port]: `form.${a.fieldId}` } } : n)) };
  });
  return (
    <div className="grid" style={{ gap: 8 }}>
      <div className="sectlabel"><Icon name="link" size={13} />Inputs<Tip>Where each value comes from: an earlier part, the buyer’s form, or a fixed value.</Tip></div>
      {Object.entries(m.inputs).map(([port, spec]) => {
        const opts = all.filter((s) => isAssignable(catalog.types, s.type, spec.type));
        const ref = node.inputs[port] ?? '';
        const fixedKey = ref.startsWith('const.') ? ref.slice(6) : null;
        const fixable = ['asset.id', 'usd', 'percent', 'near.account', 'address.near'].includes(spec.type);
        return (
          <div key={port} className={'field' + (ref ? '' : ' missing')}>
            <label htmlFor={`in-${port}`}>{port}<span className="muted" style={{ fontWeight: 400 }}>{spec.type}</span></label>
            <select id={`in-${port}`} value={fixedKey ? '__fixed' : ref} onChange={(e) => e.target.value === '__fixed' ? setFixed(port, spec.type, spec.type === 'asset.id' ? Object.keys(ASSET_LABEL)[0] : '') : e.target.value === '__ask' ? askBuyer(port, spec.type) : wire(nodeId, port, e.target.value)}>
              {!ref && <option value="">choose…</option>}
              {opts.map((s) => <option key={s.ref} value={s.ref}>{s.label}</option>)}
              {BUYER_TYPES[spec.type] && <option value="__ask">Ask the buyer (new field)…</option>}
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
      <summary>{swaps.length} drop-in alternative{swaps.length > 1 ? 's' : ''}</summary>
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
