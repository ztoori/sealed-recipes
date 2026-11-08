import { TIER_INFO, type ReleaseRecord, type Tier } from '../../../core/src/review';
import { Icon } from '../icons';
import { Tip } from '../ui';

/** The three admission tiers (SRS-1 §11), shown wherever a part's admission is discussed. */
export const TIER_ICON: Record<Tier, string> = { open: 'zap', reviewed: 'eye', signing: 'key' };

export function TierPill({ tier, long }: { tier: Tier; long?: boolean }) {
  const t = TIER_INFO[tier];
  return <span className={'pill tier-' + tier} title={`${t.label}: ${t.short}. ${t.why}`}><Icon name={TIER_ICON[tier]} size={12} />{t.label}{long ? ` · ${t.short}` : ''}</span>;
}

/** One row per tier: when a part falls in it, and what admits it. */
export function TierTable({ counts }: { counts?: Partial<Record<Tier, number>> }) {
  return (
    <div className="tiers">
      {(['open', 'reviewed', 'signing'] as Tier[]).map((k) => {
        const t = TIER_INFO[k];
        return (
          <div key={k} className={'tier tier-' + k}>
            <div className="row" style={{ gap: 8 }}><TierPill tier={k} /><b>{t.short}</b>{counts && <span className="small muted" style={{ marginLeft: "auto" }}>{counts[k] ?? 0} part{counts[k] === 1 ? '' : 's'}</span>}</div>
            <div className="small"><span className="muted">When: </span>{t.why}</div>
            <div className="small muted">{t.runs}</div>
          </div>
        );
      })}
    </div>
  );
}

/** How a released part got in, in one line. */
export function admissionLine(rec: ReleaseRecord | undefined): string {
  if (!rec) return 'Not in this runner release: recipes that use it fail before anything runs.';
  if (rec.basis === 'genesis') return 'Initial release: shipped by the owner before the review process existed.';
  if (rec.basis === 'automated') return `Admitted on automated checks alone (${rec.released_at}). Runs in the sandbox.`;
  return `Approved by ${rec.approvals.map((a) => a.reviewer).join(' and ')} (${rec.released_at}).`;
}

export function TiersTip() {
  return <Tip wide>How much a part must prove depends on what it can do. Open parts (pure, or reading public NEAR data) need only the automated checks and run in a sandbox. Parts that send buyer data somewhere new need one appointed reviewer. Parts that ask the buyer to sign need two. Every decision is recorded in the release log that the runner’s code hash covers.</Tip>;
}
