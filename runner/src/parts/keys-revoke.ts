import type { PartHandler, AccessKey, ReportItem } from '../types.js';
import { accessKeys } from './near-rpc.js';

/**
 * Deletes the app keys marked "revoke", in one transaction the owner signs (DeleteKey actions on their own account),
 * then re-reads the key list to report what is actually gone. Full-access keys are never deleted by this part.
 * Durable: the decision list is saved before the approval, so a restart never asks twice.
 */
interface RevokeState { phase: 'approval' | 'submitted'; revoke: AccessKey[] }
const short = (k: string) => `${k.slice(0, 14)}…${k.slice(-4)}`;

export const keysRevoke: PartHandler = async (inputs, ctx) => {
  const account = String(inputs.account);
  const keys = inputs.keys as AccessKey[];
  const rs = ctx.resumeState as RevokeState | undefined;
  const revoke = rs?.revoke ?? keys.filter((k) => k.action === 'revoke' && k.kind === 'function-call');
  const review = keys.filter((k) => k.action === 'review');
  const items = (status: (k: AccessKey) => string): ReportItem[] => [
    ...revoke.map((k) => ({ label: `App key for ${k.receiver}`, detail: `${short(k.public_key)}: ${k.reason}. ${status(k)}`, tag: 'bad' as const })),
    ...review.map((k) => ({ label: 'Full-access key', detail: `${short(k.public_key)}: ${k.reason}`, tag: 'warn' as const })),
    ...keys.filter((k) => k.action === 'keep').map((k) => ({ label: k.kind === 'full' ? 'Full-access key' : `App key for ${k.receiver}`, detail: `${short(k.public_key)}: ${k.reason}`, tag: 'ok' as const })),
  ];
  if (ctx.mode === 'quote' || revoke.length === 0) {
    return { report: { title: revoke.length ? `${revoke.length} risky app key${revoke.length > 1 ? 's' : ''} to revoke` : 'No app keys need revoking', items: items(() => 'Will be revoked when you run this.') } };
  }
  if (rs?.phase !== 'submitted') {
    if (!rs) await ctx.saveState({ phase: 'approval', revoke } satisfies RevokeState);
    const approval = (rs ? ctx.priorApproval : undefined) ?? await ctx.requestApproval({
      title: `Revoke ${revoke.length} app key${revoke.length > 1 ? 's' : ''} on ${account}`,
      signer: account,
      transactions: [{ receiverId: account, actions: revoke.map((k) => ({ type: 'DeleteKey' as const, params: { publicKey: k.public_key } })) }],
      summary: revoke.map((k) => ({ symbol: 'DeleteKey', amount: short(k.public_key), usd: 0, to: k.receiver! })),
    });
    if (!approval.approved) throw new Error('buyer rejected the DeleteKey transaction');
    await ctx.saveState({ phase: 'submitted', revoke } satisfies RevokeState);
  }
  const left = new Set((await accessKeys(ctx, account)).keys.map((k) => k.public_key));
  const gone = revoke.filter((k) => !left.has(k.public_key)).length;
  ctx.log(`${gone}/${revoke.length} keys confirmed deleted on-chain`);
  return { report: { title: `${gone} of ${revoke.length} risky app keys revoked`, items: items((k) => (left.has(k.public_key) ? 'Still present: the deletion did not land.' : 'Revoked: confirmed on-chain.')) } };
};
