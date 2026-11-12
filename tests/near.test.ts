import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyPair, decodeSignedTransaction } from 'near-api-js';
import bs58 from 'bs58';
import { NearChain, eventsOf, failureOf } from '../server/src/near.js';

/** a fake NEAR JSON-RPC node: answers the calls a view and a signed function call need, and records what it got */
function fakeRpc(views: Record<string, unknown>) {
  const sent: { nonce: bigint; receiver: string; method: string; args: unknown; signer: string }[] = [];
  let nonce = 5n;
  const hash = bs58.encode(new Uint8Array(32).fill(7));
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; }); req.on('end', async () => {
      const { id, method, params } = JSON.parse(body);
      const reply = (result: unknown) => res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
      const fail = (message: string) => res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message, data: message, cause: { name: 'UNKNOWN', info: {} } } }));
      if (method === 'query' && params.request_type === 'call_function') {
        if (!(params.method_name in views)) return fail(`no view ${params.method_name}`);
        return reply({ result: [...Buffer.from(JSON.stringify(views[params.method_name]))], logs: [], block_height: 100, block_hash: hash });
      }
      if (method === 'query' && params.request_type === 'view_access_key') return reply({ nonce: Number(nonce), permission: 'FullAccess', block_height: 100, block_hash: hash });
      if (method === 'block') return reply({ header: { hash, height: 100, timestamp: 1, timestamp_nanosec: '1' }, chunks: [] });
      if (method === 'send_tx' || method === 'broadcast_tx_commit') {
        const raw = params.signed_tx_base64 ?? params[0];
        const stx = decodeSignedTransaction(Buffer.from(raw, 'base64'));
        const fc = stx.transaction.actions[0].functionCall!;
        await new Promise((r) => setTimeout(r, 30)); // a slow node: concurrent sends would overlap here
        sent.push({ nonce: BigInt(stx.transaction.nonce), receiver: stx.transaction.receiverId, method: fc.methodName, args: JSON.parse(Buffer.from(fc.args).toString()), signer: stx.transaction.signerId });
        nonce = BigInt(stx.transaction.nonce);
        return reply({
          status: { SuccessValue: Buffer.from(JSON.stringify({ paid: fc.methodName })).toString('base64') },
          transaction: { hash: bs58.encode(new Uint8Array(32).fill(sent.length)), signer_id: stx.transaction.signerId, receiver_id: stx.transaction.receiverId, nonce: Number(stx.transaction.nonce), actions: [] },
          transaction_outcome: { id: hash, outcome: { logs: [], status: { SuccessReceiptId: hash }, receipt_ids: [], gas_burnt: 1, tokens_burnt: '0', executor_id: stx.transaction.signerId } },
          receipts_outcome: [{ id: hash, outcome: { logs: ['other log', 'EVENT_JSON:{"standard":"sealed-recipes","version":"1.0.0","event":"srs_settlement","data":[{"run_id":"r-1"}]}'], status: { SuccessValue: '' }, receipt_ids: [], gas_burnt: 1, tokens_burnt: '0', executor_id: 'market.test' } }],
          final_execution_status: 'EXECUTED_OPTIMISTIC',
        });
      }
      return fail(`fake rpc: unsupported ${method}`);
    });
  });
  return new Promise<{ url: string; sent: typeof sent; close: () => void }>((ok) => server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as { port: number }).port;
    ok({ url: `http://127.0.0.1:${port}`, sent, close: () => server.close() });
  }));
}

test('near: views decode the contract result', async () => {
  const rpc = await fakeRpc({ get_config: { payment_token: 'tusdc.test', protocol_fee_bps: 200 } });
  try {
    const chain = new NearChain(rpc.url, 'market.test');
    assert.deepEqual(await chain.view('get_config'), { payment_token: 'tusdc.test', protocol_fee_bps: 200 });
    await assert.rejects(chain.view('get_missing'), /get_missing/);
  } finally { rpc.close(); }
});

test('near: the relayer signs real transactions, one at a time, with increasing nonces', async () => {
  const rpc = await fakeRpc({});
  try {
    const dir = mkdtempSync(join(tmpdir(), 'srs-near-'));
    const kp = KeyPair.fromRandom('ed25519');
    writeFileSync(join(dir, 'relayer.json'), JSON.stringify({ account_id: 'relayer.test', public_key: kp.getPublicKey().toString(), private_key: kp.toString() }));
    const chain = new NearChain(rpc.url, 'market.test', join(dir, 'relayer.json'));
    assert.equal(chain.relayerId, 'relayer.test');
    const [a, b] = await Promise.all([chain.relay('report_run', { run_id: 'r-1' }), chain.relay('checkpoint_run', { run_id: 'r-2', seq: 1 })]);
    assert.equal(rpc.sent.length, 2);
    assert.deepEqual(rpc.sent.map((s) => s.method), ['report_run', 'checkpoint_run']);
    assert.deepEqual(rpc.sent.map((s) => s.args), [{ run_id: 'r-1' }, { run_id: 'r-2', seq: 1 }]);
    assert.ok(rpc.sent.every((s) => s.receiver === 'market.test' && s.signer === 'relayer.test'));
    assert.ok(rpc.sent[1].nonce > rpc.sent[0].nonce, 'nonces increase: the second was signed after the first landed');
    assert.equal(a.ok, true);
    assert.deepEqual(a.value, { paid: 'report_run' });
    assert.equal(a.events[0].event, 'srs_settlement');
    assert.equal(b.events.length, 1);
  } finally { rpc.close(); }
});

test('near: event and failure parsing', () => {
  const r = { receipts_outcome: [{ outcome: { logs: ['EVENT_JSON:{"standard":"s","version":"1","event":"e","data":[]}', 'EVENT_JSON:not json'], status: { Failure: { ActionError: { kind: 'x' } } } } }] };
  assert.equal(eventsOf(r).length, 1);
  assert.match(failureOf(r) ?? '', /ActionError/);
  assert.equal(failureOf({ status: { SuccessValue: '' }, receipts_outcome: [] }), undefined);
});
