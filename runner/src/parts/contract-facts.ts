import type { PartHandler, ContractFacts } from '../types.js';
import { accessKeys, isAccountId, view, viewAccount } from './near-rpc.js';

/**
 * What a contract exposes before you call it, from NEAR RPC alone: does it exist, does it have code, who can replace
 * that code (full-access keys on the contract account; none = locked), and whether it publishes verifiable source
 * metadata (NEP-330 contract_source_metadata). Also whether 1Click solvers list it as a token.
 */
const EMPTY_CODE = '11111111111111111111111111111111';
export const contractFacts: PartHandler = async (inputs, ctx) => {
  const account = String(inputs.contract).trim().toLowerCase();
  if (!isAccountId(account)) throw new Error(`invalid NEAR account id "${account}"`);
  const a = await viewAccount(ctx, account);
  const facts: ContractFacts = { account, exists: !!a, has_code: !!a && a.code_hash !== EMPTY_CODE, code_hash: a?.code_hash, storage_bytes: a?.storage_usage, full_access_keys: 0, source: null, listed_token: false };
  if (a) {
    facts.full_access_keys = (await accessKeys(ctx, account)).keys.filter((k) => k.access_key.permission === 'FullAccess').length;
    if (facts.has_code) facts.source = (await view<ContractFacts['source']>(ctx, account, 'contract_source_metadata')) ?? null;
  }
  const tokens = (await ctx.http(`${ctx.endpoints.oneclick}/v0/tokens`).then((r) => r.json())) as { assetId: string }[];
  facts.listed_token = tokens.some((t) => t.assetId === `nep141:${account}`);
  ctx.log(`${account}: ${!facts.exists ? 'does not exist' : !facts.has_code ? 'a plain account, no contract code' : `contract, ${facts.full_access_keys ? `${facts.full_access_keys} full-access key(s): upgradable` : 'locked (no full-access keys)'}, ${facts.source ? `source ${facts.source.link ?? '?'} v${facts.source.version ?? '?'}` : 'no NEP-330 source metadata'}`}`, { facts });
  return { facts };
};
