import type { PartHandler, AccessKey } from '../types.js';
import { viewAccount } from './near-rpc.js';

/**
 * Rules for app keys (function-call access keys) a wallet created when you signed in to a dApp.
 *  - revoke: the app's contract no longer exists, or it is on the creator's blocklist (sealed param);
 *  - revoke: an unlimited gas allowance for an app outside the creator's trusted list (sealed param);
 *  - review, never revoke: full-access keys. Each one can move every asset, but only the owner knows which device or
 *    wallet holds it, so removing one automatically could lock them out.
 * App keys cannot attach deposits, so they cannot transfer NEAR or tokens; they can still act in your name on the app.
 */
export const keyRisk: PartHandler = async (inputs, ctx) => {
  const keys = inputs.keys as AccessKey[];
  const block = new Set((ctx.params.blocklist as string[] | undefined) ?? []);
  const trusted = new Set((ctx.params.trusted as string[] | undefined) ?? []);
  const full = keys.filter((k) => k.kind === 'full');
  const out: AccessKey[] = [];
  const exists = new Map<string, boolean>();
  for (const k of keys) {
    if (k.kind === 'full') {
      out.push({ ...k, action: full.length > 1 ? 'review' : 'keep', reason: full.length > 1 ? `one of ${full.length} full-access keys: each can move everything; remove any you don't recognise in your wallet` : 'your only full-access key' });
      continue;
    }
    const app = k.receiver!;
    if (!exists.has(app)) exists.set(app, !!(await viewAccount(ctx, app)));
    if (!exists.get(app)) out.push({ ...k, action: 'revoke', reason: `${app} no longer exists` });
    else if (block.has(app)) out.push({ ...k, action: 'revoke', reason: `${app} is a known drainer` });
    else if (k.allowance === null && !trusted.has(app)) out.push({ ...k, action: 'revoke', reason: `unlimited allowance for an unvetted app (${app})` });
    else out.push({ ...k, action: 'keep', reason: trusted.has(app) ? `${app} is a recognised app` : `${app}: limited allowance` });
  }
  ctx.log(`${out.filter((k) => k.action === 'revoke').length} key(s) to revoke, ${out.filter((k) => k.action === 'review').length} to review`, { decisions: out.map((k) => ({ key: k.public_key.slice(0, 16), action: k.action, reason: k.reason })) });
  return { risky: out };
};
