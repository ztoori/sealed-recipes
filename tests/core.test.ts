import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { hexToBytes, bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  settlementSplit, LocalLedger, runReportMessage, base64, seal, open, sealedHash,
  validateRecipe, compatibleSwaps, swapBlock, publicListing, recoverSigner, signEip191, addressFromPublicKey,
  verifyChat, sha256Hex, OneClick, runPaymentQuoteRequest, USDC_NEAR, reportData, verifyRunnerAttestation,
  type Catalog, type Recipe, type RunnerAttestation,
} from '../core/src/index.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

const json = (p: string) => JSON.parse(readFileSync(new URL('../' + p, import.meta.url), 'utf8'));
const catalog = json('standard/blocks.json') as Catalog;
const recipe = (t: string) => json(`seed/recipes/${t}.json`) as Recipe;

test('settlement vectors match the contract spec (shared with Rust tests)', () => {
  const v = json('contracts/test-vectors/settlement.json');
  for (const c of v.cases) {
    const s = settlementSplit({ price: BigInt(c.input.price), protocolFeeBps: c.input.protocol_fee_bps, runnerFee: BigInt(c.input.runner_fee), blockFees: c.input.block_fees.map(BigInt), royaltyBps: c.input.royalty_bps, totalShares: BigInt(c.input.total_shares) });
    const e = c.expected;
    assert.equal(s.protocol.toString(), e.protocol, c.name);
    assert.equal(s.remainder.toString(), e.remainder, c.name);
    assert.equal(s.creator.toString(), e.creator, c.name);
    assert.equal(s.pool.toString(), e.pool, c.name);
    assert.equal(s.accIncrement.toString(), e.acc_increment, c.name);
    assert.equal(s.dustToProtocol.toString(), e.dust_to_protocol, c.name);
    const total = s.protocolTotal + s.runner + s.blocks.reduce((a, b) => a + b, 0n) + s.creator + s.distributed;
    assert.equal(total, BigInt(c.input.price), `${c.name}: every unit is paid out`);
  }
});

function keyring() {
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
  return { kp, pk: 'ed25519:' + bs58.encode(kp.publicKey) };
}

function setupLedger(o: { price?: string; total?: string; royalty?: number; fee?: number; runnerFee?: string; blockFees?: string[] } = {}) {
  let now = 1_000_000_000n;
  const L = new LocalLedger({ contractId: 'frs.testnet', owner: 'owner.testnet', paymentToken: 'usdc.testnet', protocolAccount: 'treasury.testnet', protocolFeeBps: o.fee ?? 200, clock: () => now });
  const { kp, pk } = keyring();
  L.call('owner.testnet', (l) => l.add_runner({ id: 'runner.testnet', signing_pk: pk, enc_pk_hex: 'ab'.repeat(32), codehash: 'c0de', fee_per_run: o.runnerFee ?? '30000' }));
  const fees = o.blockFees ?? ['20000', '50000'];
  fees.forEach((f, i) => L.call(`author${i}.testnet`, (l) => l.register_block({ id: `b${i}@1.0.0`, version: '1.0.0', fee_per_call: f, manifest_hash: 'h' })));
  L.call('creator.testnet', (l) => l.publish_recipe({ id: 'TEST', name: 'Test', sealed_hash: 'aa', runner_id: 'runner.testnet', blocks: fees.map((_, i) => `b${i}@1.0.0`), price_per_run: o.price ?? '750000', royalty_bps: o.royalty ?? 1000, total_shares: o.total ?? '1000000' }));
  const sign = (runId: string, ok: boolean, blocks: string[], out = 'f'.repeat(64)) => base64.enc(nacl.sign.detached(utf8ToBytes(runReportMessage('frs.testnet', runId, 'TEST', ok, out, blocks)), kp.secretKey));
  const pay = (runId: string, amount = o.price ?? '750000', buyer = 'bob.testnet') => L.call('usdc.testnet', (l) => l.ft_on_transfer({ sender_id: buyer, amount, msg: JSON.stringify({ action: 'run', recipe_id: 'TEST', run_id: runId, inputs_hash: '0'.repeat(64) }) }));
  return { L, sign, pay, advance: (ns: bigint) => { now += ns; }, blocks: fees.map((_, i) => `b${i}@1.0.0`) };
}

test('pay-per-run → signed report → every party credited in one settlement', () => {
  const { L, sign, pay, blocks } = setupLedger();
  pay('r1', '800000'); // overpay: 50000 credited back
  assert.equal(L.balance_of('bob.testnet'), 50000n);
  const payouts = L.call('relayer.testnet', (l) => l.report_run({ run_id: 'r1', success: true, blocks_used: blocks, output_hash: 'f'.repeat(64), signature: sign('r1', true, blocks) }));
  assert.equal(payouts.length, 5);
  assert.equal(L.balance_of('treasury.testnet'), 15000n);
  assert.equal(L.balance_of('runner.testnet'), 30000n);
  assert.equal(L.balance_of('author0.testnet'), 20000n);
  assert.equal(L.balance_of('author1.testnet'), 50000n);
  // R = 750000-15000-30000-70000 = 635000 ; royalty 10% = 63500 ; pool 571500
  assert.equal(L.balance_of('creator.testnet'), 63500n);
  assert.equal(L.pending_dividends('TEST', 'creator.testnet'), 571500n);
  const ev = L.events.at(-1)!;
  assert.equal(ev.event, 'frs_settlement');
  assert.deepEqual((ev.data[0].payouts as { role: string }[]).map((p) => p.role), ['protocol', 'runner', 'block:b0@1.0.0', 'block:b1@1.0.0', 'creator_royalty']);
});

