/**
 * SRS-1 conformance of recipe composition: grammar, listing checks, value schemas, type variables, conditions, alternatives, on_error,
 * declared billing, the sorted public parts list and the runner's behaviour on skipped and failing nodes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { validateRecipe, publicListing, compatibleSwaps, checkValue, joinTypes, evalWhen, type Catalog, type Recipe, type PartManifest } from '../core/src/srs.js';
import { execute, HANDLERS } from '../runner/src/executor.js';
import { validatePartManifest } from '../core/src/partkit.js';
import type { PartHandler } from '../runner/src/types.js';

const json = (p: string) => JSON.parse(readFileSync(new URL('../' + p, import.meta.url), 'utf8'));
const catalog = json('standard/parts.json') as Catalog;
const example = (t: string) => json(`standard/examples/${t}.json`) as Recipe;
const seed = (t: string) => json(`seed/recipes/${t}.json`) as Recipe;
const codes = (r: Recipe, cat: Catalog = catalog) => validateRecipe(r, cat).diagnostics.map((d) => d.code);
const errors = (r: Recipe, cat: Catalog = catalog) => validateRecipe(r, cat).diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);

// ---- a small catalog of test parts (pure stubs) to exercise the format itself
const stub = (id: string, inputs: PartManifest['inputs'], outputs: PartManifest['outputs'], extra: Partial<PartManifest> = {}): PartManifest => ({
  id, name: id, category: 'transform', author: 'test.testnet', summary: 'a test part used by the SRS-1 conformance suite', inputs, outputs, params: {}, capabilities: [], fee_per_call: '1000',
  disclosure: { model: { kind: 'none' }, instructions: 'open', harness: 'open', verification: 'open', runtime: 'bundled' }, limits: { max_ms: 2000, max_http_calls: 0, max_model_calls: 0, max_output_bytes: 10000 }, ...extra,
});
const T: Catalog = {
  srs: '1.0', kind: 'part-catalog',
  types: catalog.types,
  parts: [
    stub('t.pick@1.0.0', { a: { type: 'T' }, b: { type: 'T' } }, { out: { type: 'T' } }, { type_params: { T: { extends: null } } }),
    stub('t.addr-pick@1.0.0', { a: { type: 'T' }, b: { type: 'T' } }, { out: { type: 'T' } }, { type_params: { T: { extends: 'address.near' } } }),
    stub('t.need-fresh@1.0.0', { to: { type: 'address.near.fresh' } }, { report: { type: 'report' } }),
    stub('t.verdict@1.0.0', { account: { type: 'near.account' } }, { verdict: { type: 'contract.verdict' } }),
    stub('t.report@1.0.0', { verdict: { type: 'contract.verdict' } }, { report: { type: 'report' } }),
    stub('t.second@1.0.0', { account: { type: 'near.account' } }, { verdict: { type: 'contract.verdict' } }),
    stub('t.flaky@1.0.0', { account: { type: 'near.account' } }, { verdict: { type: 'contract.verdict' } }),
    stub('t.liar@1.0.0', { account: { type: 'near.account' } }, { verdict: { type: 'contract.verdict' } }),
    stub('t.leaky@1.0.0', { account: { type: 'near.account' } }, { verdict: { type: 'contract.verdict' } }, { capabilities: ['net:collector.example.com'], params: { prompt: { type: 'string', secret: true } } }),
    stub('t.signer@1.0.0', { account: { type: 'near.account' } }, { receipts: { type: 'swap.receipts' } }, { category: 'action', capabilities: ['wallet:approve'] }),
  ],
};
const base = (nodes: Recipe['nodes'], output: Recipe['output'], over: Partial<Recipe> = {}): Recipe => ({
  srs: '1.0', kind: 'recipe', meta: { ticker: 'TEST', name: 'test', creator: 'chef.testnet', description: '' },
  form: [{ id: 'wallet', label: 'Wallet', type: 'near.account', required: true }, { id: 'to', label: 'To', type: 'address.near' }],
  nodes, output, listing: { price_per_run: '100000' }, ...over,
});

test('SRS-1: every seed recipe and every spec example validates', () => {
  for (const f of readdirSync(new URL('../seed/recipes', import.meta.url))) assert.ok(validateRecipe(seed(f.replace('.json', '')), catalog).ok, f);
  for (const f of readdirSync(new URL('../standard/examples', import.meta.url))) {
    const v = validateRecipe(example(f.replace('.json', '')), catalog);
    assert.ok(v.ok, f + ': ' + JSON.stringify(v.diagnostics.filter((d) => d.severity === 'error')));
  }
});

test('SRS-1 grammar: ids that would break references, unknown or ill-typed constants, impossible listings', () => {
  const r = seed('CLNP');
  assert.ok(errors({ ...r, nodes: r.nodes.map((n) => (n.id === 'dust' ? { ...n, id: 'du.st' } : n)) }).includes('node.id'));
  assert.ok(errors({ ...r, form: r.form.map((f, i) => (i === 0 ? { ...f, id: 'Wallet!' } : f)) }).includes('form.id'));
  assert.ok(errors({ ...seed('EXIT'), consts: { usdc: { type: 'asset.idd', value: 'x' } } }).includes('const.type'));
  assert.ok(errors({ ...seed('EXIT'), consts: { usdc: { type: 'asset.id', value: 'not an asset' } } }).includes('const.value'));
  for (const [listing, code] of [[{ price_per_run: '0' }, 'listing.price'], [{ price_per_run: '10', reserve_bps: 12000 }, 'listing.reserve'], [{ price_per_run: '10', pricing: { price_floor: '20', price_ceiling: '30', target_runs: 1 } }, 'listing.pricing'], [{ price_per_run: '10', settle_mode: 'sometimes' }, 'listing.settle_mode']] as const)
    assert.ok(errors({ ...r, listing: listing as never }).includes(code), code);
});

test('a recipe declares the spec version it was written for', () => {
  assert.deepEqual([...new Set(errors({ ...example('ESCL'), srs: '2.0' as never }))], ['srs.version']);
});

test('value schemas: a type checks its own schema and every parent schema', () => {
  assert.deepEqual(checkValue(catalog.types, 'address.near.fresh', 'abc.near'), []);
  assert.ok(checkValue(catalog.types, 'address.near.fresh', 'Not An Address').length, 'the parent schema applies to the subtype');
  assert.deepEqual(checkValue(catalog.types, 'contract.verdict', { risk: 'high', reasons: [], source: 'rules' }), []);
  assert.match(checkValue(catalog.types, 'contract.verdict', { risk: 'catastrophic', reasons: [], source: 'rules' }).join(), /one of low, medium, high/);
  assert.match(checkValue(catalog.types, 'token.holdings', [{ assetId: 'nep141:x', symbol: 'X', amount: 1.5, decimals: 6, usd: 1 }]).join(), /\$\[0\]\.amount/);
  for (const [k, t] of Object.entries(catalog.types)) assert.ok(t.schema || t.extends, `${k} declares a schema or inherits one`);
});

test('type variables bind to the most specific common type of their inputs, within their bound', () => {
  assert.equal(joinTypes(catalog.types, ['address.near.fresh', 'address.near']), 'address.near');
  assert.equal(joinTypes(catalog.types, ['address.near.fresh', 'address.near.fresh']), 'address.near.fresh');
  assert.equal(joinTypes(catalog.types, ['near.account', 'usd']), null);
  const fresh = { id: 'fresh', part: 'addr.fresh-check@1.0.0', inputs: { recipient: 'form.to' }, params: {} };
  const cat: Catalog = { ...T, parts: [...T.parts, catalog.parts.find((p) => p.id === 'addr.fresh-check@1.0.0')!] };
  // pick(fresh, fresh) is fresh, so it can feed a port that needs a fresh address
  const ok = base([fresh, { id: 'pick', part: 't.pick@1.0.0', inputs: { a: 'fresh.fresh', b: 'fresh.fresh' }, params: {} }, { id: 'use', part: 't.need-fresh@1.0.0', inputs: { to: 'pick.out' }, params: {} }], 'use.report', { form: [{ id: 'to', label: 'To', type: 'address.near' }] });
  const v = validateRecipe(ok, cat);
  assert.ok(v.ok, JSON.stringify(v.diagnostics)); assert.equal(v.portTypes['pick.out'], 'address.near.fresh');
  // pick(fresh, raw) is only address.near: it can no longer feed that port
  const widened = { ...ok, nodes: ok.nodes.map((n) => (n.id === 'pick' ? { ...n, inputs: { a: 'fresh.fresh', b: 'form.to' } } : n)) };
  assert.ok(errors(widened, cat).includes('port.type'));
  assert.ok(errors(base([{ id: 'pick', part: 't.pick@1.0.0', inputs: { a: 'form.wallet', b: 'form.to' }, params: {} }], 'pick.out'), cat).includes('port.generic'));
  assert.ok(errors(base([{ id: 'pick', part: 't.addr-pick@1.0.0', inputs: { a: 'form.wallet', b: 'form.wallet' }, params: {} }], 'pick.out'), cat).includes('port.type'), 'bound: T extends address.near');
});

test('conditions are checked against the schema of what they read', () => {
  const r = (when: object) => base([{ id: 'v', part: 't.verdict@1.0.0', inputs: { account: 'form.wallet' }, params: {} }, { id: 'rep', part: 't.report@1.0.0', inputs: { verdict: 'v.verdict' }, params: {}, when: when as never }], 'rep.report');
  assert.deepEqual(errors(r({ ref: 'v.verdict', match: { risk: ['high'] } }), T), []);
  assert.ok(errors(r({ ref: 'v.verdict', match: { danger: ['high'] } }), T).includes('when.field'));
  assert.ok(errors(r({ ref: 'v.verdict', match: { risk: ['catastrophic'] } }), T).includes('when.value'));
  assert.ok(errors(r({ ref: 'v.verdict', some: { risk: ['high'] } }), T).includes('when.shape'), '"some" needs a list');
  assert.ok(errors(r({ ref: 'v.verdict', is: 'empty', match: { risk: ['high'] } }), T).includes('when.shape'), 'one test per condition');
  assert.ok(errors(r({ ref: 'nope.verdict' }), T).includes('when.ref'));
  assert.equal(evalWhen({ ref: 'x', some: { action: ['revoke'] } }, [{ action: 'keep' }, { action: 'revoke' }]), true);
  assert.equal(evalWhen({ ref: 'x', is: 'empty' }, undefined), true, 'a skipped node reads as empty');
  assert.equal(evalWhen({ ref: 'x', match: { risk: ['high'] }, not: true }, undefined), true);
});

test('on_error "skip" is refused on parts that ask the buyer to sign', () => {
  const r = base([{ id: 's', part: 't.signer@1.0.0', inputs: { account: 'form.wallet' }, params: {}, on_error: 'skip' }], 's.receipts');
  assert.ok(errors(r, T).includes('node.on_error'));
});

test('privacy warnings: branches that settlements would reveal, secret params that can leave the runner, results that may be absent', () => {
  const branchy = base([
    { id: 'v', part: 't.verdict@1.0.0', inputs: { account: 'form.wallet' }, params: {} },
    { id: 'second', part: 't.second@1.0.0', inputs: { account: 'form.wallet' }, params: {}, when: { ref: 'v.verdict', match: { risk: ['high'] } } },
    { id: 'rep', part: 't.report@1.0.0', inputs: { verdict: ['second.verdict', 'v.verdict'] }, params: {} },
  ], 'rep.report');
  assert.ok(!codes(branchy, T).includes('bill.reveals-branch'), 'default billing is declared: every run pays the same parts');
  assert.ok(codes({ ...branchy, listing: { price_per_run: '1', bill: 'executed' } }, T).includes('bill.reveals-branch'));
  assert.deepEqual(validateRecipe(branchy, T).optional, ['second']);
  assert.ok(!codes(branchy, T).includes('recipe.output-optional'), 'the fallback keeps the result present');
  assert.ok(codes({ ...branchy, output: 'second.verdict' }, T).includes('recipe.output-optional'));
  const leaky = base([{ id: 'l', part: 't.leaky@1.0.0', inputs: { account: 'form.wallet' }, params: { prompt: 'my edge' } }], 'l.verdict');
  assert.ok(codes(leaky, T).includes('param.secret-egress'));
  assert.ok(!codes(seed('CLNP')).includes('param.secret-egress'), 'attested inference and public NEAR data do not warn');
});

test('the public listing is a sorted multiset of parts, and its interface hash does not depend on execution order', () => {
  const r = seed('TRCH');
  const l = publicListing(r, catalog);
  assert.deepEqual(l.parts, [...l.parts].sort());
  assert.equal(l.parts.filter((p) => p === 'intents.confidential-swap@1.0.0').length, 2, 'a multiset: repeated parts are listed, and billed, per node');
  const reordered = { ...r, nodes: [...r.nodes].reverse() };
  assert.equal(publicListing(reordered, catalog).interface_hash, l.interface_hash);
});

test('drop-in swaps still work across alternatives and conditions', () => {
  assert.deepEqual(compatibleSwaps(example('ESCL'), 'judge', catalog).map((p) => p.id), ['rules.contract-risk@1.0.0']);
  assert.deepEqual(compatibleSwaps(example('FALL'), 'ai', catalog).map((p) => p.id).sort(), ['ai.spam-shield-pro@1.0.0', 'rules.spam-shield@1.0.0']);
});

// ---- the runner
const handlers: Record<string, PartHandler> = {
  't.verdict@1.0.0': async (i) => ({ verdict: { risk: String(i.account).startsWith('bad') ? 'high' : 'low', reasons: [], source: 'rules' } }),
  't.second@1.0.0': async () => ({ verdict: { risk: 'high', reasons: ['second opinion'], source: 'nearai-tee' } }),
  't.report@1.0.0': async (i) => { const v = i.verdict as { risk: string; source: string }; return { report: { title: `verdict: ${v.risk} (${v.source})` } }; },
  't.flaky@1.0.0': async () => { throw new Error('provider unavailable'); },
  't.liar@1.0.0': async () => ({ verdict: { risk: 'fine, trust me', reasons: [], source: 'rules' } }),
};
Object.assign(HANDLERS, handlers);
const run = (r: Recipe, wallet: string) => execute('run-1', r, { wallet }, { catalog: T, emit: () => {}, rewrites: new Map(), secrets: {}, requestApproval: async () => ({ approved: false, txHashes: [] }) });
const oneField = { form: [{ id: 'wallet', label: 'Wallet', type: 'near.account', required: true }] };
const escalate = base([
  { id: 'v', part: 't.verdict@1.0.0', inputs: { account: 'form.wallet' }, params: {} },
  { id: 'second', part: 't.second@1.0.0', inputs: { account: 'form.wallet' }, params: {}, when: { ref: 'v.verdict', match: { risk: ['high'] } } },
  { id: 'rep', part: 't.report@1.0.0', inputs: { verdict: ['second.verdict', 'v.verdict'] }, params: {} },
], 'rep.report', oneField);

test('runner: a false condition skips the node, the first present alternative is used, and every declared part is billed', async () => {
  const calm = await run(escalate, 'good.near');
  assert.ok(calm.ok, calm.error);
  assert.deepEqual(calm.skipped, ['second']);
  assert.deepEqual(calm.output, { title: 'verdict: low (rules)' });
  assert.deepEqual(calm.partsUsed, ['t.report@1.0.0', 't.second@1.0.0', 't.verdict@1.0.0'], 'declared billing: the settlement is the same on every branch');
  const alarmed = await run(escalate, 'bad.near');
  assert.deepEqual(alarmed.skipped, []);
  assert.deepEqual(alarmed.output, { title: 'verdict: high (nearai-tee)' });
  assert.deepEqual(alarmed.partsUsed, calm.partsUsed);
  const executed = await run({ ...escalate, listing: { price_per_run: '1', bill: 'executed' } }, 'good.near');
  assert.deepEqual(executed.partsUsed, ['t.report@1.0.0', 't.verdict@1.0.0']);
});

test('runner: on_error "skip" falls back; without it a failing part fails the run', async () => {
  const withFallback = base([
    { id: 'ai', part: 't.flaky@1.0.0', inputs: { account: 'form.wallet' }, params: {}, on_error: 'skip' },
    { id: 'rules', part: 't.verdict@1.0.0', inputs: { account: 'form.wallet' }, params: {}, when: { ref: 'ai.verdict', is: 'empty' } },
    { id: 'rep', part: 't.report@1.0.0', inputs: { verdict: ['ai.verdict', 'rules.verdict'] }, params: {} },
  ], 'rep.report', oneField);
  const r = await run(withFallback, 'good.near');
  assert.ok(r.ok, r.error); assert.deepEqual(r.skipped, ['ai']); assert.deepEqual(r.output, { title: 'verdict: low (rules)' });
  const strict = await run({ ...withFallback, nodes: withFallback.nodes.map((n) => ({ ...n, on_error: undefined })) }, 'good.near');
  assert.equal(strict.ok, false); assert.match(strict.error!, /provider unavailable/); assert.deepEqual(strict.partsUsed, [], 'a failed run bills nothing: the buyer is refunded');
});

test('runner: a part output that is not a value of its type fails the run before anything downstream sees it', async () => {
  const r = base([{ id: 'v', part: 't.liar@1.0.0', inputs: { account: 'form.wallet' }, params: {} }, { id: 'rep', part: 't.report@1.0.0', inputs: { verdict: 'v.verdict' }, params: {} }], 'rep.report', oneField);
  const out = await run(r, 'good.near');
  assert.equal(out.ok, false); assert.match(out.error!, /not a contract\.verdict/);
});

test('runner: no result is a failed run, and the output hash is salted so a short result cannot be guessed', async () => {
  const noResult = await run({ ...escalate, output: 'second.verdict' }, 'good.near');
  assert.equal(noResult.ok, false); assert.match(noResult.error!, /no result/);
  const a = await run(escalate, 'good.near'), b = await run(escalate, 'good.near');
  assert.deepEqual(a.output, b.output); assert.notEqual(a.outputHash, b.outputHash);
});

test('part manifests: type variables must be single capitals with known bounds, and bound by an input', () => {
  const ok = T.parts.find((p) => p.id === 't.pick@1.0.0')!;
  const errs = (m: PartManifest) => validatePartManifest(m, T).filter((d) => d.severity === 'error').map((d) => d.code);
  assert.deepEqual(errs({ ...ok, id: 'util.pick@1.0.0' }), []);
  assert.ok(errs({ ...ok, id: 'util.make@1.0.0', inputs: { a: { type: 'near.account' } } }).includes('type_params.unbound'));
  assert.ok(errs({ ...ok, id: 'util.pick@1.0.0', type_params: { T: { extends: 'no.such.type' } } }).includes('type_params.bound'));
  assert.ok(errs({ ...ok, id: 'util.pick@1.0.0', type_params: { Item: { extends: null } } }).includes('type_params.name'));
});

test('a fallback that runs exactly when its primary is absent keeps the result present (no false warning)', () => {
  const v = validateRecipe(example('FALL'), catalog);
  assert.deepEqual(v.optional, ['ai', 'rules']);
  assert.ok(!v.diagnostics.some((d) => d.code === 'recipe.output-optional'));
});

test('proof types: a fresh address cannot be typed by the buyer or written in as a constant, only proven by a part', () => {
  const r = seed('EXIT');
  assert.ok(errors({ ...r, form: r.form.map((f) => (f.id === 'recipient' ? { ...f, type: 'address.near.fresh' } : f)) }).includes('type.proof'));
  assert.ok(errors({ ...r, consts: { ...r.consts, to: { type: 'address.near.fresh', value: 'abc.near' } } }).includes('type.proof'));
});

test('if / else: complementary conditions on the same value keep the result present', () => {
  const ifElse = base([
    { id: 'v', part: 't.verdict@1.0.0', inputs: { account: 'form.wallet' }, params: {} },
    { id: 'hi', part: 't.second@1.0.0', inputs: { account: 'form.wallet' }, params: {}, when: { ref: 'v.verdict', match: { risk: ['high', 'medium'] } } },
    { id: 'lo', part: 't.verdict@1.0.0', inputs: { account: 'form.wallet' }, params: {}, when: { ref: 'v.verdict', match: { risk: ['medium', 'high'] }, not: true } },
    { id: 'rep', part: 't.report@1.0.0', inputs: { verdict: ['hi.verdict', 'lo.verdict'] }, params: {} },
  ], 'rep.report');
  assert.ok(!codes(ifElse, T).includes('recipe.output-optional'));
  const notComplementary = { ...ifElse, nodes: ifElse.nodes.map((n) => (n.id === 'lo' ? { ...n, when: { ref: 'v.verdict', match: { risk: ['low'] } } } : n)) };
  assert.ok(codes(notComplementary, T).includes('recipe.output-optional'), 'different tests may both be false');
});
