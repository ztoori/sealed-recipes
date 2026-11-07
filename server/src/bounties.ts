/**
 * Builder bounties: open demand on Sealed Recipes becomes paid work on NEAR AI Agent Market.
 *
 *   1. A job type with no recipe gets a bounty: a job on Agent Market that specifies the SRS-1 job type (inputs,
 *      output, metric) and exactly how the delivery will be checked.
 *   2. Builders bid there. The bounty's owner awards one; Agent Market moves the bid amount into its escrow.
 *   3. The builder publishes a sealed recipe on Sealed Recipes (the recipe itself is never sent to Agent Market) and
 *      submits `{"recipe_id": "..."}` as the deliverable.
 *   4. This module verifies the delivery against the contract and a live dry run (see `Verifier`), and accepts it on
 *      Agent Market only if every check passes, which releases the escrow. Otherwise it opens a dispute with the
 *      failed checks as the reason, instead of letting the 24-hour review window lapse into an automatic dispute.
 */
import type { AgentMarketClient, MarketBid, MarketJob } from './agent-market.js';

export interface Check { name: string; ok: boolean; detail: string }
export type Verifier = (deliverable: string, b: Bounty, workerNearAccount?: string) => Promise<Check[]>;

export interface Bounty {
  id: string; job_type: string; job_name: string; budget: string; token: 'USDC' | 'NEAR' | 'USD';
  market_job_id: string; market_url: string; posted_at: number; posted_by: string;
  status: JobStatus | 'verifying' | 'accepted' | 'rejected';
  bids: MarketBid[]; awarded?: MarketBid; deliverable?: string; checks?: Check[]; recipe_id?: string;
  transactions: MarketJob['transactions']; log: { at: number; msg: string }[];
}
type JobStatus = MarketJob['status'];

export function bountyDescription(jt: { id: string; name: string; description: string; inputs: Record<string, unknown>; output: string; metric: unknown }, origin: string) {
  return [
    `Build a Sealed Recipe for the job type "${jt.name}" (${jt.id}). Buyers have asked for it on Sealed Recipes and no recipe serves it yet.`,
    '',
    `Job type (SRS-1): ${jt.description}`,
    `Inputs: ${JSON.stringify(jt.inputs)}`,
    `Output: ${jt.output}. Metric: ${JSON.stringify(jt.metric)}`,
    '',
    'How to deliver:',
    `1. Compose a recipe from SRS-1 parts (catalog: ${origin}/api/catalog) that declares "implements": "${jt.id}".`,
    '2. Publish it sealed on Sealed Recipes from the NEAR account you bid with, with a guarantee deposit of at least 1 USDC. Do not send us the recipe itself.',
    '3. Submit this deliverable: {"recipe_id": "<YOUR RECIPE ID>"}',
    '',
    'Automatic acceptance when every check passes: the recipe is listed on the Sealed Recipes contract; it implements this job type; it was published after this bounty; its creator is the NEAR account that won the bid; it backs quotes with a guarantee deposit of at least 1 USDC; a live dry run on a test wallet returns a runner-signed quote that verifies and promises a value above zero.',
  ].join('\n');
}

export class Bounties {
  readonly list = new Map<string, Bounty>();
  constructor(private market: AgentMarketClient, private verify: Verifier, private marketWeb: string) {}

  private note(b: Bounty, msg: string) { if (b.log.at(-1)?.msg !== msg) b.log.push({ at: Date.now(), msg }); }

  async post(o: { job_type: { id: string; name: string; description: string; inputs: Record<string, unknown>; output: string; metric: unknown }; budget: string; token: 'USDC' | 'NEAR' | 'USD'; origin: string; by: string }) {
    if ([...this.list.values()].some((b) => b.job_type === o.job_type.id && !['accepted', 'rejected', 'cancelled', 'closed'].includes(b.status))) throw new Error('a bounty for this job type is already open');
    const job = await this.market.createJob({
      title: `Build a Sealed Recipe: ${o.job_type.name}`.slice(0, 200), description: bountyDescription(o.job_type, o.origin),
      tags: ['sealed-recipes', 'near', 'srs-1', o.job_type.id.split('@')[0].replace(/[^a-z0-9-]/g, '-')], budget_amount: o.budget, budget_token: o.token, deadline_seconds: 7 * 86400,
    });
    const b: Bounty = { id: job.job_id, job_type: o.job_type.id, job_name: o.job_type.name, budget: o.budget, token: o.token, market_job_id: job.job_id,
      market_url: `${this.marketWeb.replace(/\/$/, '')}/jobs/${job.job_id}`, posted_at: Date.now(), posted_by: o.by, status: job.status, bids: [], transactions: [], log: [] };
    this.note(b, `posted on Agent Market: ${o.budget} ${o.token}`);
    this.list.set(b.id, b);
    return b;
  }

  async award(id: string, bidId: string) {
    const b = this.list.get(id); if (!b) throw new Error('unknown bounty');
    const job = await this.market.award(b.market_job_id, bidId);
    b.awarded = b.bids.find((x) => x.bid_id === bidId); b.status = job.status; b.transactions = job.transactions ?? [];
    this.note(b, `awarded to @${b.awarded?.handle} for ${b.awarded?.amount} ${b.token}; Agent Market moved it into escrow`);
    return b;
  }

  /** Polls Agent Market for every open bounty; verifies and settles submitted deliveries. */
  async tick() {
    for (const b of this.list.values()) {
      if (['accepted', 'rejected', 'cancelled', 'closed', 'verifying'].includes(b.status)) continue;
      try {
        const job = await this.market.getJob(b.market_job_id);
        if (b.status === 'open') {
          const bids = await this.market.bids(b.market_job_id).catch(() => b.bids);
          for (const x of bids) if (!b.bids.some((y) => y.bid_id === x.bid_id)) this.note(b, `bid from @${x.handle}: ${x.amount} ${b.token}`);
          b.bids = bids;
        }
        b.transactions = job.transactions ?? b.transactions;
        if (job.status === 'submitted' && b.status !== 'submitted') {
          b.status = 'verifying'; b.deliverable = job.deliverable;
          this.note(b, `@${b.awarded?.handle} submitted: ${String(job.deliverable).slice(0, 120)}`);
          const checks = await this.verify(String(job.deliverable ?? ''), b, b.awarded?.near_account_id).catch((e) => [{ name: 'verification ran', ok: false, detail: (e as Error).message }]);
          b.checks = checks;
          try { b.recipe_id = String(JSON.parse(String(job.deliverable)).recipe_id); } catch { /* reported by the checks */ }
          if (checks.every((c) => c.ok)) {
            const done = await this.market.accept(b.market_job_id);
            b.status = 'accepted'; b.transactions = done.transactions ?? b.transactions;
            this.note(b, `all ${checks.length} checks passed: accepted on Agent Market, escrow released to @${b.awarded?.handle}`);
          } else {
            const failed = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; ');
            await this.market.dispute(b.market_job_id, `Delivery failed verification: ${failed}`).catch(() => {});
            b.status = 'rejected';
            this.note(b, `rejected (${failed}); dispute opened on Agent Market with these reasons`);
          }
        } else if (b.status !== 'verifying') b.status = job.status;
      } catch (e) { this.note(b, `Agent Market unreachable: ${(e as Error).message.slice(0, 160)}`); }
    }
  }
}
