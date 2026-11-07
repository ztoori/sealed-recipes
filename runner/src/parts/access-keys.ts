import type { PartHandler, AccessKey } from '../types.js';
import { accessKeys, isAccountId } from './near-rpc.js';

/** NEAR RPC view_access_key_list: every key that can sign for the account, full-access and app (function-call) keys. */
export const accessKeyList: PartHandler = async (inputs, ctx) => {
  const account = String(inputs.account);
  if (!isAccountId(account)) throw new Error(`invalid NEAR account id "${account}"`);
  const r = await accessKeys(ctx, account);
  const keys: AccessKey[] = r.keys.map((k) => {
    const p = k.access_key.permission;
    return p === 'FullAccess'
      ? { public_key: k.public_key, kind: 'full', nonce: k.access_key.nonce }
      : { public_key: k.public_key, kind: 'function-call', receiver: p.FunctionCall.receiver_id, methods: p.FunctionCall.method_names, allowance: p.FunctionCall.allowance, nonce: k.access_key.nonce };
  });
  ctx.log(`${account} has ${keys.length} access keys: ${keys.filter((k) => k.kind === 'full').length} full-access, ${keys.filter((k) => k.kind === 'function-call').length} app keys`);
  return { keys };
};
