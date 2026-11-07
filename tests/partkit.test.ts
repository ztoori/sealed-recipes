/** Builder kit: every catalog part conforms to SRS-1; every seed recipe can be built in the composer from its job's form by adding its parts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { addPartAutoWired, lintPartSource, partTemplate, recipeFromJob, sourcesFor, validatePartManifest, validateRecipe, isAssignable, type Catalog, type Recipe } from '../core/src/index.js';

const root = join(import.meta.dirname, '..');
const json = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'));
const catalog = { ...json('standard/parts.json'), jobs: json('standard/jobs.json').jobs } as Catalog;
const recipes: Recipe[] = [...readdirSync(join(root, 'seed/recipes')).map((f) => json(`seed/recipes/${f}`))];

test('partkit: every catalog part manifest conforms to SRS-1 §2', () => {
  for (const m of catalog.parts) assert.deepEqual(validatePartManifest(m, catalog).filter((x) => x.severity === 'error'), [], m.id);
});

test('partkit: every part implementation passes the static source checks for its manifest', () => {
  for (const m of catalog.parts) {
    const src = readFileSync(join(root, m.implementation!), 'utf8');
    // a file that implements several parts (e.g. contract-risk.ts: AI and rules) is checked for the per-file rules only
    const shared = catalog.parts.filter((p) => p.implementation === m.implementation).length > 1;
    const errs = lintPartSource(src, m).filter((x) => x.severity === 'error' && !(shared && x.code.startsWith('capability')));
    assert.deepEqual(errs, [], m.id);
  }
});

test('partkit: the manifest validator catches the mistakes builders make', () => {
  const ok = catalog.parts.find((p) => p.id === 'keys.revoke@1.0.0')!;
  const codes = (m: object, isNew = false) => validatePartManifest({ ...ok, ...m } as never, catalog, { isNew }).filter((x) => x.severity === 'error').map((x) => x.code);
  assert.deepEqual(codes({}, true), ['id.taken']);
  assert.ok(codes({ id: 'Bad Id' }).includes('id'));
  assert.ok(codes({ category: 'guard' }).includes('capability.wallet'));
  assert.ok(codes({ capabilities: ['https://evil.example'] }).includes('capability'));
  assert.ok(codes({ outputs: { report: { type: 'nope' } } }).includes('port.type'));
  assert.ok(codes({ disclosure: undefined }).includes('disclosure'));
  assert.ok(codes({ limits: undefined }).includes('limits'));
});

test('partkit: the source checks reject fetch, env access and non-durable approvals', () => {
  const m = catalog.parts.find((p) => p.id === 'keys.revoke@1.0.0')!;
  const bad = `export const x: PartHandler = async (inputs, ctx) => { const k = process.env.KEY; await fetch('https://a.b'); await ctx.requestApproval({}); return { report: inputs.account + inputs.keys }; };`;
  const codes = lintPartSource(bad, m).filter((x) => x.severity === 'error').map((x) => x.code);
  for (const c of ['fetch', 'forbidden', 'quote', 'durable']) assert.ok(codes.includes(c), c);
  // the generated template is a valid starting point
  const t = lintPartSource(partTemplate(m), m).filter((x) => x.severity === 'error').map((x) => x.code);
  assert.deepEqual(t, []);
});

test('partkit: all 10 seed recipes can be composed from parts: job form + parts added in order, every wire available', () => {
  assert.equal(recipes.length, 10);
  for (const r of recipes) {
    const job = catalog.jobs!.find((j) => j.id === r.implements)!;
    assert.ok(job, `${r.meta.ticker} implements a job`);
    // the buyer form is the job's inputs (types and ids)
    assert.deepEqual(r.form.map((f) => [f.id, f.type]), Object.entries(job.inputs).map(([id, f]) => [id, f.type]), r.meta.ticker);
    // rebuild by adding each part with auto-wiring, then rewire any port whose seed wiring differs, from the offered sources
    let b: Recipe = { ...recipeFromJob(job, r.meta.creator), meta: r.meta, consts: r.consts };
    for (const n of r.nodes) {
      const added = addPartAutoWired(b, n.part, catalog, job);
      // the composer names nodes itself; map ours to the seed's id for comparison
      b = { ...added.recipe, nodes: added.recipe.nodes.map((x) => (x.id === added.nodeId ? { ...x, id: n.id, params: n.params } : x)), output: added.recipe.output.replace(`${added.nodeId}.`, `${n.id}.`) };
      for (const [port, ref] of Object.entries(n.inputs)) {
        const offered = sourcesFor(b, n.id, catalog).find((s) => s.ref === ref);
        assert.ok(offered, `${r.meta.ticker}: ${n.id}.${port} ← ${ref} is offered by the composer`);
        assert.ok(isAssignable(catalog.types, offered!.type, catalog.parts.find((p) => p.id === n.part)!.inputs[port].type));
      }
      b = { ...b, nodes: b.nodes.map((x) => (x.id === n.id ? { ...x, inputs: n.inputs } : x)) };
    }
    b = { ...b, output: r.output };
    assert.ok(validateRecipe(b, catalog).ok, r.meta.ticker);
  }
});

test('partkit: auto-wiring alone produces a valid recipe for every seed recipe and picks its result', () => {
  let same = 0, total = 0;
  for (const r of recipes) {
    const job = catalog.jobs!.find((j) => j.id === r.implements)!;
    let b: Recipe = { ...recipeFromJob(job, 'x.testnet'), meta: r.meta, consts: r.consts };
    const ids: string[] = [];
    for (const n of r.nodes) { const a = addPartAutoWired(b, n.part, catalog, job); b = a.recipe; ids.push(a.nodeId); }
    const v = validateRecipe(b, catalog);
    assert.ok(v.ok, `${r.meta.ticker}: ${v.diagnostics.map((d) => d.message).join('; ')}`);
    assert.ok(b.output, `${r.meta.ticker} has a result`);
    r.nodes.forEach((n, i) => { for (const [p, ref] of Object.entries(n.inputs)) { total++; const [h, ...t] = ref.split('.'); const idx = r.nodes.findIndex((x) => x.id === h); const mapped = idx >= 0 ? `${ids[idx]}.${t.join('.')}` : ref; if (b.nodes[i].inputs[p] === mapped) same++; } });
  }
  console.log(`# auto-wiring matched ${same}/${total} of the hand-made wires`);
  assert.ok(same / total > 0.9);
});
