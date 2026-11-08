import type { PartHandler, StakePosition } from '../types.js';
import { view, NEAR } from './near-rpc.js';

/**
 * withdraw_all on every pool where unstaked NEAR has finished unbonding. The owner signs one call per pool; the NEAR
 * returns to the same account (pools always pay the delegator). Delivered is measured, not trusted: the part re-reads
 * each pool's get_account afterwards and counts what left the pool.
 */
const WNEAR = 'nep141:wrap.near'; // priced as NEAR for the value delivered
interface WState { phase: 'approval' | 'submitted'; ready: StakePosition[] }

export const stakingWithdraw: PartHandler = async (inputs, ctx) => {
  const account = String(inputs.account);
  const stakes = inputs.stakes as StakePosition[];
  const rs = ctx.resumeState as WState | undefined;
  const ready = rs?.ready ?? stakes.filter((s) => s.can_withdraw && BigInt(s.unstaked) > 0n);
  for (const s of stakes) if (BigInt(s.unstaked) > 0n && !s.can_withdraw) ctx.log(`${s.pool}: ${NEAR(s.unstaked)} NEAR still unbonding, skipped (ready after the unstaking delay, about 4 epochs)`);
  const receipt = (s: StakePosition, status: string, out: string) => ({ symbol: 'NEAR', source: s.pool, assetOut: WNEAR, amountOutUnits: out, minAmountOutUnits: s.unstaked, status });
  if (ctx.mode === 'quote' || ready.length === 0) return { receipts: ready.map((s) => receipt(s, 'QUOTED', s.unstaked)) };
  if (rs?.phase !== 'submitted') {
    if (!rs) await ctx.saveState({ phase: 'approval', ready } satisfies WState);
    const approval = (rs ? ctx.priorApproval : undefined) ?? await ctx.requestApproval({
      title: `Withdraw ${NEAR(ready.reduce((t, s) => t + BigInt(s.unstaked), 0n))} NEAR from ${ready.length} staking pool${ready.length > 1 ? 's' : ''}`,
      signer: account,
      transactions: ready.map((s) => ({ receiverId: s.pool, actions: [{ type: 'FunctionCall' as const, params: { methodName: 'withdraw_all', args: {}, gas: '75000000000000', deposit: '0' } }] })),
      summary: ready.map((s) => ({ symbol: 'NEAR', amount: String(NEAR(s.unstaked)), usd: 0, to: s.pool })),
    });
    if (!approval.approved) throw new Error('buyer rejected the withdraw_all transactions');
    await ctx.saveState({ phase: 'submitted', ready } satisfies WState);
  }
  const receipts = [];
  for (const s of ready) {
    const after = await view<{ unstaked_balance: string }>(ctx, s.pool, 'get_account', { account_id: account });
    const left = BigInt(after?.unstaked_balance ?? s.unstaked);
    const out = BigInt(s.unstaked) - left;
    receipts.push(receipt(s, out >= BigInt(s.unstaked) ? 'SUCCESS' : 'FAILED', (out > 0n ? out : 0n).toString()));
  }
  ctx.log(`${receipts.filter((r) => r.status === 'SUCCESS').length}/${receipts.length} pools paid out, confirmed by each pool's get_account`, { receipts });
  return { receipts };
};
