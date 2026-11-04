/**
 * Execution backends: where a sealed recipe actually runs.
 *
 * The contract does not care which machine executes a recipe. It only needs a registered runner identity
 * (an attested ed25519 signing key + an X25519 key recipes are sealed to) that signs quotes (frs-quote-v2),
 * checkpoints (frs-ckpt-v1) and reports (frs-run-v3). Anything that can hold those keys inside attested hardware
 * and speak this interface can be a backend. The marketplace talks to backends only through this interface.
 *
 * Built: `TeeRunnerBackend`, the runner in this repo (runner/, deployable to an Intel TDX CVM with dstack).
 * Integration paths (docs/EXECUTION_BACKENDS.md, not built): a Chainlink CRE confidential workflow, or OutLayer
 * WASM in Intel TDX, holding the runner keys via their secret/key-derivation features.
 */
import type { SealedEnvelope } from '../../core/src/seal.js';

export interface QuoteJob { recipe_id: string; sealed_recipe: SealedEnvelope | undefined; sealed_job: SealedEnvelope; job_hash: string; buyer: string }
export interface RunJob { run_id: string; recipe_id: string; sealed_recipe: SealedEnvelope; sealed_inputs: SealedEnvelope }
export interface ResumeJob extends Omit<RunJob, 'run_id'> { checkpoint: unknown; approvals: unknown }

export interface ExecutionBackend {
  readonly kind: 'tee-runner' | 'chainlink-cre' | 'outlayer';
  readonly runnerId: string;
  /** fresh attestation binding the backend's keys and code hash to a client nonce */
  attestation(nonce: string): Promise<unknown>;
  /** dry run for recipe intents; returns a quote sealed to the buyer (or ok:false + error) */
  quote(job: QuoteJob): Promise<{ recipe_id: string; ok: boolean; error?: string; sealed_quote?: SealedEnvelope }>;
  start(job: RunJob): Promise<{ ok: boolean; error?: string }>;
  /** server-sent event stream of a run (public progress + payloads sealed to the buyer) */
  events(runId: string): Promise<Response>;
  /** continue a run from its last checkpoint; 409 means it is still executing */
  resume(runId: string, job: ResumeJob): Promise<{ ok: boolean; status: number }>;
  /** relay the buyer's wallet decision */
  approval(runId: string, body: unknown): Promise<void>;
}

export class TeeRunnerBackend implements ExecutionBackend {
  readonly kind = 'tee-runner' as const;
  private headers: Record<string, string>;
  constructor(readonly url: string, readonly runnerId: string, token: string) { this.headers = { 'content-type': 'application/json', 'x-runner-token': token }; }
  private post(path: string, body: unknown) { return fetch(`${this.url}${path}`, { method: 'POST', headers: this.headers, body: JSON.stringify(body) }); }
  async attestation(nonce: string) { return (await fetch(`${this.url}/attestation?nonce=${encodeURIComponent(nonce)}`)).json(); }
  async quote(job: QuoteJob) {
    try { return await (await this.post('/quotes', job)).json(); } catch (e) { return { recipe_id: job.recipe_id, ok: false, error: String(e) }; }
  }
  async start(job: RunJob) { const r = await this.post('/runs', job); return r.ok ? { ok: true } : { ok: false, error: await r.text() }; }
  events(runId: string) { return fetch(`${this.url}/runs/${runId}/events`, { headers: this.headers }); }
  async resume(runId: string, job: ResumeJob) { const r = await this.post(`/runs/${runId}/resume`, job); return { ok: r.ok, status: r.status }; }
  async approval(runId: string, body: unknown) { await this.post(`/runs/${runId}/approval`, body); }
  /** local demo only */
  async crash() { await this.post('/__crash', {}).catch(() => {}); }
}
