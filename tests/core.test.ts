import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { hexToBytes, bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  settlementSplit, LocalLedger, checkpointMessage, RUN_TIMEOUT_NS, type Outcome, runReportMessage, quoteMessage, withdrawalRisk, labelsFromParts, measuresValue, jobHash, base64, seal, open, sealedHash,
  validateRecipe, compatibleSwaps, swapPart, publicListing, recoverSigner, signEip191, addressFromPublicKey,
  verifyChat, sha256Hex, OneClick, runPaymentQuoteRequest, USDC_NEAR, reportData, verifyRunnerAttestation,
  bondLock, bondRelease, bondSettle, bondDeposit, nextPrice, creatorKeyFromSignature, creatorKeyMessage, demoWalletSign,
  type Catalog, type Recipe, type RunnerAttestation,
} from '../core/src/index.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

const json = (p: string) => JSON.parse(readFileSync(new URL('../' + p, import.meta.url), 'utf8'));
const catalog = json('standard/parts.json') as Catalog;
const recipe = (t: string) => json(`seed/recipes/${t}.json`) as Recipe;

test('settlement vectors match the contract spec (shared with Rust tests)', () => {
  const v = json('contracts/test-vectors/settlement.json');
  for (const c of v.cases) {
    const s = settlementSplit({ price: BigInt(c.input.price), protocolFeeBps: c.input.protocol_fee_bps, runnerFee: BigInt(c.input.runner_fee), partFees: c.input.part_fees.map(BigInt), reserveBps: c.input.reserve_bps });
    const e = c.expected;
    assert.deepEqual([s.protocol, s.runner, s.remainder, s.reserve, s.creator].map(String), [e.protocol, e.runner, e.remainder, e.reserve, e.creator], c.name);
    assert.deepEqual(s.parts.map(String), e.parts, c.name);
    const total = s.protocol + s.runner + s.parts.reduce((a, b) => a + b, 0n) + s.reserve + s.creator;
    assert.equal(total, BigInt(c.input.price), `${c.name}: every unit is paid out`);
  }
});

function keyring() {
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
  return { kp, pk: 'ed25519:' + bs58.encode(kp.publicKey) };
}

function setupLedger(o: { price?: string; reserve?: number; fee?: number; runnerFee?: string; partFees?: string[]; settleMode?: 'final' | 'checkpoint' } = {}) {
  let now = 1_000_000_000n;
  const L = new LocalLedger({ contractId: 'srs.testnet', owner: 'owner.testnet', paymentToken: 'usdc.testnet', protocolAccount: 'treasury.testnet', protocolFeeBps: o.fee ?? 200, clock: () => now });
  const { kp, pk } = keyring();
  L.call('owner.testnet', (l) => l.add_runner({ id: 'runner.testnet', signing_pk: pk, enc_pk_hex: 'ab'.repeat(32), codehash: 'c0de', fee_per_run: o.runnerFee ?? '30000' }));
  const fees = o.partFees ?? ['20000', '50000'];
  fees.forEach((f, i) => L.call(`author${i}.testnet`, (l) => l.register_part({ id: `b${i}@1.0.0`, version: '1.0.0', fee_per_call: f, manifest_hash: 'h' })));
  L.call('creator.testnet', (l) => l.publish_recipe({ id: 'TEST', name: 'Test', sealed_hash: 'aa', runner_id: 'runner.testnet', parts: fees.map((_, i) => `b${i}@1.0.0`), price_per_run: o.price ?? '750000', reserve_bps: o.reserve ?? 0, settle_mode: o.settleMode }));
  const sign = (runId: string, outcome: Outcome, parts: string[], out = 'f'.repeat(64)) => base64.enc(nacl.sign.detached(utf8ToBytes(runReportMessage('srs.testnet', runId, 'TEST', outcome, out, '0', parts)), kp.secretKey));
  const pay = (runId: string, amount = o.price ?? '750000', buyer = 'bob.testnet') => L.call('usdc.testnet', (l) => l.ft_on_transfer({ sender_id: buyer, amount, msg: JSON.stringify({ action: 'run', recipe_id: 'TEST', run_id: runId, inputs_hash: '0'.repeat(64) }) }));
  const ckpt = (runId: string, seq: number, partsDone: string[], state = 'c'.repeat(64)) => L.call('relayer.testnet', (l) => l.checkpoint_run({ run_id: runId, seq, state_hash: state, parts_done: partsDone, signature: base64.enc(nacl.sign.detached(utf8ToBytes(checkpointMessage('srs.testnet', runId, 'TEST', seq, state, partsDone)), kp.secretKey)) }));
  return { L, sign, pay, ckpt, advance: (ns: bigint) => { now += ns; }, parts: fees.map((_, i) => `b${i}@1.0.0`) };
}

test('pay-per-run → signed report → every party credited in one settlement', () => {
  const { L, sign, pay, parts } = setupLedger({ reserve: 1000 });
  pay('r1', '800000'); // overpay: 50000 credited back
  assert.equal(L.balance_of('bob.testnet'), 50000n);
  const payouts = L.call('relayer.testnet', (l) => l.report_run({ run_id: 'r1', outcome: 'ok', parts_used: parts, output_hash: 'f'.repeat(64), delivered: '0', signature: sign('r1', 'ok', parts) }));
  assert.equal(payouts.length, 5);
  assert.equal(L.balance_of('treasury.testnet'), 15000n);
  assert.equal(L.balance_of('runner.testnet'), 30000n);
  assert.equal(L.balance_of('author0.testnet'), 20000n);
  assert.equal(L.balance_of('author1.testnet'), 50000n);
  // R = 750000-15000-30000-70000 = 635000 ; reserve 10% = 63500 to the guarantee deposit ; creator 571500
  assert.equal(L.balance_of('creator.testnet'), 571500n);
  assert.equal(L.recipes.get('TEST')!.bond_available, 63500n, 'the reserve grows the guarantee deposit');
  const ev = L.events.at(-1)!;
  assert.equal(ev.event, 'srs_settlement');
  assert.deepEqual((ev.data[0].payouts as { role: string }[]).map((p) => p.role), ['protocol', 'runner', 'part:b0@1.0.0', 'part:b1@1.0.0', 'creator']);
  assert.equal(String((ev.data[0] as { reserve: unknown }).reserve), '63500');
});

