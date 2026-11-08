/**
 * Compose › Recipe, the logic of one part (SRS-1 §3.2–3.4), with no code and no expressions:
 *  - "Run this part": always, or only if a value an earlier part produced (or the buyer gave) passes a test;
 *  - "If it fails": stop and refund, or skip it and carry on (never for parts that ask the buyer to sign);
 *  - fallbacks for an input or for the result: used when the first choice was skipped.
 * Every choice is offered from the types and schemas of what is wired, so only conditions the validator accepts can be built.
 */
import { joinTypes, isAssignable, refsOf, schemaOf, type Binding, type Catalog, type Diagnostic, type Match, type PartManifest, type Recipe, type Schema, type When } from '../../../core/src/srs';
import { sourcesFor, type Source } from '../../../core/src/partkit';
import { Icon } from '../icons';
import { Tip } from '../ui';

type SetRecipe = (f: (r: Recipe) => Recipe) => void;
type TestKind = 'nonempty' | 'empty' | 'match' | 'some';
type Val = string | number | boolean | null;

/** the fields a condition can test on a value of `type`: from the type's schema (object fields, or fields of list items) */
export function testableFields(catalog: Catalog, type: string): { kind: 'match' | 'some'; fields: Record<string, Schema> } | null {
  const s = schemaOf(catalog.types, type);
  if (s?.type === 'object' && s.properties) return { kind: 'match', fields: scalarFields(s.properties) };
  if (s?.type === 'array' && s.items?.type === 'object' && s.items.properties) return { kind: 'some', fields: scalarFields(s.items.properties) };
  return null;
}
const scalarFields = (p: Record<string, Schema>) => Object.fromEntries(Object.entries(p).filter(([, f]) => ['string', 'number', 'integer', 'boolean'].includes(f.type ?? '') || f.enum));

const human = (x: string) => x.replace(/_/g, ' ');
const orList = (vals: Val[]) => vals.length <= 1 ? String(vals[0] ?? '…') : `${vals.slice(0, -1).join(', ')} or ${vals.at(-1)}`;

/** a condition in words, e.g. "verdict: risk is medium or high" */
export function describeWhen(w: When, label: string): string {
  const [field, vals] = Object.entries(w.match ?? w.some ?? {})[0] ?? ['', []];
  const test = w.match ? `${human(field)} is ${orList(vals)}` : w.some ? `any item’s ${human(field)} is ${orList(vals)}` : w.is === 'empty' ? 'is empty or was skipped' : 'has something';
  return `${w.not ? 'unless' : 'only if'} ${label} ${test}`;
}

/** short label for the canvas chip */
export function chipWhen(w: When): string {
  const [field, vals] = Object.entries(w.match ?? w.some ?? {})[0] ?? ['', []];
  const t = w.match ? `${human(field)} ∈ ${vals.join('/')}` : w.some ? `any ${human(field)} ∈ ${vals.join('/')}` : w.is === 'empty' ? `${w.ref.split('.')[0]} empty` : `${w.ref.split('.')[0]} has data`;
  return (w.not ? 'unless ' : 'if ') + t;
}

const kindOf = (w?: When): TestKind => (w?.match ? 'match' : w?.some ? 'some' : w?.is === 'empty' ? 'empty' : 'nonempty');

