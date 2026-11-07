/**
 * Local stand-ins for external services, served under /mock/*. They reproduce the
 * request/response shapes of the real APIs so the runner's code is identical in
 * live mode (where SRS_REWRITE is unset and it talks to the real hosts).
 *
 *   /mock/fastnear  ≈ https://api.fastnear.com            (GET /v1/account/{id}/ft)
 *   /mock/rpc       ≈ https://rpc.mainnet.fastnear.com    (JSON-RPC query: view_account, call_function ft_metadata)
 *   /mock/1click    ≈ https://1click.chaindefuser.com     (/v0/tokens, /v0/quote, /v0/deposit/submit, /v0/status)
 *   /mock/nearai    ≈ https://cloud-api.near.ai           (/v1/chat/completions, /v1/attestation/report, /v1/signature/{id})
 *   /mock/solver-relay ≈ https://solver-relay-v2.chaindefuser.com (/rpc: quote, publish_intent, get_status) + Verifier
 *
 * The NEAR AI mock signs responses with a real secp256k1 key exactly like the model
 * TEE does, but it has NO hardware attestation (no intel_quote / nvidia_payload), and
 * its "model" is a transparent heuristic. Both facts are surfaced in the UI.
 */
import express, { type Router } from 'express';
import { randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256Hex } from '../../core/src/canonical.js';
import { OneClick, type QuoteRequest, type Token } from '../../core/src/oneclick.js';
import { addressFromPublicKey, signEip191 } from '../../core/src/nearai.js';
import type { World } from './world.js';
import { IntentsVerifierMock } from './intents-verifier.js';

export interface MockHooks {
  /** called once when a 1Click swap reaches SUCCESS: deliver funds like a solver would */
  onDelivered: (req: QuoteRequest, amountOut: string, depositAddress: string) => void;
}

