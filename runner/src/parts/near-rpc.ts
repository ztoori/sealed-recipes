import type { PartCtx } from '../types.js';

/** NEAR JSON-RPC helpers over the part's capability-guarded fetch (ctx.http). Shapes are those of the public RPC. */
export async function rpc<T>(ctx: PartCtx, method: string, params: unknown): Promise<T> {
  const r = (await ctx.http(ctx.endpoints.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'srs', method, params }) })
    .then((x) => x.json())) as { result?: T; error?: { message?: string; cause?: { name?: string } } };
  if (r.result === undefined) { const e = new Error(r.error?.cause?.name ?? r.error?.message ?? 'rpc error'); (e as Error & { cause_name?: string }).cause_name = r.error?.cause?.name; throw e; }
  return r.result;
}
export const query = <T>(ctx: PartCtx, params: Record<string, unknown>) => rpc<T>(ctx, 'query', { finality: 'final', ...params });
/** view call; returns undefined when the method does not exist (MethodNotFound) */
export async function view<T>(ctx: PartCtx, contract: string, method: string, args: Record<string, unknown> = {}): Promise<T | undefined> {
  try {
    const r = await query<{ result: number[] }>(ctx, { request_type: 'call_function', account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result))) as T;
  } catch (e) { if (/METHOD_NOT_FOUND|MethodNotFound/.test((e as Error).message)) return undefined; throw e; }
}
export async function viewAccount(ctx: PartCtx, account: string) {
  try { return await query<{ amount: string; code_hash: string; storage_usage: number }>(ctx, { request_type: 'view_account', account_id: account }); }
  catch (e) { if (/UNKNOWN_ACCOUNT/.test((e as Error).message)) return undefined; throw e; }
}
export const accessKeys = (ctx: PartCtx, account: string) =>
  query<{ keys: { public_key: string; access_key: { nonce: number; permission: 'FullAccess' | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } } } }[] }>(ctx, { request_type: 'view_access_key_list', account_id: account });
export const isAccountId = (a: string) => a.length >= 2 && a.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(a);
export const NEAR = (yocto: string | bigint) => Number(BigInt(yocto) / 10n ** 18n) / 1e6; // yoctoNEAR → NEAR (6 dp)
