/**
 * An offline stand-in for server/src/live.ts and NEAR RPC, for driving the live web page in a headless browser
 * (scripts/e2e/live-page.py). Same endpoints and shapes, real sealing and signatures, no network:
 *   node --import tsx scripts/e2e/mock-live.ts [port]   (serves web/dist/live.html)
 * The fake RPC decodes the signed transaction the browser sends and checks it is ft_transfer_call from the guest.
 */
import express from 'express';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { utf8ToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { decodeSignedTransaction } from 'near-api-js';
import { seal, open, sealedHash, base64, type SealedEnvelope } from '../../core/src/seal.js';
import { reportData } from '../../core/src/attestation.js';
import { quoteMessage } from '../../core/src/ledger.js';
import { mountDemoProxy } from '../../server/src/demo-proxy.js';
import { loadCatalog } from '../../core/src/codehash.js';

const PORT = Number(process.argv[2] ?? 8099);
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CONTRACT = 'market.sealedrecipes.testnet', TOKEN = 'tusdc.sealedrecipes.testnet', RUNNER = 'runner.sealedrecipes.testnet';
const sign = nacl.sign.keyPair(), box = nacl.box.keyPair();
const signingPk = 'ed25519:' + bs58.encode(sign.publicKey), encPkHex = bytesToHex(box.publicKey), codehash = 'ab'.repeat(32);
const funded = new Set<string>(); const runs = new Map<string, { buyer: string; reply: string; paid?: string }>(); const log: string[] = [];
const listing = { ticker: 'CHEK', name: 'Contract check', description: 'Is this contract safe to use?', creator: 'sealedrecipes.testnet', form: [{ id: 'contract', label: "Contract you're about to use", type: 'near.account', required: true, placeholder: 'near-gift-claim.near' }], parts: ['near.contract-info@1.0.0'], capabilities: [], output_type: 'report', price_per_run: '50000', pricing: null, reserve_bps: 0, interface_hash: 'x', risk: 'low', disclosures: [], privacy: 'confidential' };

const app = express(); mountDemoProxy(app); app.use(express.json({ limit: '2mb' })); // /demo → the demo on :8080 if one runs
app.get('/api/mode', (_, res) => res.json({ mode: 'testnet', contract_id: CONTRACT, payment_token: TOKEN, runner_id: RUNNER, runner_url: '/runner', rpc_url: `http://127.0.0.1:${PORT}/rpc`, faucet: true }));
const record = { pricePerRun: 0.05, runs: 3, failed: 0, aborted: 0, revenue: 0.15, keptPromise: null, deposit: { available: 0, locked: 0, paidToBuyers: 0 }, perRun: { price: 0.05, protocol: 0.001, runner: 0.01, parts: [{ part: 'near.contract-info@1.0.0', amount: 0.01 }], creator: 0.029, reserve: 0, reserveBps: 0 } };
app.get('/api/listings', (_, res) => res.json([{ ...listing, onchain: { runs: '3', failed: '0', price_per_run: '50000', sealed_hash: 'cd'.repeat(32) }, record }]));
// the read-only feeds the docs and landing pages use (server/src/live.ts)
const catalog = loadCatalog(ROOT);
app.get('/api/catalog', (_, res) => res.json({ ...catalog, parts: catalog.parts.map((p) => ({ ...p, author: 'sealedrecipes.testnet' })), onchain: {} }));
app.get('/api/vault/:t', (_, res) => res.json({ envelope: seal({ recipe: 'sealed' }, encPkHex, 'recipe'), sealed_hash: 'cd'.repeat(32) }));
app.get('/api/chain/recipes/:t', (_, res) => res.json({ id: 'CHEK', sealed_hash: 'cd'.repeat(32), runner_id: RUNNER, parts: listing.parts, creator: listing.creator, price_per_run: '50000' }));
app.get('/api/chain/runners/:id', (_, res) => res.json({ signing_pk: signingPk, enc_pk_hex: encPkHex, codehash }));
app.get('/runner/attestation', (req, res) => { const nonce = String(req.query.nonce); const base = { codehash, enc_pk_hex: encPkHex, nonce, signing_pk: signingPk }; const rd = reportData(base); res.json({ v: 'srs-attest-v1', tee: 'local-dev', runner_id: RUNNER, ...base, compose_hash: null, report_data: rd, quote: null, issued_at: new Date().toISOString(), self_sig: base64.enc(nacl.sign.detached(utf8ToBytes(rd), sign.secretKey)) }); });
app.get('/api/chain/events', (_, res) => res.json({ height: 0, events: [] }));
app.get('/api/intents/log', (_, res) => res.json([]));
app.get('/api/runner/attestation', (req, res) => {
  const nonce = String(req.query.nonce); const base = { codehash, enc_pk_hex: encPkHex, nonce, signing_pk: signingPk }; const rd = reportData(base);
  res.json({ attestation: { v: 'srs-attest-v1', tee: 'local-dev', runner_id: RUNNER, ...base, compose_hash: null, report_data: rd, quote: null, issued_at: new Date().toISOString(), self_sig: base64.enc(nacl.sign.detached(utf8ToBytes(rd), sign.secretKey)) }, onchain: { signing_pk: signingPk, enc_pk_hex: encPkHex, codehash } });
});
app.get('/api/account/:id/balance', (req, res) => res.json({ account_id: req.params.id, exists: funded.has(req.params.id), near_yocto: funded.has(req.params.id) ? '50000000000000000000000' : '0', tusdc: funded.has(req.params.id) ? '5000000' : '0', token: TOKEN, faucet: true }));
app.post('/api/faucet', (req, res) => { const a = req.body.account_id; if (!/^[0-9a-f]{64}$/.test(a)) return res.status(400).json({ error: 'guest accounts only' }); if (funded.has(a)) return res.status(409).json({ error: 'already funded' }); funded.add(a); log.push('faucet ' + a); res.json({ ok: true }); });
app.post('/api/quotes', (req, res) => {
  const { recipe_id, sealed_job, job_hash, buyer } = req.body as { recipe_id: string; sealed_job: SealedEnvelope; job_hash: string; buyer: string };
  const job = open<{ inputs: Record<string, string>; reply_to: string }>(sealed_job, box.secretKey);
  log.push('quote inputs ' + JSON.stringify(job.inputs) + ' buyer ' + buyer);
  const f = { sealed_hash: 'cd'.repeat(32), job_hash, price: '50000', expected: '0', promised: '0', cover: '0', expires_ns: String(BigInt(Date.now() + 600_000) * 1_000_000n) };
  const signature = base64.enc(nacl.sign.detached(utf8ToBytes(quoteMessage(CONTRACT, recipe_id, sealedHash(sealed_job), buyer, f)), sign.secretKey));
  res.json({ quote: { recipe_id, ok: true, sealed_quote: seal({ ...f, signature, recipe_id, buyer, inputs_hash: sealedHash(sealed_job), details: {} }, job.reply_to, 'quote'), listing } });
});
app.post('/api/runs/prepare', (req, res) => {
  const { buyer, sealed_inputs, signed_quote } = req.body; const run_id = 'r-' + randomBytes(6).toString('hex'); const token = randomBytes(12).toString('hex');
  runs.set(run_id, { buyer, reply: open<{ reply_to: string }>(sealed_inputs, box.secretKey).reply_to });
  res.json({ run_id, run_token: token, pay: { contract: TOKEN, method: 'ft_transfer_call', args: { receiver_id: CONTRACT, amount: signed_quote.price, msg: JSON.stringify({ action: 'run', run_id }) }, deposit_yocto: '1', gas_tgas: 150 } });
});
app.post('/api/runs/:id/paid', (req, res) => { const r = runs.get(req.params.id)!; r.paid = req.body.tx_hash; log.push('paid ' + req.body.tx_hash); res.json({ ok: true }); });
app.get('/api/runs/:id/events', (req, res) => {
  const r = runs.get(req.params.id)!; res.writeHead(200, { 'content-type': 'text/event-stream' });
  const evs = [
    { source: 'chain', type: 'payment_tx', data: { tx: r.paid, url: 'https://testnet.nearblocks.io/txns/' + r.paid } },
    { source: 'chain', type: 'run_requested', data: {} }, { source: 'runner', type: 'accepted', data: { runner_id: RUNNER } },
    { source: 'runner', type: 'sealed', data: { envelope: seal({ type: 'result', data: { output: { title: 'wrap.near looks fine', items: [{ label: 'Verdict', detail: 'no drainer keys' }] } } }, r.reply, 'output') } },
    { source: 'runner', type: 'completed', data: { ok: true, url: 'https://testnet.nearblocks.io/txns/report' } },
  ];
  evs.forEach((e, i) => setTimeout(() => res.write(`data: ${JSON.stringify({ seq: i, at: Date.now(), ...e })}\n\n`), 200 * (i + 1)));
});
// a NEAR RPC that accepts exactly one kind of transaction: the guest's ft_transfer_call to the token
app.post('/rpc', (req, res) => {
  const { id, method, params } = req.body; const ok = (result: unknown) => res.json({ jsonrpc: '2.0', id, result });
  if (method === 'query' && params.request_type === 'view_access_key') return ok({ nonce: 7, permission: 'FullAccess', block_height: 1, block_hash: bs58.encode(new Uint8Array(32).fill(1)) });
  if (method === 'block') return ok({ header: { hash: bs58.encode(new Uint8Array(32).fill(1)), height: 1 } });
  if (method === 'send_tx' || method === 'broadcast_tx_commit') {
    const raw = Buffer.from(params.signed_tx_base64 ?? params[0], 'base64');
    const tx = decodeSignedTransaction(raw);
    const t = tx.transaction; const act = (t.actions[0] as any).functionCall;
    const pk = Buffer.from(t.publicKey.ed25519Key.data).toString('hex');
    const hash = bs58.encode(createHash('sha256').update(raw.subarray(0, raw.length - 65)).digest());
    log.push(`tx ${t.signerId} → ${t.receiverId}.${act.methodName} deposit ${act.deposit} pk-matches-signer ${pk === t.signerId}`);
    return ok({ final_execution_status: 'EXECUTED_OPTIMISTIC', status: { SuccessValue: '' }, transaction: { hash, signer_id: t.signerId }, transaction_outcome: { id: hash, outcome: { logs: [], status: { SuccessValue: '' } } }, receipts_outcome: [] });
  }
  res.json({ jsonrpc: '2.0', id, error: { message: 'unsupported ' + method } });
});
app.get('/api/tokens', (_, res) => res.json([]));
app.get('/__log', (_, res) => res.json(log));
app.get('/', (_, res) => res.sendFile(join(ROOT, 'web/dist/live.html')));
app.use('/assets', express.static(join(ROOT, 'web/dist/assets')));
app.listen(PORT, '127.0.0.1', () => console.log(`mock live on http://127.0.0.1:${PORT}`));