export function mockRouter(world: World, tokens: Token[], hooks: MockHooks): { router: Router; oneclick: OneClick; aiSigningAddress: string; verifier: IntentsVerifierMock } {
  const r = express.Router();
  const verifier = new IntentsVerifierMock(world, tokens);

  // ---------------- NEAR Intents Solver Relay (Message Bus) + Verifier ----------------
  r.post('/solver-relay/rpc', express.json(), (req, res) => {
    const { id, method, params } = req.body ?? {};
    try {
      const p = params?.[0] ?? {};
      const result = method === 'quote' ? verifier.quote(p) : method === 'publish_intent' ? verifier.publish(p) : method === 'get_status' ? verifier.status(p.intent_hash) : undefined;
      if (result === undefined) { res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } }); return; }
      res.json({ jsonrpc: '2.0', id, result });
    } catch (e) { res.json({ jsonrpc: '2.0', id, error: { code: -32000, message: (e as Error).message } }); }
  });
  const oneclick = new OneClick({ mode: 'fixture', fixtureTokens: tokens });
  const delivered = new Set<string>();

  // ---------------- FastNEAR ----------------
  r.get('/fastnear/v1/account/:id/ft', (req, res) => { res.json({ account_id: req.params.id, tokens: world.tokensOf(req.params.id) }); });

  // ---------------- NEAR RPC ----------------
  r.post('/rpc', express.json(), (req, res) => {
    const { id, params } = req.body ?? {};
    if (params?.request_type === 'view_account') {
      if (world.exists(params.account_id)) { res.json({ jsonrpc: '2.0', id, result: { amount: '0', locked: '0', code_hash: '11111111111111111111111111111111', storage_usage: 182, block_height: 0 } }); return; }
      res.json({ jsonrpc: '2.0', id, error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT', info: { requested_account_id: params.account_id } }, code: -32000, message: 'Server error' } });
      return;
    }
    if (params?.request_type === 'call_function' && params.method_name === 'ft_metadata') {
      const m = world.meta.get(params.account_id);
      if (!m) { res.json({ jsonrpc: '2.0', id, error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' }, code: -32000 } }); return; }
      const bytes = Array.from(new TextEncoder().encode(JSON.stringify({ spec: 'ft-1.0.0', name: m.name, symbol: m.symbol, decimals: m.decimals })));
      res.json({ jsonrpc: '2.0', id, result: { result: bytes, logs: [], block_height: 0 } });
      return;
    }
    if (params?.request_type === 'call_function' && params.method_name === 'claimable') {
      try {
        const args = JSON.parse(Buffer.from(String(params.args_base64 ?? ''), 'base64').toString('utf8')) as { account_id: string };
        const bytes = Array.from(new TextEncoder().encode(JSON.stringify(world.claimable(params.account_id, args.account_id))));
        res.json({ jsonrpc: '2.0', id, result: { result: bytes, logs: [], block_height: 0 } });
      } catch (e) { res.json({ jsonrpc: '2.0', id, error: { name: 'HANDLER_ERROR', cause: { name: 'METHOD_NOT_FOUND' }, code: -32000, message: (e as Error).message } }); }
      return;
    }
    res.status(400).json({ jsonrpc: '2.0', id, error: { message: 'unsupported in mock' } });
  });

  // ---------------- 1Click ----------------
  r.get('/1click/v0/tokens', async (_, res) => { res.json(await oneclick.tokens()); });
  r.post('/1click/v0/quote', express.json(), async (req, res) => {
    try { res.json(await oneclick.quote(req.body)); } catch (e) { res.status(400).json({ message: (e as Error).message }); }
  });
  r.post('/1click/v0/deposit/submit', express.json(), async (req, res) => {
    try { res.json(await oneclick.submitDeposit(req.body.depositAddress, req.body.txHash, req.body.nearSenderAccount)); } catch (e) { res.status(400).json({ message: (e as Error).message }); }
  });
  r.get('/1click/v0/status', async (req, res) => {
    try {
      const addr = String(req.query.depositAddress);
      const s = await oneclick.status(addr);
      if (s.status === 'SUCCESS' && !delivered.has(addr) && s.quoteResponse) {
        delivered.add(addr);
        hooks.onDelivered(s.quoteResponse.quoteRequest, s.quoteResponse.quote.amountOut, addr);
      }
      res.json(s);
    } catch (e) { res.status(404).json({ message: (e as Error).message }); }
  });

  // ---------------- NEAR AI Cloud ----------------
  const aiKey = secp256k1.utils.randomSecretKey();
  const aiSigningAddress = addressFromPublicKey(secp256k1.getPublicKey(aiKey));
  const signatures = new Map<string, { text: string; signature: string }>();
  r.get('/nearai/v1/attestation/report', (req, res) => {
    const nonce = String(req.query.nonce ?? '');
    res.json({ model_attestations: [{ signing_address: aiSigningAddress, report_data: aiSigningAddress.slice(2).padEnd(64, '0') + nonce, tee: 'mock' }] });
  });
  r.post('/nearai/v1/chat/completions', express.raw({ type: '*/*' }), (req, res) => {
    const requestBody = (req.body as Buffer).toString('utf8');
    const body = JSON.parse(requestBody) as { model: string; messages: { role: string; content: string }[] };
    const facts = JSON.parse(body.messages.find((m) => m.role === 'user')!.content) as { contract: string; symbol: string; name: string; quoted_by_solvers: boolean }[];
    const verdicts = facts.map((f) => {
      const text = `${f.symbol} ${f.name}`.toLowerCase();
      if (/https?:|www\.|\.(xyz|io|org|com|net|app)\b/.test(text)) return { contract: f.contract, verdict: 'SCAM', reason: 'symbol/name contains a URL lure' };
      if (/\b(claim|reward|gift|free|airdrop)\b/.test(text)) return { contract: f.contract, verdict: 'SCAM', reason: 'reward bait wording' };
      if (['usdc', 'usdt', 'wnear', 'near'].includes(f.symbol.toLowerCase()) && !f.quoted_by_solvers) return { contract: f.contract, verdict: 'SCAM', reason: `impersonates ${f.symbol} with an unrecognised contract` };
      return { contract: f.contract, verdict: 'OK', reason: f.quoted_by_solvers ? 'liquid, recognised asset' : 'illiquid but no scam signals' };
    });
    const id = 'chatcmpl-' + randomBytes(12).toString('hex');
    const responseBody = JSON.stringify({ id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ verdicts }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
    const text = `${body.model}:${sha256Hex(requestBody)}:${sha256Hex(responseBody)}`;
    signatures.set(id, { text, signature: signEip191(text, aiKey) });
    res.type('application/json').send(responseBody);
  });
  r.get('/nearai/v1/signature/:id', (req, res) => {
    const s = signatures.get(req.params.id);
    if (!s) { res.status(404).json({ detail: 'Chat id not found or expired' }); return; }
    res.json({ ...s, signing_address: aiSigningAddress, signing_algo: 'ecdsa', signature_kind: 'provider_tee' });
  });

  return { router: r, oneclick, aiSigningAddress, verifier };
}
