import type { PartHandler } from '../types.js';

interface Key { public_key: string; kind: 'full' | 'function-call'; receiver?: string; action?: 'revoke' | 'review' | 'keep'; reason?: string }
interface Holding { assetId: string; symbol: string; amount: string; decimals: number; usd: number }
interface Flag { assetId: string; symbol?: string; verdict: 'SCAM' | 'OK'; reason: string }
const MAX = 20; // keep the report small: the first entries of each list, with counts

/**
 * Account security audit: one report from the account's access keys (after the key-risk rules) and its tokens (after
 * the spam guard). What it weighs:
 *  - full-access keys can move everything the account holds; more than one means every extra device or wallet that
 *    holds one is a way in, so the whole token value is "at risk" until the owner reviews them;
 *  - app (function-call) keys can't move tokens, but can act in the owner's name on the app; the rules mark the ones
 *    to revoke (app gone, known drainer, unlimited allowance for an unvetted app);
 *  - keys that call the account's own contract are how contract-controlled accounts work (multisigs, lockups,
 *    DAOs: often with no full-access key at all). They are not dApp sign-ins, and deleting them could lock the
 *    account, so they are reported as contract-controlled and never as keys to delete (v1.1);
 *  - scam tokens are not a loss by themselves; the danger is interacting with them (trying to sell or "claim").
 * Every fix is something the owner does in their own wallet (e.g. delete a key); nothing here signs anything.
 */
export const auditReport: PartHandler = async (inputs, ctx) => {
  const account = String(inputs.account ?? '').trim().toLowerCase();
  const own = (k: Key) => k.kind === 'function-call' && !!account && k.receiver === account;
  const keys = inputs.keys as Key[];
  const holdings = inputs.holdings as Holding[];
  const flags = inputs.flags as Flag[];
  const full = keys.filter((k) => k.kind === 'full');
  const contractKeys = keys.filter(own);
  const apps = keys.filter((k) => k.kind === 'function-call' && !own(k));
  const revoke = keys.filter((k) => k.action === 'revoke' && !own(k));
  const review = keys.filter((k) => k.action === 'review');
  const scams = flags.filter((f) => f.verdict === 'SCAM');
  const scam = new Set(scams.map((s) => s.assetId));
  const value = +holdings.filter((h) => !scam.has(h.assetId)).reduce((s, h) => s + h.usd, 0).toFixed(2);
  const drainer = revoke.some((k) => /drainer/i.test(k.reason ?? ''));
  const severity = drainer || review.length > 0 ? 'high' : revoke.length > 0 || scams.length > 0 ? 'medium' : 'low';
  const short = (k: string) => `${k.slice(0, 16)}…${k.slice(-4)}`;
  const items: { label: string; detail: string; tag?: 'ok' | 'warn' | 'bad' }[] = [
    { label: 'Verdict', detail: `${severity} risk`, tag: severity === 'high' ? 'bad' : severity === 'medium' ? 'warn' : 'ok' },
    { label: 'Full-access keys', detail: full.length === 0 ? (contractKeys.length ? 'none: the account is controlled by its own contract' : 'none (the account is locked)') : full.length === 1 ? '1: your only full-access key' : `${full.length}: each can move everything; review the ones you don't recognise`, tag: full.length > 1 ? 'bad' : 'ok' },
    ...(contractKeys.length ? [{ label: 'Contract-controlled keys', detail: `${contractKeys.length} key(s) that call this account's own contract (multisig / lockup / DAO pattern): keep them; change them only through the contract`, tag: 'ok' as const }] : []),
    { label: 'App keys', detail: `${apps.length} key(s), ${revoke.length} to revoke`, tag: revoke.length ? 'warn' : 'ok' },
    { label: 'Tokens', detail: `${holdings.length} held, ${scams.length} flagged as scams, $${value} in the rest`, tag: scams.length ? 'warn' : 'ok' },
    { label: 'Value at risk', detail: full.length > 1 ? `$${value}: any of the ${full.length} full-access keys can move it` : 'no extra full-access keys found', tag: full.length > 1 ? 'bad' : 'ok' },
  ];
  const fixes = [
    ...review.slice(0, MAX).map((k) => ({ action: 'review full-access key', key: short(k.public_key), why: k.reason ?? '' })),
    ...revoke.slice(0, MAX).map((k) => ({ action: 'delete app key', key: short(k.public_key), app: k.receiver ?? '', why: k.reason ?? '' })),
    ...scams.slice(0, MAX).map((s) => ({ action: 'never interact with this token', token: s.symbol ?? '', contract: s.assetId.replace(/^nep141:/, ''), why: s.reason })),
  ];
  const report = {
    title: `${severity} risk: ${review.length + revoke.length} key issue(s), ${scams.length} scam token(s)`,
    severity, value_usd: value, items, fixes,
    counts: { full_access_keys: full.length, contract_keys: contractKeys.length, app_keys: apps.length, revoke: revoke.length, review: review.length, tokens: holdings.length, scams: scams.length },
    note: 'Fixes are done by you, in your own wallet. This audit signs nothing and moves nothing.',
  };
  ctx.log(report.title, { counts: report.counts });
  return { report };
};
