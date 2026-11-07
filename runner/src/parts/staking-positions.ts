import type { PartHandler, StakePosition } from '../types.js';
import { isAccountId, rpc, view, NEAR } from './near-rpc.js';

/**
 * Every staking pool the account delegates to (FastNEAR /v1/account/{id}/staking), with each pool's own view of the
 * delegation (get_account), its fee (get_reward_fee_fraction) and whether it is in the current validator set
 * (RPC validators). An inactive pool earns nothing; a high fee eats rewards.
 */
export const stakingPositions: PartHandler = async (inputs, ctx) => {
  const account = String(inputs.account);
  if (!isAccountId(account)) throw new Error(`invalid NEAR account id "${account}"`);
  const r = (await ctx.http(`${ctx.endpoints.fastnear}/v1/account/${account}/staking`).then((x) => x.json())) as { pools: { pool_id: string }[] };
  const current = new Set((await rpc<{ current_validators: { account_id: string }[] }>(ctx, 'validators', [null])).current_validators.map((v) => v.account_id));
  const stakes: StakePosition[] = [];
  for (const { pool_id } of r.pools) {
    const a = await view<{ staked_balance: string; unstaked_balance: string; can_withdraw: boolean }>(ctx, pool_id, 'get_account', { account_id: account });
    const fee = await view<{ numerator: number; denominator: number }>(ctx, pool_id, 'get_reward_fee_fraction');
    if (!a) continue;
    const p: StakePosition = { pool: pool_id, staked: a.staked_balance, unstaked: a.unstaked_balance, can_withdraw: a.can_withdraw, fee_pct: fee ? (fee.numerator / fee.denominator) * 100 : 0, active: current.has(pool_id) };
    stakes.push(p);
    ctx.log(`${pool_id}: ${NEAR(p.staked)} NEAR staked, ${NEAR(p.unstaked)} unstaked${BigInt(p.unstaked) > 0n ? (p.can_withdraw ? ' (ready to withdraw)' : ' (still unbonding)') : ''}${p.active ? '' : ' · NOT in the current validator set: earns nothing'}${p.fee_pct > 10 ? ` · fee ${p.fee_pct}%` : ''}`);
  }
  return { stakes };
};