export function ConditionEditor({ recipe, nodeId, catalog, setRecipe, diagnostics }: { recipe: Recipe; nodeId: string; catalog: Catalog; setRecipe: SetRecipe; diagnostics: Diagnostic[] }) {
  const node = recipe.nodes.find((n) => n.id === nodeId)!;
  const w = node.when;
  const sources = sourcesFor(recipe, nodeId, catalog).filter((s) => s.kind !== 'const');
  const set = (next: When | undefined) => setRecipe((r) => ({ ...r, nodes: r.nodes.map((n) => (n.id === nodeId ? (next ? { ...n, when: next } : (({ when: _w, ...rest }) => rest)(n)) : n)) }));
  const src = w ? sources.find((s) => s.ref === w.ref) : undefined;
  const testable = src ? testableFields(catalog, src.type) : null;
  const kind = kindOf(w);
  const m: Match = (w?.match ?? w?.some ?? {}) as Match;
  const [field, vals] = Object.entries(m)[0] ?? [Object.keys(testable?.fields ?? {})[0] ?? '', []];
  const fs = testable?.fields[field];
  const errs = diagnostics.filter((d) => d.node === nodeId && d.code.startsWith('when.') && d.severity === 'error');

  /** start with the most useful test for the value: a field with listed values if the type has one */
  const startWith = (s: Source, not = false): When => {
    const t = testableFields(catalog, s.type);
    const f = t && Object.entries(t.fields).find(([, x]) => x.enum);
    return f ? { ref: s.ref, [t!.kind]: { [f[0]]: [f[1].enum!.at(-1)!] }, ...(not ? { not } : {}) } : { ref: s.ref, is: 'nonempty', ...(not ? { not } : {}) };
  };
  const setKind = (k: TestKind) => {
    if (!w) return;
    const base: When = { ref: w.ref, ...(w.not ? { not: true } : {}) };
    if (k === 'nonempty' || k === 'empty') return set({ ...base, is: k });
    const f = Object.entries(testable!.fields)[0];
    set({ ...base, [k]: { [f[0]]: f[1].enum ? [f[1].enum[0]] : [] } });
  };
  const setMatch = (f: string, v: Val[]) => w && set({ ref: w.ref, ...(w.not ? { not: true } : {}), [kind]: { [f]: v } });
  const toggle = (x: Val) => setMatch(field, vals.includes(x) ? vals.filter((y) => y !== x) : [...vals, x]);

  return (
    <div className="grid logic" style={{ gap: 8 }}>
      <div className="sectlabel"><Icon name="split" size={13} />Run this part<Tip wide>Decide when this part runs, from what an earlier part found or the buyer entered. A part that does not run is skipped, and so is anything that needs its output (unless you give it a fallback). Your conditions are sealed with the recipe.</Tip></div>
      <div className="seg" role="radiogroup" aria-label="When this part runs">
        <button role="radio" aria-checked={!w} className={!w ? 'on' : ''} onClick={() => set(undefined)}>Always</button>
        <button role="radio" aria-checked={!!w} className={w ? 'on' : ''} disabled={!sources.length} title={sources.length ? '' : 'Add an earlier part first'} onClick={() => !w && sources[0] && set(startWith(sources[0]))}>Only if…</button>
      </div>
      {w && <>
        <div className="field">
          <label htmlFor="when-src">Look at</label>
          <select id="when-src" value={w.ref} onChange={(e) => { const s = sources.find((x) => x.ref === e.target.value); if (s) set(startWith(s, w.not)); }}>
            {!src && <option value={w.ref}>{w.ref} (no longer available)</option>}
            {sources.map((s) => <option key={s.ref} value={s.ref}>{s.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="when-test">Run it when it</label>
          <select id="when-test" value={kind} onChange={(e) => setKind(e.target.value as TestKind)}>
            <option value="nonempty">has something (not empty)</option>
            <option value="empty">is empty, or its part was skipped</option>
            {testable?.kind === 'match' && <option value="match">has a field with one of these values</option>}
            {testable?.kind === 'some' && <option value="some">has any item whose field is one of these values</option>}
          </select>
        </div>
        {(kind === 'match' || kind === 'some') && testable && <>
          <div className="field">
            <label htmlFor="when-field">Field</label>
            <select id="when-field" value={field} onChange={(e) => { const f = testable.fields[e.target.value]; setMatch(e.target.value, f?.enum ? [f.enum[0]] : []); }}>
              {Object.keys(testable.fields).map((f) => <option key={f} value={f}>{human(f)}</option>)}
            </select>
          </div>
          {fs?.enum
            ? <div className="chips" role="group" aria-label="Values">{fs.enum.map((x) => <button key={String(x)} className={'chip' + (vals.includes(x) ? ' on' : '')} aria-pressed={vals.includes(x)} onClick={() => toggle(x)}>{String(x)}</button>)}</div>
            : fs?.type === 'boolean'
              ? <div className="chips" role="group" aria-label="Values">{[true, false].map((x) => <button key={String(x)} className={'chip' + (vals.includes(x) ? ' on' : '')} aria-pressed={vals.includes(x)} onClick={() => setMatch(field, [x])}>{x ? 'yes' : 'no'}</button>)}</div>
              : <div className="field"><label htmlFor="when-vals">Values (comma separated)</label><input id="when-vals" value={vals.join(', ')} onChange={(e) => setMatch(field, e.target.value.split(',').map((x) => x.trim()).filter(Boolean).map((x) => (fs?.type === 'number' || fs?.type === 'integer') && !isNaN(Number(x)) ? Number(x) : x))} /></div>}
        </>}
        <label className="row small"><input type="checkbox" checked={!!w.not} onChange={(e) => set({ ...w, not: e.target.checked || undefined })} /> The opposite: run when this is <b>not</b> true</label>
        <div className="small sentence"><Icon name="info" size={13} />Runs {describeWhen(w, src?.label ?? w.ref)}.</div>
        {errs.map((d, i) => <div key={i} className="diag error">{d.message}</div>)}
      </>}
    </div>
  );
}

export function OnErrorEditor({ recipe, nodeId, m, setRecipe }: { recipe: Recipe; nodeId: string; m: PartManifest; setRecipe: SetRecipe }) {
  const node = recipe.nodes.find((n) => n.id === nodeId)!;
  const signs = m.capabilities.includes('wallet:approve');
  const set = (skip: boolean) => setRecipe((r) => ({ ...r, nodes: r.nodes.map((n) => (n.id === nodeId ? (skip ? { ...n, on_error: 'skip' as const } : (({ on_error: _e, ...rest }) => rest)(n)) : n)) }));
  return (
    <div className="field">
      <label htmlFor="on-err">If this part fails<Tip>It fails if it errors, runs past its limits or returns something that is not what it declared. Stopping refunds the buyer. Skipping carries on without it: give the parts that need its output a fallback.</Tip></label>
      <select id="on-err" value={node.on_error === 'skip' ? 'skip' : 'fail'} disabled={signs} onChange={(e) => set(e.target.value === 'skip')}>
        <option value="fail">Stop the run and refund the buyer</option>
        <option value="skip">Skip it and carry on</option>
      </select>
      {signs && <span className="hint">This part asks the buyer to sign. Once it has, funds may have moved, so a failure always stops the run.</span>}
    </div>
  );
}

/** Fallbacks for one binding: the references after the first, each used when everything before it was skipped. */
export function Fallbacks({ binding, options, onChange, what }: { binding: Binding | undefined; options: Source[]; onChange: (b: Binding) => void; what: string }) {
  const refs = refsOf(binding);
  if (!refs.length) return null;
  const unused = options.filter((o) => !refs.includes(o.ref));
  const setAt = (i: number, ref: string) => { const n = [...refs]; n[i] = ref; onChange(n.length === 1 ? n[0] : n); };
  const drop = (i: number) => { const n = refs.filter((_, j) => j !== i); onChange(n.length === 1 ? n[0] : n); };
  return (
    <>
      {refs.slice(1).map((ref, k) => (
        <div key={k} className="row fallback" style={{ gap: 6 }}>
          <span className="small muted" style={{ flex: 'none' }}>else</span>
          <select aria-label={`Fallback ${k + 1} for ${what}`} value={ref} onChange={(e) => setAt(k + 1, e.target.value)} style={{ flex: 1, minWidth: 0 }}>
            {!options.some((o) => o.ref === ref) && <option value={ref}>{ref}</option>}
            {options.filter((o) => o.ref === ref || !refs.includes(o.ref)).map((o) => <option key={o.ref} value={o.ref}>{o.label}</option>)}
          </select>
          <button className="btn ghost sm icon-only" aria-label="Remove this fallback" onClick={() => drop(k + 1)}><Icon name="x" size={13} /></button>
        </div>
      ))}
      {unused.length > 0 && <button className="linkbtn small" style={{ justifySelf: 'start' }} onClick={() => onChange([...refs, unused[0].ref])}><Icon name="plus" size={12} />Fallback if {refs.length > 1 ? 'these are' : 'this is'} skipped</button>}
    </>
  );
}

/** outputs that could stand in for the recipe's result: same family of type, from parts other than the first choice */
export function resultOptions(recipe: Recipe, catalog: Catalog): Source[] {
  const first = refsOf(recipe.output)[0];
  if (!first) return [];
  const all = sourcesFor(recipe, null, catalog).filter((s) => s.kind === 'node');
  const t = all.find((s) => s.ref === first)?.type;
  return t ? all.filter((s) => s.ref === first || !!joinTypes(catalog.types, [t, s.type]) && (isAssignable(catalog.types, s.type, t) || isAssignable(catalog.types, t, s.type))) : [];
}