test('register_part and publish_recipe limit versions and hashes, and cap neither parts nor names (SRS-1 §12)', () => {
  const { L, parts } = setupLedger();
  const part = (id: string, version: string, manifest_hash: string) => L.call('author9.testnet', (l) => l.register_part({ id, version, fee_per_call: '1', manifest_hash }));
  assert.throws(() => part('big@1', 'v'.repeat(33), 'h'), /version must be 1..=32 bytes/);
  assert.throws(() => part('big@1', '1', 'h'.repeat(129)), /manifest_hash must be 1..=128 bytes/);
  const publish = (id: string, name: string, sealed_hash: string, ps: string[]) => L.call('creator.testnet', (l) => l.publish_recipe({ id, name, sealed_hash, runner_id: 'runner.testnet', parts: ps, price_per_run: '5000000' }));
  assert.throws(() => publish('LONG', 'n', 'h'.repeat(129), parts), /sealed_hash must be at most 128 bytes/);
  assert.throws(() => publish('LONG', 'n', 'é'.repeat(65), parts), /sealed_hash must be at most 128 bytes/, 'counted in UTF-8 bytes, as the contract does');
  publish('MANY', 'n'.repeat(200), 'h'.repeat(128), Array(40).fill(parts[0]));
  assert.equal(L.get_recipe('MANY')?.parts.length, 40);
});

test('forged or replayed reports are rejected; failure refunds; timeout reclaim', () => {
  const { L, sign, pay, parts, advance } = setupLedger();
  pay('r1');
  const wrong = base64.enc(nacl.sign.detached(utf8ToBytes('nope'), nacl.sign.keyPair().secretKey));
  assert.throws(() => L.call('x', (l) => l.report_run({ run_id: 'r1', outcome: 'ok', parts_used: parts, output_hash: 'f'.repeat(64), delivered: '0', signature: wrong })), /invalid runner signature/);
  assert.throws(() => L.call('x', (l) => l.report_run({ run_id: 'r1', outcome: 'ok', parts_used: [...parts, parts[0]], output_hash: 'f'.repeat(64), delivered: '0', signature: sign('r1', 'ok', [...parts, parts[0]]) })), /not part of recipe/);
  L.call('x', (l) => l.report_run({ run_id: 'r1', outcome: 'ok', parts_used: parts, output_hash: 'f'.repeat(64), delivered: '0', signature: sign('r1', 'ok', parts) }));
  assert.throws(() => L.call('x', (l) => l.report_run({ run_id: 'r1', outcome: 'ok', parts_used: parts, output_hash: 'f'.repeat(64), delivered: '0', signature: sign('r1', 'ok', parts) })), /not pending/);
  pay('r2');
  L.call('x', (l) => l.report_run({ run_id: 'r2', outcome: 'fail', parts_used: [], output_hash: 'f'.repeat(64), delivered: '0', signature: sign('r2', 'fail', []) }));
  assert.equal(L.balance_of('bob.testnet'), 750000n);
  pay('r3');
  assert.throws(() => L.call('bob.testnet', (l) => l.reclaim_run({ run_id: 'r3' })), /timeout/);
  advance(16n * 60n * 1_000_000_000n);
  L.call('bob.testnet', (l) => l.reclaim_run({ run_id: 'r3' }));
  assert.equal(L.balance_of('bob.testnet'), 1_500_000n);
  L.call('usdc.testnet', (l) => l.ft_on_transfer({ sender_id: 'solver.testnet', amount: '750000', msg: JSON.stringify({ action: 'run', recipe_id: 'TEST', run_id: 'r4', inputs_hash: '0'.repeat(64), on_behalf_of: 'bob.testnet' }) }));
  assert.equal(L.runs.get('r4')!.buyer, 'bob.testnet', 'solver pays on behalf of the buyer');
  assert.throws(() => L.call('evil.testnet', (l) => l.ft_on_transfer({ sender_id: 'bob.testnet', amount: '750000', msg: '{"action":"run"}' })), /only payment token/);
});

test('no investment features: the reserve is the creator\'s collateral, and share/trading messages are refused', () => {
  const { L, sign, pay, parts } = setupLedger({ reserve: 2500 });
  for (const id of ['r1', 'r2']) { pay(id); L.call('x', (l) => l.report_run({ run_id: id, outcome: 'ok', parts_used: parts, output_hash: 'f'.repeat(64), delivered: '0', signature: sign(id, 'ok', parts) })); }
  // R = 635000 per run ; reserve 25% = 158750 per run
  assert.equal(L.recipes.get('TEST')!.bond_available, 2n * 158750n);
  assert.throws(() => L.call('bob.testnet', (l) => l.withdraw_bond({ recipe_id: 'TEST', amount: '1' })), /creator only/, 'nobody else has a claim on it');
  L.call('creator.testnet', (l) => l.withdraw_bond({ recipe_id: 'TEST', amount: String(2n * 158750n) }));
  assert.equal(L.balance_of('creator.testnet'), 2n * 635000n, 'the creator keeps every unit of the remainder: paid now or held as collateral');
  // the removed v4 actions are gone from the message protocol and the method surface
  assert.throws(() => L.call('usdc.testnet', (l) => l.ft_on_transfer({ sender_id: 'a.testnet', amount: '100', msg: JSON.stringify({ action: 'bid', recipe_id: 'TEST', price: '10', qty: '10' }) })), /invalid msg/);
  for (const m of ['place_ask', 'clear_batch', 'cancel_order', 'transfer_shares', 'claim_dividends', 'shares_of', 'pending_dividends', 'get_book']) assert.equal((L as unknown as Record<string, unknown>)[m], undefined, m);
  assert.throws(() => setupLedger({ reserve: 10001 }), /reserve_bps must be <= 10000/);
});

