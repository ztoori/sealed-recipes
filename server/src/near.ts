/**
 * The NEAR side of the live (testnet) marketplace: contract views over JSON-RPC and a relayer that signs and sends
 * transactions with one key, one at a time.
 *
 *  - Views go through the outbound guard (core/src/outbound.ts) like every other outside call.
 *  - The relayer is a queue: transactions from one key are sent strictly one after another, so concurrent runs
 *    finishing together never race on the key's nonce. The contract checks the runner's signature inside
 *    report_run / checkpoint_run, not who sends them, so the relayer key is only a gas payer: give it a
 *    function-call access key limited to the marketplace contract.
 *  - Contract events (NEP-297 `EVENT_JSON:` logs) are returned with each transaction result.
 */
import { readFileSync } from 'node:fs';
import { Account, JsonRpcProvider } from 'near-api-js';
import { outboundFetch } from '../../core/src/outbound.js';

export interface ChainEvent { standard: string; version: string; event: string; data: unknown[] }
export interface TxResult { tx_hash: string; ok: boolean; error?: string; events: ChainEvent[]; value?: unknown }

/** near-cli "legacy keychain" file: {"account_id":"…","public_key":"ed25519:…","private_key":"ed25519:…"} */
export function loadKeyFile(path: string, accountId?: string): { accountId: string; secretKey: string } {
  // near-cli-rs key files have no account_id (the account is the file name): pass it explicitly
  const k = JSON.parse(readFileSync(path, 'utf8')) as { account_id?: string; private_key?: string; secret_key?: string };
  const secretKey = k.private_key ?? k.secret_key;
  const id = accountId ?? k.account_id;
  if (!id || !secretKey?.startsWith('ed25519:')) throw new Error(`${path}: expected an ed25519 private_key, and the account (NEAR_RELAYER_ACCOUNT or account_id in the file)`);
  return { accountId: id, secretKey };
}

/** EVENT_JSON logs of every receipt in a transaction result */
export function eventsOf(result: { receipts_outcome?: { outcome: { logs: string[] } }[] }): ChainEvent[] {
  const out: ChainEvent[] = [];
  for (const r of result.receipts_outcome ?? []) for (const l of r.outcome.logs) {
    if (!l.startsWith('EVENT_JSON:')) continue;
    try { out.push(JSON.parse(l.slice('EVENT_JSON:'.length)) as ChainEvent); } catch { /* not ours */ }
  }
  return out;
}

/** the first failure in a transaction result, as text */
export function failureOf(result: { status?: unknown; receipts_outcome?: { outcome: { status: unknown } }[] }): string | undefined {
  const fail = (s: unknown) => (s && typeof s === 'object' && 'Failure' in (s as object) ? JSON.stringify((s as { Failure: unknown }).Failure) : undefined);
  for (const r of result.receipts_outcome ?? []) { const f = fail(r.outcome.status); if (f) return f; }
  return fail(result.status);
}

export class NearChain {
  private queue: Promise<unknown> = Promise.resolve();
  private relayer?: Account;
  constructor(readonly rpcUrl: string, readonly contractId: string, relayerKeyFile?: string, relayerAccount?: string) {
    if (relayerKeyFile) {
      const k = loadKeyFile(relayerKeyFile, relayerAccount);
      this.relayer = new Account(k.accountId, new JsonRpcProvider({ url: rpcUrl }), k.secretKey as `ed25519:${string}`);
    }
  }
  get relayerId() { return this.relayer?.accountId; }

  /** a view call on any contract (the marketplace by default); null when the method returns null */
  /** `optimistic` sees a transaction as soon as it executed; `final` (default) only once its block is final, a few seconds later */
  async view<T>(method: string, args: Record<string, unknown> = {}, contractId = this.contractId, finality: 'final' | 'optimistic' = 'final'): Promise<T> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 'srs', method: 'query', params: { request_type: 'call_function', finality, account_id: contractId, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } });
    const r = await outboundFetch(this.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(20_000) });
    const j = (await r.json()) as { result?: { result: number[] }; error?: { cause?: { name?: string }; data?: unknown; message?: string } };
    if (!j.result) throw new Error(`view ${contractId}.${method}: ${JSON.stringify(j.error?.cause ?? j.error?.data ?? j.error?.message ?? j.error)}`);
    return JSON.parse(Buffer.from(j.result.result).toString('utf8')) as T;
  }

  /** sign and send a call to the marketplace with the relayer key; strictly one at a time */
  relay(method: string, args: Record<string, unknown>, gasTgas = 100, depositYocto = 0n): Promise<TxResult> {
    const relayer = this.relayer;
    if (!relayer) return Promise.reject(new Error('no relayer key configured (NEAR_RELAYER_KEY_FILE)'));
    const run = async (): Promise<TxResult> => {
      const res = await relayer.callFunctionRaw({ contractId: this.contractId, methodName: method, args, gas: BigInt(gasTgas) * 10n ** 12n, deposit: depositYocto, waitUntil: 'EXECUTED_OPTIMISTIC' });
      const r = res as unknown as { transaction: { hash: string }; status?: { SuccessValue?: string }; receipts_outcome?: { outcome: { logs: string[]; status: unknown } }[] };
      const error = failureOf(r);
      const raw = r.status?.SuccessValue;
      let value: unknown;
      try { value = raw ? JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) : undefined; } catch { value = undefined; }
      return { tx_hash: r.transaction.hash, ok: !error, error, events: eventsOf(r), value };
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** a transaction's events and status, e.g. one a buyer's wallet sent */
  async txEvents(txHash: string, senderId: string): Promise<TxResult> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 'srs', method: 'tx', params: { tx_hash: txHash, sender_account_id: senderId, wait_until: 'EXECUTED_OPTIMISTIC' } });
    const r = await outboundFetch(this.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(30_000) });
    const j = (await r.json()) as { result?: { receipts_outcome?: { outcome: { logs: string[]; status: unknown } }[]; status?: unknown }; error?: unknown };
    if (!j.result) throw new Error(`tx ${txHash}: ${JSON.stringify(j.error)}`);
    const error = failureOf(j.result);
    return { tx_hash: txHash, ok: !error, error, events: eventsOf(j.result) };
  }
}