test('forged or replayed reports are rejected; failure refunds; timeout reclaim', () => {
  const { L, sign, pay, blocks, advance } = setupLedger();
  pay('r1');
  const wrong = base64.enc(nacl.sign.detached(utf8ToBytes('nope'), nacl.sign.keyPair().secretKey));
  assert.throws(() => L.call('x', (l) => l.report_run({ run_id: 'r1', success: true, blocks_used: blocks, output_hash: 'f'.repeat(64), signature: wrong })), /invalid runner signature/);
  assert.throws(() => L.call('x', (l) => l.report_run({ run_id: 'r1', success: true, blocks_used: [...blocks, blocks[0]], output_hash: 'f'.repeat(64), signature: sign('r1', true, [...blocks, blocks[0]]) })), /not part of recipe/);
  L.call('x', (l) => l.report_run({ run_id: 'r1', success: true, blocks_used: blocks, output_hash: 'f'.repeat(64), signature: sign('r1', true, blocks) }));
  assert.throws(() => L.call('x', (l) => l.report_run({ run_id: 'r1', success: true, blocks_used: blocks, output_hash: 'f'.repeat(64), signature: sign('r1', true, blocks) })), /not pending/);
  pay('r2');
  L.call('x', (l) => l.report_run({ run_id: 'r2', success: false, blocks_used: [], output_hash: 'f'.repeat(64), signature: sign('r2', false, []) }));
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

test('dividends vector: harvest-before-transfer keeps accounting exact', () => {
  const v = json('contracts/test-vectors/dividends.json');
  const { L, sign, pay } = setupLedger({ price: v.recipe.price, total: v.recipe.total_shares, royalty: 0, fee: 0, runnerFee: '0', blockFees: ['0'] });
  let n = 0;
  for (const s of v.steps) {
    if (s.op === 'run') { const id = 'r' + n++; pay(id); L.call('x', (l) => l.report_run({ run_id: id, success: true, blocks_used: ['b0@1.0.0'], output_hash: 'f'.repeat(64), signature: sign(id, true, ['b0@1.0.0']) })); }
    if (s.op === 'transfer_shares') L.call(`${s.from}.testnet`, (l) => l.transfer_shares({ recipe_id: 'TEST', receiver_id: `${s.to}.testnet`, qty: s.qty }));
  }
  for (const [who, amt] of Object.entries(v.expected_pending)) {
    assert.equal(L.balance_of(`${who}.testnet`) + L.pending_dividends('TEST', `${who}.testnet`), BigInt(amt as string), who);
  }
});

test('order book: maker price, price improvement refund, partial fill, cancel, locked shares', () => {
  const { L } = setupLedger();
  L.call('creator.testnet', (l) => l.place_ask({ recipe_id: 'TEST', price: '2000', qty: '100' }));
  L.call('creator.testnet', (l) => l.place_ask({ recipe_id: 'TEST', price: '2500', qty: '100' }));
  assert.throws(() => L.call('creator.testnet', (l) => l.transfer_shares({ recipe_id: 'TEST', receiver_id: 'z.testnet', qty: '999900' })), /insufficient available/);
  // bid 150 @ 3000 sweeps both asks
  L.call('usdc.testnet', (l) => l.ft_on_transfer({ sender_id: 'alice.testnet', amount: String(150 * 3000), msg: JSON.stringify({ action: 'bid', recipe_id: 'TEST', price: '3000', qty: '150' }) }));
  assert.equal(L.shares_of('TEST', 'alice.testnet'), 150n);
  assert.equal(L.balance_of('creator.testnet'), 100n * 2000n + 50n * 2500n);
  assert.equal(L.balance_of('alice.testnet'), 100n * 1000n + 50n * 500n);
  const book = L.get_book('TEST');
  assert.equal(book.asks.length, 1); assert.equal(book.asks[0].qty, 50n);
  L.call('creator.testnet', (l) => l.cancel_order({ order_id: book.asks[0].id }));
  assert.equal(L.locked_of('TEST', 'creator.testnet'), 0n);
  // resting bid then crossing ask trades at bid price
  L.call('usdc.testnet', (l) => l.ft_on_transfer({ sender_id: 'dan.testnet', amount: '40000', msg: JSON.stringify({ action: 'bid', recipe_id: 'TEST', price: '4000', qty: '10' }) }));
  L.call('alice.testnet', (l) => l.place_ask({ recipe_id: 'TEST', price: '1000', qty: '10' }));
  assert.equal(L.shares_of('TEST', 'dan.testnet'), 10n);
  assert.equal(L.balance_of('alice.testnet'), 125000n + 40000n);
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

test('FRS-1: seed recipes validate; listing hides wiring and secret params', () => {
  for (const t of ['CLNP', 'SWPR', 'EXIT', 'SAFE']) {
    const v = validateRecipe(recipe(t), catalog);
    assert.ok(v.ok, t + ': ' + JSON.stringify(v.diagnostics));
  }
  const l = publicListing(recipe('CLNP'), catalog);
  const s = JSON.stringify(l);
  assert.ok(!s.includes('token-safety classifier'), 'secret policy prompt must not leak');
  assert.ok(!s.includes('slippage_bps'));
  assert.deepEqual(l.blocks, ['near.wallet-scanner@1.0.0', 'addr.fresh-check@1.0.0', 'ai.spam-shield@1.1.0', 'filter.dust@1.0.0', 'intents.confidential-swap@1.0.0']);
});

test('FRS-1: type errors, cycles and unwired ports are caught', () => {
  const r = recipe('CLNP');
  const badType = { ...r, nodes: r.nodes.map((n) => (n.id === 'swap' ? { ...n, inputs: { ...n.inputs, to: 'form.recipient' } } : n)) };
  const v1 = validateRecipe(badType, catalog);
  assert.ok(!v1.ok); assert.ok(v1.diagnostics.some((d) => d.code === 'port.type' && d.node === 'swap'));
  const cyc = { ...r, nodes: r.nodes.map((n) => (n.id === 'scan' ? { ...n, inputs: { account: 'form.wallet', extra: 'swap.receipts' } } : n.id === 'shield' ? { ...n, inputs: { holdings: 'dust.dust' } } : n)) };
  assert.ok(validateRecipe(cyc, catalog).diagnostics.some((d) => d.code === 'graph.cycle'));
  const unwired = { ...r, nodes: r.nodes.map((n) => (n.id === 'dust' ? { ...n, inputs: { holdings: 'shield.clean' } } : n)) };
  assert.ok(validateRecipe(unwired, catalog).diagnostics.some((d) => d.code === 'port.unwired'));
});

test('FRS-1: drop-in swaps respect subtyping', () => {
  const clnp = recipe('CLNP');
  assert.deepEqual(compatibleSwaps(clnp, 'swap', catalog).map((b) => b.id), ['intents.public-swap@1.0.0']);
  assert.deepEqual(compatibleSwaps(clnp, 'shield', catalog).map((b) => b.id), ['rules.spam-shield@1.0.0']);
  assert.deepEqual(compatibleSwaps(recipe('SWPR'), 'swap', catalog).map((b) => b.id), [], 'public→confidential needs a fresh address');
  const swapped = swapBlock(clnp, 'shield', 'rules.spam-shield@1.0.0', catalog);
  assert.ok(validateRecipe(swapped, catalog).ok);
  assert.equal(validateRecipe(swapped, catalog).blockFees, 20000n + 10000n + 10000n + 10000n + 50000n);
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
  const req = runPaymentQuoteRequest({ originAsset: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', refundTo: '0xabc', contractId: 'frs.testnet', price: '750000', msg: '{"action":"run"}' });
  assert.equal(req.destinationAsset, USDC_NEAR); assert.equal(req.customRecipientMsg, '{"action":"run"}');
  const q = await oc.quote(req);
  assert.equal(q.quote.amountOut, '750000');
  assert.ok(BigInt(q.quote.amountIn) > 750000n, 'buyer pays fees on top');
  assert.ok(q.quote.depositAddress?.match(/^[0-9a-f]{64}$/));
  assert.equal((await oc.status(q.quote.depositAddress!)).status, 'PENDING_DEPOSIT');
});

test('runner attestation: binding, possession, on-chain key match; missing hardware is reported, not hidden', () => {
  const sk = nacl.sign.keyPair();
  const a: Omit<RunnerAttestation, 'report_data' | 'self_sig'> = { v: 'frs-attest-v1', tee: 'local-dev', runner_id: 'r', signing_pk: 'ed25519:' + bs58.encode(sk.publicKey), enc_pk_hex: 'cd'.repeat(32), codehash: 'abc', compose_hash: 'def', nonce: 'n1', quote: null, issued_at: '' };
  const rd = reportData(a);
  const full: RunnerAttestation = { ...a, report_data: rd, self_sig: base64.enc(nacl.sign.detached(utf8ToBytes(rd), sk.secretKey)) };
  const v = verifyRunnerAttestation(full, { nonce: 'n1', signing_pk: a.signing_pk, enc_pk_hex: a.enc_pk_hex, codehash: 'abc' });
  assert.ok(v.ok); assert.equal(v.hardware, false);
  assert.ok(v.checks.some((c) => c.id === 'tdx.quote' && c.status === 'skip'));
  assert.ok(!verifyRunnerAttestation(full, { nonce: 'n2' }).ok, 'replayed nonce');
  assert.ok(!verifyRunnerAttestation({ ...full, enc_pk_hex: 'ee'.repeat(32) }, { nonce: 'n1' }).ok, 'swapped encryption key breaks binding');
});