test('sealed envelopes open only inside the runner and hash deterministically', () => {
  const runner = nacl.box.keyPair();
  const r = recipe('CLNP');
  const env = seal(r, bytesToHex(runner.publicKey), 'recipe');
  assert.ok(!env.ct.includes('Clean up'));
  assert.deepEqual(open(env, runner.secretKey), r);
  assert.throws(() => open(env, nacl.box.keyPair().secretKey), /decryption failed/);
  const tampered = { ...env, ct: base64.enc(base64.dec(env.ct).map((b, i) => (i === 5 ? b ^ 1 : b))) };
  assert.throws(() => open(tampered, runner.secretKey), /decryption failed/);
  assert.equal(sealedHash(env), sealedHash(JSON.parse(JSON.stringify(env))));
  assert.notEqual(sealedHash(env), sealedHash(seal(r, bytesToHex(runner.publicKey), 'recipe')), 'random salt + nonce');
});

test('SRS-1: seed recipes validate; listing hides wiring and secret params', () => {
  for (const t of ['CLNP', 'SWPR', 'EXIT', 'SAFE']) {
    const v = validateRecipe(recipe(t), catalog);
    assert.ok(v.ok, t + ': ' + JSON.stringify(v.diagnostics));
  }
  const l = publicListing(recipe('CLNP'), catalog);
  const s = JSON.stringify(l);
  assert.ok(!s.includes('token-safety classifier'), 'secret policy prompt must not leak');
  assert.ok(!s.includes('slippage_bps'));
  assert.deepEqual(l.parts, ['addr.fresh-check@1.0.0', 'ai.spam-shield@1.1.0', 'filter.dust@1.0.0', 'intents.confidential-swap@1.0.0', 'near.wallet-scanner@1.1.0'], 'a sorted multiset: execution order stays sealed');
});

test('SRS-1: type errors, cycles and unwired ports are caught', () => {
  const r = recipe('CLNP');
  const badType = { ...r, nodes: r.nodes.map((n) => (n.id === 'swap' ? { ...n, inputs: { ...n.inputs, to: 'form.recipient' } } : n)) };
  const v1 = validateRecipe(badType, catalog);
  assert.ok(!v1.ok); assert.ok(v1.diagnostics.some((d) => d.code === 'port.type' && d.node === 'swap'));
  const cyc = { ...r, nodes: r.nodes.map((n) => (n.id === 'scan' ? { ...n, inputs: { account: 'form.wallet', extra: 'swap.receipts' } } : n.id === 'shield' ? { ...n, inputs: { holdings: 'dust.dust' } } : n)) };
  assert.ok(validateRecipe(cyc, catalog).diagnostics.some((d) => d.code === 'graph.cycle'));
  const unwired = { ...r, nodes: r.nodes.map((n) => (n.id === 'dust' ? { ...n, inputs: { holdings: 'shield.clean' } } : n)) };
  assert.ok(validateRecipe(unwired, catalog).diagnostics.some((d) => d.code === 'port.unwired'));
});

test('SRS-1: drop-in swaps respect subtyping', () => {
  const clnp = recipe('CLNP');
  assert.deepEqual(compatibleSwaps(clnp, 'swap', catalog).map((b) => b.id), ['intents.public-swap@1.0.0', 'intents.atomic-swap@1.0.0'], 'the atomic bundle is a drop-in alternative');
  assert.deepEqual(compatibleSwaps(clnp, 'shield', catalog).map((b) => b.id), ['ai.spam-shield-pro@1.0.0', 'rules.spam-shield@1.0.0']);
  assert.deepEqual(compatibleSwaps(recipe('SWPR'), 'swap', catalog).map((b) => b.id), [], 'public→confidential needs a fresh address');
  const swapped = swapPart(clnp, 'shield', 'rules.spam-shield@1.0.0', catalog);
  assert.ok(validateRecipe(swapped, catalog).ok);
  assert.equal(validateRecipe(swapped, catalog).partFees, 20000n + 10000n + 10000n + 10000n + 50000n);
});

test('EIP-191 recovery matches the well-known key-1 address', () => {
  const sk = hexToBytes('0'.repeat(63) + '1');
  assert.equal(addressFromPublicKey(secp256k1.getPublicKey(sk)), '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf');
  const sig = signEip191('hello', sk);
  assert.equal(recoverSigner('hello', sig), '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf');
  const req = '{"a":1}', res = '{"b":2}';
  const text = `Qwen/Qwen3:${sha256Hex(req)}:${sha256Hex(res)}`;
  const ok = verifyChat(req, res, { text, signature: signEip191(text, sk), signing_address: '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf', signing_algo: 'ecdsa' }, '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf');
  assert.ok(ok.ok);
  assert.ok(!verifyChat(req, res + ' ', { text, signature: signEip191(text, sk), signing_address: ok.recovered, signing_algo: 'ecdsa' }, ok.recovered).ok, 'tampered response');
});

