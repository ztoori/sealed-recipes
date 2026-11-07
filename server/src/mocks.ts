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
  r.get('/fastnear/v1/account/:id/staking', (req, res) => {
    const pools = [...world.stakes].filter(([, m]) => m.has(req.params.id)).map(([pool_id]) => ({ pool_id, last_update_block_height: null }));
    res.json({ account_id: req.params.id, pools });
  });

  // ---------------- NEAR RPC ----------------
  const viewResult = (id: unknown, value: unknown) => ({ jsonrpc: '2.0', id, result: { result: Array.from(new TextEncoder().encode(JSON.stringify(value))), logs: [], block_height: 0 } });
  const methodNotFound = (id: unknown, m: string) => ({ jsonrpc: '2.0', id, error: { name: 'HANDLER_ERROR', cause: { name: 'METHOD_NOT_FOUND', info: { method_name: m } }, code: -32000, message: `MethodNotFound: ${m}` } });
  const unknownAccount = (id: unknown, a: string) => ({ jsonrpc: '2.0', id, error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT', info: { requested_account_id: a } }, code: -32000, message: 'Server error' } });
  r.post('/rpc', express.json(), (req, res) => {
    const { id, params, method } = req.body ?? {};
    if (method === 'validators') {
      res.json({ jsonrpc: '2.0', id, result: { current_validators: [...world.pools].filter(([, p]) => p.active).map(([account_id]) => ({ account_id, is_slashed: false, stake: '0', num_produced_blocks: 0, num_expected_blocks: 0 })), next_validators: [], current_proposals: [], epoch_start_height: 0 } });
      return;
    }
    const args = () => { try { return JSON.parse(Buffer.from(String(params.args_base64 ?? ''), 'base64').toString('utf8') || '{}'); } catch { return {}; } };
    if (params?.request_type === 'view_access_key_list') {
      const a = String(params.account_id);
      const c = world.contracts.get(a);
      const keys = c ? Array.from({ length: c.full_access_keys }, (_, i) => ({ public_key: `ed25519:${sha256Hex(a + i).slice(0, 44)}`, access_key: { nonce: 1, permission: 'FullAccess' } })) : world.accessKeys.get(a);
      if (!keys && !world.exists(a)) { res.json(unknownAccount(id, a)); return; }
      res.json({ jsonrpc: '2.0', id, result: { keys: keys ?? [], block_height: 0, block_hash: '11111111111111111111111111111111' } });
      return;
    }
    if (params?.request_type === 'call_function' && world.stakes.has(params.account_id)) {
      const pool = String(params.account_id), p = world.pools.get(pool)!;
      if (params.method_name === 'get_account') {
        const a = String(args().account_id), x = world.stakes.get(pool)!.get(a);
        res.json(viewResult(id, { account_id: a, unstaked_balance: String(x?.unstaked ?? 0n), staked_balance: String(x?.staked ?? 0n), can_withdraw: x?.can_withdraw ?? true }));
        return;
      }
      if (params.method_name === 'get_reward_fee_fraction') { res.json(viewResult(id, { numerator: p.fee[0], denominator: p.fee[1] })); return; }
      res.json(methodNotFound(id, params.method_name)); return;
    }
    if (params?.request_type === 'call_function' && params.method_name === 'contract_source_metadata') {
      const c = world.contracts.get(params.account_id);
      if (!c) { res.json(world.exists(params.account_id) ? methodNotFound(id, 'contract_source_metadata') : unknownAccount(id, params.account_id)); return; }
      if (!c.source) { res.json(methodNotFound(id, 'contract_source_metadata')); return; }
      res.json(viewResult(id, c.source)); return;
    }
    if (params?.request_type === 'view_account') {
      const c = world.contracts.get(params.account_id);
      if (c) { res.json({ jsonrpc: '2.0', id, result: { amount: c.amount, locked: '0', code_hash: c.code_hash, storage_usage: c.storage_usage, storage_paid_at: 0, block_height: 0 } }); return; }
      if (world.exists(params.account_id)) { res.json({ jsonrpc: '2.0', id, result: { amount: String(world.native.get(params.account_id) ?? 0n), locked: '0', code_hash: '11111111111111111111111111111111', storage_usage: 182, block_height: 0 } }); return; }
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
    const user = JSON.parse(body.messages.find((m) => m.role === 'user')!.content);
    // the transparent stand-in "model": token verdicts for spam shields, contract verdicts for contract-risk parts
    const content = user?.kind === 'contract' ? JSON.stringify(contractVerdict(user)) : JSON.stringify({ verdicts: tokenVerdicts(user) });
    const id = 'chatcmpl-' + randomBytes(12).toString('hex');
    const responseBody = JSON.stringify({ id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
    const text = `${body.model}:${sha256Hex(requestBody)}:${sha256Hex(responseBody)}`;
    signatures.set(id, { text, signature: signEip191(text, aiKey) });
    res.type('application/json').send(responseBody);
  });
  const contractVerdict = (f: { account: string; exists: boolean; has_code: boolean; full_access_keys: number; source: { link?: string } | null; listed_token: boolean }) => {
    const reasons: string[] = [];
    let risk: 'low' | 'medium' | 'high' = 'low';
    const up = (r: typeof risk, why: string) => { reasons.push(why); if (r === 'high' || (r === 'medium' && risk === 'low')) risk = r; };
    if (!f.exists) up('high', 'account does not exist');
    else if (!f.has_code) up('high', 'not a contract: no code deployed');
    else {
      const brand = ['ref-finance', 'aurora', 'meteor', 'burrow', 'near'].find((b) => f.account.replace(/\.near$/, '').includes(b) && !f.source);
      if (brand && /gift|claim|airdrop|reward|bonus/.test(f.account)) up('high', `imitates "${brand}" with reward bait in its name`);
      else if (/gift|claim|airdrop|reward|bonus/.test(f.account)) up('high', 'reward-bait name with no published source');
      if (f.full_access_keys > 0) up(f.source ? 'medium' : 'high', `code can be replaced by ${f.full_access_keys} key holder(s)`);
      if (!f.source) up('medium', 'source code not published (no NEP-330 metadata)');
      else reasons.push(`source published at ${f.source.link}`);
    }
    return { risk, reasons };
  };
  const tokenVerdicts = (facts: { contract: string; symbol: string; name: string; quoted_by_solvers: boolean }[]) => {
    return facts.map((f) => {
      const text = `${f.symbol} ${f.name}`.toLowerCase();
      if (/https?:|www\.|\.(xyz|io|org|com|net|app)\b/.test(text)) return { contract: f.contract, verdict: 'SCAM', reason: 'symbol/name contains a URL lure' };
      if (/\b(claim|reward|gift|free|airdrop)\b/.test(text)) return { contract: f.contract, verdict: 'SCAM', reason: 'reward bait wording' };
      if (['usdc', 'usdt', 'wnear', 'near'].includes(f.symbol.toLowerCase()) && !f.quoted_by_solvers) return { contract: f.contract, verdict: 'SCAM', reason: `impersonates ${f.symbol} with an unrecognised contract` };
      return { contract: f.contract, verdict: 'OK', reason: f.quoted_by_solvers ? 'liquid, recognised asset' : 'illiquid but no scam signals' };
    });
  };
  r.get('/nearai/v1/signature/:id', (req, res) => {
    const s = signatures.get(req.params.id);
    if (!s) { res.status(404).json({ detail: 'Chat id not found or expired' }); return; }
    res.json({ ...s, signing_address: aiSigningAddress, signing_algo: 'ecdsa', signature_kind: 'provider_tee' });
  });

  return { router: r, oneclick, aiSigningAddress, verifier };
}