test('1Click fixture: EXACT_OUTPUT run payment delivers exact price to the contract with msg', async () => {
  const oc = new OneClick({ mode: 'fixture', fixtureTokens: json('fixtures/oneclick-tokens.json').tokens });
  const req = runPaymentQuoteRequest({ originAsset: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', refundTo: '0xabc', contractId: 'srs.testnet', price: '750000', msg: '{"action":"run"}' });
  assert.equal(req.destinationAsset, USDC_NEAR); assert.equal(req.customRecipientMsg, '{"action":"run"}');
  const q = await oc.quote(req);
  assert.equal(q.quote.amountOut, '750000');
  assert.ok(BigInt(q.quote.amountIn) > 750000n, 'buyer pays fees on top');
  assert.ok(q.quote.depositAddress?.match(/^[0-9a-f]{64}$/));
  assert.equal((await oc.status(q.quote.depositAddress!)).status, 'PENDING_DEPOSIT');
});

test('runner attestation: binding, possession, on-chain key match; missing hardware is reported, not hidden', () => {
  const sk = nacl.sign.keyPair();
  const a: Omit<RunnerAttestation, 'report_data' | 'self_sig'> = { v: 'srs-attest-v1', tee: 'local-dev', runner_id: 'r', signing_pk: 'ed25519:' + bs58.encode(sk.publicKey), enc_pk_hex: 'cd'.repeat(32), codehash: 'abc', compose_hash: 'def', nonce: 'n1', quote: null, issued_at: '' };
  const rd = reportData(a);
  const full: RunnerAttestation = { ...a, report_data: rd, self_sig: base64.enc(nacl.sign.detached(utf8ToBytes(rd), sk.secretKey)) };
  const v = verifyRunnerAttestation(full, { nonce: 'n1', signing_pk: a.signing_pk, enc_pk_hex: a.enc_pk_hex, codehash: 'abc' });
  assert.ok(v.ok); assert.equal(v.hardware, false);
  assert.ok(v.checks.some((c) => c.id === 'tdx.quote' && c.status === 'skip'));
  assert.ok(!verifyRunnerAttestation(full, { nonce: 'n2' }).ok, 'replayed nonce');
  assert.ok(!verifyRunnerAttestation({ ...full, enc_pk_hex: 'ee'.repeat(32) }, { nonce: 'n1' }).ok, 'swapped encryption key breaks binding');
});

test('NEAR Intents: business-rule failures with on_behalf_of credit the buyer instead of bouncing to the solver', () => {
  const { L } = setupLedger();
  const send = (msg: object, amount = '750000') => L.call('usdc.testnet', (l) => l.ft_on_transfer({ sender_id: 'solver.testnet', amount, msg: JSON.stringify(msg) }));
  assert.equal(send({ action: 'run', recipe_id: 'NOPE', run_id: 'r1', inputs_hash: '0'.repeat(64), on_behalf_of: 'bob.testnet' }), '0');
  assert.equal(L.balance_of('bob.testnet'), 750000n);
  assert.equal(L.events.at(-1)!.event, 'transfer_rejected');
  assert.equal((L.events.at(-1)!.data[0] as { reason: string }).reason, 'unknown recipe');
  send({ action: 'run', recipe_id: 'TEST', run_id: 'bad|id', inputs_hash: '0'.repeat(64), on_behalf_of: 'bob.testnet' });
  assert.equal((L.events.at(-1)!.data[0] as { reason: string }).reason, 'run_id must match ^[A-Za-z0-9_-]{1,64}$');
  assert.throws(() => send({ action: 'run', recipe_id: 'NOPE', run_id: 'r2', inputs_hash: '0'.repeat(64) }), /unknown recipe/, 'without on_behalf_of the token refunds the sender');
  send({ action: 'run', recipe_id: 'TEST', run_id: 'r3', inputs_hash: '0'.repeat(64), on_behalf_of: 'bob.testnet' });
  assert.equal(L.runs.get('r3')!.sealed_hash, 'aa', 'run snapshots the sealed hash it paid for');
});

test('every mirror event has exactly the fields documented for the contract (docs/CONTRACT_EVENTS.md)', () => {
  const doc = readFileSync(new URL('../docs/CONTRACT_EVENTS.md', import.meta.url), 'utf8');
  const spec = new Map<string, string[]>();
  for (const line of doc.split('\n')) {
    const m = line.match(/^\| `([a-z_]+)` \|[^|]*\|(.*)\|\s*$/);
    if (!m) continue;
    const code = [...m[2].matchAll(/`([^`]*)`/g)].map((x) => x[1]).join(", ").replace(/\[[^\]]*\]/g, "");
    const fields = [...code.matchAll(/(?<![A-Za-z_])([a-z_]+): /g)].map((x) => x[1]);
    if (fields.length) spec.set(m[1], [...new Set(fields)].sort());
  }
  const { L, sign, pay, parts, advance, ckpt } = setupLedger();
  pay('r1'); L.call('x', (l) => l.report_run({ run_id: 'r1', outcome: 'ok', parts_used: parts, output_hash: 'f'.repeat(64), delivered: '0', signature: sign('r1', 'ok', parts) }));
  pay('r2'); L.call('x', (l) => l.report_run({ run_id: 'r2', outcome: 'fail', parts_used: [], output_hash: 'f'.repeat(64), delivered: '0', signature: sign('r2', 'fail', []) }));
  L.call('creator.testnet', (l) => l.update_sealed({ id: 'TEST', sealed_hash: 'b'.repeat(64) }));
  L.call('creator.testnet', (l) => l.cancel_update({ id: 'TEST' }));
  L.call('creator.testnet', (l) => l.update_sealed({ id: 'TEST', sealed_hash: 'd'.repeat(64) }));
  advance(L.updateDelayNs);
  L.call('anyone.testnet', (l) => l.apply_update({ id: 'TEST' }));
  pay('r9'); ckpt('r9', 1, []);
  L.call('creator.testnet', (l) => l.withdraw({}));
  L.call('usdc.testnet', (l) => l.ft_on_transfer({ sender_id: 's', amount: '1', msg: JSON.stringify({ action: 'run', recipe_id: 'X', run_id: 'q', inputs_hash: '0'.repeat(64), on_behalf_of: 'b' }) }));
  L.call('usdc.testnet', (l) => l.ft_on_transfer({ sender_id: 'creator.testnet', amount: '100', msg: JSON.stringify({ action: 'bond', recipe_id: 'TEST' }) }));
  L.call('creator.testnet', (l) => l.withdraw_bond({ recipe_id: 'TEST', amount: '40' }));
  L.call('creator.testnet', (l) => l.set_pricing({ id: 'TEST', pricing: { price_floor: '500000', price_ceiling: '1000000', target_runs: 1 } }));
  advance(3n * L.pricePeriodNs);
  L.call('keeper.testnet', (l) => l.update_price({ id: 'TEST' }));
  const seen = new Set<string>();
  for (const e of L.events) {
    const want = spec.get(e.event);
    assert.ok(want, `event ${e.event} is not in the contract spec`);
    assert.deepEqual(Object.keys(e.data[0]).sort(), want, `fields of ${e.event}`);
    seen.add(e.event);
  }
  const missed = [...spec.keys()].filter((k) => !seen.has(k));
  assert.ok(seen.has('price_updated') && seen.has('pricing_updated'), 'v6 pricing events exercised');
  assert.ok(seen.size >= 16, `covered ${seen.size} event types; not exercised: ${missed.join(', ')}`);
  console.log(`   event parity: ${seen.size}/${spec.size} event types exercised; not here: ${missed.join(', ')}`);
});

const INPUTS_HASH = '0'.repeat(64);
function quoted(o: { price?: string; bond: string; promised: string; cover?: string; expected?: string; expiresIn?: bigint; signer?: nacl.SignKeyPair; buyer?: string; sealed?: string }) {
  const t = setupLedger();
  const { kp } = keyring();
  if (o.bond !== '0') t.L.call('usdc.testnet', (l) => l.ft_on_transfer({ sender_id: 'creator.testnet', amount: o.bond, msg: JSON.stringify({ action: 'bond', recipe_id: 'TEST' }) }));
  const fields = { sealed_hash: o.sealed ?? 'aa', job_hash: jobHash({ wallet: 'bob.testnet' }, 'salt'), price: o.price ?? '750000', expected: o.expected ?? o.promised, promised: o.promised, cover: o.cover ?? '0', expires_ns: String(1_000_000_000n + (o.expiresIn ?? 600_000_000_000n)) };
  const signature = base64.enc(nacl.sign.detached(utf8ToBytes(quoteMessage('srs.testnet', 'TEST', INPUTS_HASH, o.buyer ?? 'bob.testnet', fields)), (o.signer ?? kp).secretKey));
  const quote = { ...fields, signature };
  const payQuoted = (runId: string, q: object = quote) => t.L.call('usdc.testnet', (l) => l.ft_on_transfer({ sender_id: 'bob.testnet', amount: '750000', msg: JSON.stringify({ action: 'run', recipe_id: 'TEST', run_id: runId, inputs_hash: INPUTS_HASH, quote: q }) }));
  const report = (runId: string, outcome: Outcome, delivered: string) => t.L.call('relayer', (l) => l.report_run({ run_id: runId, outcome, parts_used: outcome === 'ok' ? t.parts : [], output_hash: 'f'.repeat(64), delivered, signature: base64.enc(nacl.sign.detached(utf8ToBytes(runReportMessage('srs.testnet', runId, 'TEST', outcome, 'f'.repeat(64), delivered, outcome === 'ok' ? t.parts : [])), kp.secretKey)) }));
  const lastReason = () => (t.L.events.at(-1)!.data[0] as { reason: string }).reason;
  return { ...t, quote, payQuoted, report, lastReason };
}

test('bond vectors: quoted runs lock the signed cover, compensate shortfalls, release on fail or abort (shared with Rust)', () => {
  for (const c of json('contracts/test-vectors/bonds.json').cases) {
    const q = quoted({ bond: c.input.bond_available, promised: c.input.promised, cover: c.input.cover });
    q.payQuoted('r1');
    assert.equal(q.L.runs.get('r1')!.covered.toString(), c.expected.covered, c.name + ' covered');
    const before = q.L.balance_of('bob.testnet');
    q.report('r1', c.input.outcome, c.input.delivered);
    const refund = c.input.outcome === 'ok' ? 0n : 750000n;
    assert.equal((q.L.balance_of('bob.testnet') - before - refund).toString(), c.expected.compensation, c.name + ' compensation');
    const r = q.L.recipes.get('TEST')!;
    assert.equal(r.bond_available.toString(), c.expected.bond_available_after, c.name + ' bond_available');
    assert.equal(r.bond_locked.toString(), c.expected.bond_locked_after, c.name + ' bond_locked');
    if (c.input.outcome === 'abort') { assert.equal(r.aborted, 1n); assert.equal(q.lastReason(), 'runner_aborted'); }
    if (c.input.outcome === 'fail') assert.equal(r.failed, 1n);
  }
});

test('quotes: every rejection reason, in the contract order, refunds the payer', () => {
  const cases: [string, ReturnType<typeof quoted>, object?][] = [];
  const base = () => quoted({ bond: '5000000', promised: '3000000', cover: '3000000' });
  { const q = base(); cases.push(['job_hash must be 64 lowercase hex', q, { ...q.quote, job_hash: 'ABC' }]); }
  { const q = quoted({ bond: '0', promised: '1', sealed: 'old' }); cases.push(['quote for an outdated recipe version', q]); }
  { const q = base(); q.L.runners.get('runner.testnet')!.active = false; cases.push(['runner inactive', q]); }
  cases.push(['invalid quote signature', quoted({ bond: '0', promised: '1000', signer: nacl.sign.keyPair() })]);
  cases.push(['invalid quote signature', quoted({ bond: '0', promised: '1000', buyer: 'mallory.testnet' })]);
  { const q = base(); cases.push(['invalid quote signature', q, { ...q.quote, promised: '9000000' }]); }
  { const q = quoted({ bond: '0', promised: '1000', expiresIn: 0n }); q.advance(1n); cases.push(['quote expired', q]); }
  cases.push(['cover exceeds promise', quoted({ bond: '9000000', promised: '1000', cover: '2000' })]);
  cases.push(['bond below quoted cover', quoted({ bond: '1000', promised: '3000000', cover: '3000000' })]);
  // a direct payer gets the panic (the token contract refunds the transfer); an Intents payer with on_behalf_of is credited instead
  for (const [reason, q, quote] of cases) {
    assert.throws(() => q.payQuoted('r1', quote), (e: Error) => e.message === reason, reason);
    assert.equal(q.L.runs.has('r1'), false);
    assert.equal(q.L.recipes.get('TEST')!.bond_locked, 0n);
  }
  const reuse = base(); reuse.payQuoted('r1');
  assert.throws(() => reuse.payQuoted('r2'), /quote already used/);
  const viaIntents = quoted({ bond: '0', promised: '1000', signer: nacl.sign.keyPair() });
  viaIntents.L.call('usdc.testnet', (l) => l.ft_on_transfer({ sender_id: 'solver', amount: '750000', msg: JSON.stringify({ action: 'run', recipe_id: 'TEST', run_id: 'r9', inputs_hash: INPUTS_HASH, on_behalf_of: 'bob.testnet', quote: viaIntents.quote }) }));
  assert.equal(viaIntents.lastReason(), 'invalid quote signature');
  assert.equal(viaIntents.L.balance_of('bob.testnet'), 750000n, 'credited to the buyer, not the solver');
  const bad = base();
  assert.throws(() => bad.payQuoted('r1', { ...bad.quote, promised: 12 }), /invalid msg/, 'a malformed quote is an unparseable msg');
});

test('bond-drain attempt: a buyer who empties the wallet before execution gets an abort, not compensation', () => {
  const q = quoted({ bond: '5000000', promised: '3000000', cover: '3000000' });
  q.payQuoted('r1');
  // runner re-checks the job right before executing; fresh promised < 98% of the quote → signed abort
  q.report('r1', 'abort', '0');
  const r = q.L.recipes.get('TEST')!;
  assert.equal(r.bond_available, 5000000n); assert.equal(r.bond_locked, 0n); assert.equal(r.compensated_total, 0n);
  assert.equal(q.L.balance_of('bob.testnet'), 750000n, 'price refunded, nothing more');
  assert.throws(() => q.L.call('x', (l) => l.report_run({ run_id: 'r1', outcome: 'ok', parts_used: q.parts, output_hash: 'f'.repeat(64), delivered: '0', signature: q.sign('r1', 'ok', q.parts) })), /not pending/);
});

test('locked cover cannot be withdrawn; track record totals', () => {
  const q = quoted({ bond: '5000000', promised: '3000000', cover: '3000000' });
  q.payQuoted('r3');
  assert.throws(() => q.L.call('creator.testnet', (l) => l.withdraw_bond({ recipe_id: 'TEST', amount: '2000001' })), /exceeds bond_available/, 'locked cover cannot be withdrawn');
  assert.throws(() => q.L.call('bob.testnet', (l) => l.withdraw_bond({ recipe_id: 'TEST', amount: '1' })), /creator only/);
  q.L.call('creator.testnet', (l) => l.withdraw_bond({ recipe_id: 'TEST', amount: '2000000' }));
  q.report('r3', 'ok', '2500000');
  const r = q.L.recipes.get('TEST')!;
  assert.equal(r.compensated_total, 500000n); assert.equal(r.promised_total, 3000000n); assert.equal(r.delivered_total, 2500000n); assert.equal(r.runs, 1n);
});

test('SRS-1 disclosure: open-weights parts are low risk, closed models high, remote services medium', () => {
  const base = { instructions: 'open', harness: 'open', verification: 'open', runtime: 'bundled' } as const;
  assert.equal(withdrawalRisk({ ...base, model: { kind: 'open-weights' } }), 'low');
  assert.equal(withdrawalRisk({ ...base, model: { kind: 'none' } }), 'low');
  assert.equal(withdrawalRisk({ ...base, model: { kind: 'closed' } }), 'high');
  assert.equal(withdrawalRisk({ ...base, model: { kind: 'none' }, runtime: 'remote' }), 'medium');
  assert.equal(withdrawalRisk({ ...base, model: { kind: 'none' }, runtime: 'remote', harness: 'closed' }), 'high');
  const clnp = recipe('CLNP');
  assert.equal(validateRecipe(clnp, catalog).risk, 'low');
  const pro = swapPart(clnp, 'shield', 'ai.spam-shield-pro@1.0.0', catalog);
  const v = validateRecipe(pro, catalog);
  assert.equal(v.risk, 'high');
  assert.ok(v.diagnostics.some((d) => d.code === 'part.closed-model'));
  assert.equal(publicListing(clnp, catalog).privacy, 'confidential');
  assert.equal(publicListing(recipe('SWPR'), catalog).privacy, 'public');
});

test('quotes: value delivered is measured for swap-receipt results only; the sealed request hash is salted', () => {
  for (const t of ['CLNP', 'SWPR', 'EXIT', 'SAFE']) assert.ok(validateRecipe(recipe(t), catalog).ok, t);
  assert.equal(measuresValue(catalog.types, validateRecipe(recipe('CLNP'), catalog).outputType), true);
  assert.equal(measuresValue(catalog.types, validateRecipe(recipe('SAFE'), catalog).outputType), false);
  assert.notEqual(jobHash({ wallet: 'bob.testnet' }, 'a'), jobHash({ wallet: 'bob.testnet' }, 'b'), 'salted');
});

test('trust labels come from part ids, so a listing cannot claim a lower risk than its parts', () => {
  const clnp = recipe('CLNP');
  const honest = labelsFromParts(validateRecipe(clnp, catalog).partsUsed, catalog);
  assert.equal(honest.risk, 'low'); assert.equal(honest.privacy, 'confidential');
  const pro = swapPart(clnp, 'shield', 'ai.spam-shield-pro@1.0.0', catalog);
  const proLabels = labelsFromParts(validateRecipe(pro, catalog).partsUsed, catalog);
  assert.equal(proLabels.risk, 'high', 'a closed model raises the label whatever the listing says');
  assert.throws(() => labelsFromParts(['made.up@1.0.0'], catalog), /unknown part/);
});

// ---- conformance with the proved models (verification/smt): the mirror must agree with the proofs' models ----
test('conformance: settlement and bonds match the models proved in verification/smt', () => {
  const v = json('contracts/test-vectors/conformance-money.json');
  const B = BigInt;
  v.settlement.forEach((c: any, k: number) => {
    const i = c.input;
    let s: ReturnType<typeof settlementSplit> | null = null;
    try { s = settlementSplit({ price: B(i.price), protocolFeeBps: i.protocol_fee_bps, runnerFee: B(i.runner_fee), partFees: i.part_fees.map(B), reserveBps: i.reserve_bps }); } catch { s = null; }
    if (c.expected === null) { assert.equal(s, null, `settlement ${k}: mirror split, model None`); return; }
    assert.ok(s, `settlement ${k}: mirror threw, model split`);
    const e = c.expected;
    assert.deepEqual([s.protocol, s.remainder, s.reserve, s.creator].map(String), [e.protocol, e.remainder, e.reserve, e.creator], `settlement ${k}`);
  });
  v.bonds.forEach((c: any, k: number) => {
    const b = { available: B(c.available), locked: B(c.locked) }, x = B(c.amount);
    let got: any;
    try { got = c.op === 'lock' ? bondLock(b, x) : c.op === 'release' ? bondRelease(b, x) : c.op === 'deposit' ? bondDeposit(b, x) : bondSettle(b, x, B(c.promised), B(c.delivered)); } catch { got = null; }
    if (c.expected === null) { assert.ok(got === null || got === undefined, `bond ${k}`); return; }
    const [nb, comp] = Array.isArray(got) ? got : [got, undefined];
    assert.equal(String(nb.available), c.expected.available, `bond ${k}`); assert.equal(String(nb.locked), c.expected.locked, `bond ${k}`);
    if (comp !== undefined) assert.equal(String(comp), c.expected.compensation, `bond ${k}`);
  });
  assert.ok(v.settlement.length >= 50 && v.bonds.length >= 50);
});


// ---- v4: versions with notice, durable runs, partial settlement ----
test('versions: an update is announced, takes effect only after the notice period, and paid runs keep their version', () => {
  const { L, pay, advance } = setupLedger();
  const v2 = 'b'.repeat(64);
  assert.throws(() => L.call('bob.testnet', (l) => l.update_sealed({ id: 'TEST', sealed_hash: v2 })), /creator only/);
  assert.throws(() => L.call('creator.testnet', (l) => l.update_sealed({ id: 'TEST', sealed_hash: 'xyz' })), /64 lowercase hex/);
  L.call('creator.testnet', (l) => l.update_sealed({ id: 'TEST', sealed_hash: v2 }));
  const ev = L.events.at(-1)!; assert.equal(ev.event, 'recipe_update_scheduled'); assert.equal((ev.data[0] as any).version, 2);
  pay('r1');
  assert.equal(L.runs.get('r1')!.sealed_hash, 'aa', 'a run paid during the notice period uses the current version');
  assert.throws(() => L.call('x', (l) => l.apply_update({ id: 'TEST' })), /update not due/);
  advance(L.updateDelayNs);
  pay('r2'); // activation happens lazily, before the run is created
  assert.equal(L.runs.get('r2')!.sealed_hash, v2);
  assert.equal(L.recipes.get('TEST')!.version, 2);
  assert.ok(L.events.some((e) => e.event === 'recipe_updated' && (e.data[0] as any).version === 2));
  assert.equal(L.runs.get('r1')!.sealed_hash, 'aa', 'the earlier run still points at the version it paid for');
  assert.throws(() => L.call('creator.testnet', (l) => l.update_sealed({ id: 'TEST', sealed_hash: v2 })), /same as current version/);
  assert.throws(() => L.call('creator.testnet', (l) => l.cancel_update({ id: 'TEST' })), /no pending update/);
});

test('durable runs: checkpoints are ordered and signed, extend the timeout, and bill parts only in checkpoint mode', () => {
  const fin = setupLedger();
  fin.pay('r1');
  assert.throws(() => fin.ckpt('r1', 2, []), /seq must be checkpoint_seq \+ 1/);
  assert.throws(() => fin.ckpt('r1', 1, ['b0@1.0.0']), /only be billed at checkpoints in checkpoint mode/);
  fin.advance(RUN_TIMEOUT_NS - 1n);
  fin.ckpt('r1', 1, []); // heartbeat
  fin.advance(RUN_TIMEOUT_NS - 1n);
  assert.throws(() => fin.L.call('bob.testnet', (l) => l.reclaim_run({ run_id: 'r1' })), /timeout not reached/, 'progress keeps a long run alive');
  fin.advance(2n);
  fin.L.call('bob.testnet', (l) => l.reclaim_run({ run_id: 'r1' }));

  const cp = setupLedger({ settleMode: 'checkpoint' });
  cp.pay('r1');
  cp.ckpt('r1', 1, ['b0@1.0.0']);
  assert.equal(cp.L.balance_of('author0.testnet'), 20000n, 'the first part is paid as soon as it is done');
  assert.throws(() => cp.ckpt('r1', 2, ['b0@1.0.0']), /parts_done not part of recipe/, 'a part cannot be billed twice');
  assert.throws(() => cp.L.call('x', (l) => l.checkpoint_run({ run_id: 'r1', seq: 2, state_hash: 'c'.repeat(64), parts_done: [], signature: base64.enc(new Uint8Array(64)) })), /invalid runner signature/);
  assert.throws(() => cp.L.call('x', (l) => l.report_run({ run_id: 'r1', outcome: 'ok', parts_used: ['b1@1.0.0'], output_hash: 'f'.repeat(64), delivered: '0', signature: cp.sign('r1', 'ok', ['b1@1.0.0']) })), /must include billed parts/);
  const payouts = cp.L.call('x', (l) => l.report_run({ run_id: 'r1', outcome: 'ok', parts_used: cp.parts, output_hash: 'f'.repeat(64), delivered: '0', signature: cp.sign('r1', 'ok', cp.parts) }));
  assert.ok(!payouts.some((p) => p.role === 'part:b0@1.0.0'), 'billed parts are not paid twice');
  const settle = cp.L.events.at(-1)!.data[0] as any;
  assert.equal(payouts.reduce((a, p) => a + p.amount, 0n) + BigInt(settle.reserve) + cp.L.runs.get('r1')!.billed, 750000n, 'billed + payouts + reserve == price');
  assert.equal(cp.L.balance_of('author0.testnet'), 20000n);

  cp.pay('r2');
  cp.ckpt('r2', 1, ['b0@1.0.0']);
  const before = cp.L.balance_of('bob.testnet');
  cp.L.call('x', (l) => l.report_run({ run_id: 'r2', outcome: 'fail', parts_used: [], output_hash: 'f'.repeat(64), delivered: '0', signature: cp.sign('r2', 'fail', []) }));
  assert.equal(cp.L.balance_of('bob.testnet') - before, 750000n - 20000n, 'a failed run refunds everything not yet billed');
});

test('creator copies: only the creator can reopen a published recipe, from any device, with nothing stored in the browser', () => {
  const r = recipe('CLNP');
  const { publicKeyHex, secretKey } = creatorKeyFromSignature(demoWalletSign('chef.testnet', creatorKeyMessage('chef.testnet')));
  const copy = seal(r, publicKeyHex, 'creator-copy');
  // same wallet signature on another device -> same key
  const again = creatorKeyFromSignature(demoWalletSign('chef.testnet', creatorKeyMessage('chef.testnet')));
  assert.deepEqual(open(copy, again.secretKey), r);
  const other = creatorKeyFromSignature(demoWalletSign('mallory.testnet', creatorKeyMessage('mallory.testnet')));
  assert.throws(() => open(copy, other.secretKey));
  assert.notEqual(publicKeyHex, other.publicKeyHex);
  void secretKey;
});


// ---- v6: market-driven pricing ----
function marketLedger() {
  const t = setupLedger({ price: '1000000' });
  // a second recipe with a band: list 1.00, floor 0.50, ceiling 2.00, target 2 runs per period
  t.L.call('creator.testnet', (l) => l.publish_recipe({ id: 'MKT', name: 'Market', sealed_hash: 'mm', runner_id: 'runner.testnet', parts: t.parts, price_per_run: '1000000', pricing: { price_floor: '500000', price_ceiling: '2000000', target_runs: 2 } }));
  const payMkt = (runId: string, amount: string, extra: Record<string, unknown> = {}) => t.L.call('usdc.testnet', (l) => l.ft_on_transfer({ sender_id: 'bob.testnet', amount, msg: JSON.stringify({ action: 'run', recipe_id: 'MKT', run_id: runId, inputs_hash: '0'.repeat(64), ...extra }) }));
  return { ...t, payMkt };
}

test('pricing vectors: the mirror matches the model proved in verification/smt (shared with Rust)', () => {
  const v = json('contracts/test-vectors/conformance-money.json');
  v.pricing.forEach((c: any, k: number) => {
    const got = nextPrice(BigInt(c.price), BigInt(Math.min(c.runs, 2 ** 53)), c.target, BigInt(c.floor), BigInt(c.ceiling));
    assert.equal(got === null ? null : String(got), c.expected, `pricing ${k}`);
  });
  assert.ok(v.pricing.length >= 200);
});

test('market pricing: busy recipes get dearer, idle ones cheaper, always inside the band', () => {
  const { L, payMkt, advance } = marketLedger();
  for (let i = 0; i < 4; i++) payMkt(`b${i}`, '1000000');
  assert.equal(L.recipes.get('MKT')!.period_runs, 4n);
  advance(L.pricePeriodNs);
  assert.equal(L.get_recipe('MKT')!.price_per_run, 1125000n, 'double the target: +12.5%');
  payMkt('b4', '1200000');
  assert.equal(L.runs.get('b4')!.amount, 1125000n, 'charged the new list price');
  assert.equal(L.balance_of('bob.testnet'), 75000n, 'overpayment credited');
  const pu = L.events.find((e) => e.event === 'price_updated')!;
  assert.deepEqual(pu.data[0], { recipe_id: 'MKT', previous: '1000000', price: '1125000', periods: '1', runs: '4', target_runs: 2 });
  advance(200n * L.pricePeriodNs);
  assert.equal(L.get_recipe('MKT')!.price_per_run, 500000n, 'a long idle stretch ends at the floor');
  // same three-idle-periods value as the Rust test
  const t2 = marketLedger(); t2.advance(3n * t2.L.pricePeriodNs);
  assert.equal(t2.L.call('k', (l) => l.update_price({ id: 'MKT' })), 669922n);
});

test('market pricing: max_price protects the buyer; a signed quote locks its price inside the band', () => {
  const { L, payMkt } = marketLedger();
  L.call('usdc.testnet', (l) => l.ft_on_transfer({ sender_id: 'solver', amount: '1000000', msg: JSON.stringify({ action: 'run', recipe_id: 'MKT', run_id: 'm1', inputs_hash: '0'.repeat(64), max_price: '900000', on_behalf_of: 'bob.testnet' }) }));
  assert.equal((L.events.at(-1)!.data[0] as { reason: string }).reason, 'price above max_price');
  assert.equal(L.balance_of('bob.testnet'), 1000000n);
  payMkt('m2', '1000000', { max_price: '1000000' });
  assert.equal(L.runs.get('m2')!.status, 'Pending');
  // quotes: the price is signed, so it can't be changed, and must lie in the band
  const { kp } = keyring();
  const mk = (price: string, job = 'ab') => {
    const fields = { sealed_hash: 'mm', job_hash: job.repeat(32), price, expected: '1', promised: '1', cover: '0', expires_ns: String(1_000_000_000n + 600_000_000_000n) };
    return { ...fields, signature: base64.enc(nacl.sign.detached(utf8ToBytes(quoteMessage('srs.testnet', 'MKT', '0'.repeat(64), 'bob.testnet', fields)), kp.secretKey)) };
  };
  payMkt('q1', '1300000', { quote: mk('1300000') });
  assert.equal(L.runs.get('q1')!.amount, 1300000n);
  L.call('usdc.testnet', (l) => l.ft_on_transfer({ sender_id: 'solver', amount: '1300000', msg: JSON.stringify({ action: 'run', recipe_id: 'MKT', run_id: 'q2', inputs_hash: '0'.repeat(64), quote: mk('400000', 'ee'), on_behalf_of: 'bob.testnet' }) }));
  assert.equal((L.events.at(-1)!.data[0] as { reason: string }).reason, 'quoted price outside price_floor..price_ceiling');
  const tampered = { ...mk('1300000', 'dd'), price: '500000' };
  L.call('usdc.testnet', (l) => l.ft_on_transfer({ sender_id: 'solver', amount: '500000', msg: JSON.stringify({ action: 'run', recipe_id: 'MKT', run_id: 'q3', inputs_hash: '0'.repeat(64), quote: tampered, on_behalf_of: 'bob.testnet' }) }));
  assert.equal((L.events.at(-1)!.data[0] as { reason: string }).reason, 'invalid quote signature');
});

test('market pricing: the floor keeps every run viable; only the creator sets the band', () => {
  const { L } = marketLedger();
  assert.throws(() => L.call('creator.testnet', (l) => l.set_pricing({ id: 'MKT', pricing: { price_floor: '100000', price_ceiling: '800000', target_runs: 5 } })), /price_floor below minimum viable price/);
  assert.throws(() => L.call('bob.testnet', (l) => l.set_pricing({ id: 'MKT', pricing: { price_floor: '600000', price_ceiling: '800000', target_runs: 5 } })), /creator only/);
  L.call('creator.testnet', (l) => l.set_pricing({ id: 'MKT', pricing: { price_floor: '600000', price_ceiling: '800000', target_runs: 5 } }));
  const r = L.get_recipe('MKT')!;
  assert.deepEqual([r.price_per_run, r.price_floor, r.price_ceiling, r.target_runs], [800000n, 600000n, 800000n, 5]);
  assert.throws(() => L.call('creator.testnet', (l) => l.publish_recipe({ id: 'BAD', name: 'x', sealed_hash: 'x', runner_id: 'runner.testnet', parts: ['b0@1.0.0'], price_per_run: '3000000', pricing: { price_floor: '500000', price_ceiling: '2000000', target_runs: 2 } })), /within price_floor and price_ceiling/);
});
