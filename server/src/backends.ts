/**
 * Execution backends: where a sealed recipe actually runs.
 *
 * The contract does not care which machine executes a recipe. It only needs a registered runner identity
 * (an attested ed25519 signing key + an X25519 key recipes are sealed to) that signs quotes (srs-quote-v3),
 * checkpoints (srs-ckpt-v1) and reports (srs-run-v3). Anything that can hold those keys inside attested hardware
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
  /** dry run for a quote on the buyer's sealed request; returns a quote sealed to the buyer (or ok:false + error) */
  quote(job: QuoteJob): Promise<{ recipe_id: string; ok: boolean; error?: string; sealed_quote?: SealedEnvelope; sealed_error?: SealedEnvelope }>;
  /** never rejects: `unreachable` means no answer (network error or time limit), as opposed to a refusal */
  start(job: RunJob): Promise<{ ok: boolean; error?: string; unreachable?: boolean }>;
  /** server-sent event stream of a run (public progress + payloads sealed to the buyer) */
  events(runId: string): Promise<Response>;
  /** continue a run from its last checkpoint; 409 means it is still executing */
  resume(runId: string, job: ResumeJob): Promise<{ ok: boolean; status: number }>;
  /** relay the buyer's wallet decision */
  approval(runId: string, body: unknown): Promise<void>;
}

/**
 * Time limits for calls to the runner, which may be remote (the TDX runner behind the Phala gateway): a stalled
 * gateway fails a call instead of holding a quote, an attestation or a paid run's start for minutes. A quote is a
 * dry run of the whole recipe, so it gets the longest limit.
 */
export const RUNNER_TIMEOUTS_MS = { attestation: 15_000, quote: 90_000, call: 30_000, connect: 15_000 };

export class TeeRunnerBackend implements ExecutionBackend {
  readonly kind = 'tee-runner' as const;
  private headers: Record<string, string>;
  /** `tenant`: this marketplace's own address, sent when the runner is shared by several marketplaces (scripts/gateway.mjs) */
  constructor(readonly url: string, readonly runnerId: string, token: string, tenant?: string) {
    this.headers = { 'content-type': 'application/json', 'x-runner-token': token, ...(tenant ? { 'x-srs-tenant': tenant } : {}) };
  }
  /** the token never follows a redirect (a gateway or DNS change must not forward it to another host) */
  private post(path: string, body: unknown, timeoutMs = RUNNER_TIMEOUTS_MS.call) {
    return fetch(`${this.url}${path}`, { method: 'POST', headers: this.headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  }
  async attestation(nonce: string) {
    return (await fetch(`${this.url}/attestation?nonce=${encodeURIComponent(nonce)}`, { redirect: 'error', signal: AbortSignal.timeout(RUNNER_TIMEOUTS_MS.attestation) })).json();
  }
  async quote(job: QuoteJob) {
    try { return await (await this.post('/quotes', job, RUNNER_TIMEOUTS_MS.quote)).json(); } catch (e) { return { recipe_id: job.recipe_id, ok: false, error: String(e) }; }
  }
  /** never throws: an unreachable runner is { ok: false } like a refusal, so a caller cannot crash on a network error */
  async start(job: RunJob) {
    try { const r = await this.post('/runs', job); return r.ok ? { ok: true } : { ok: false, error: await r.text() }; }
    catch (e) { return { ok: false, unreachable: true, error: `runner unreachable: ${(e as Error).message}` }; }
  }
  /** the stream is long-lived: only connecting (until the response headers) is time-limited */
  async events(runId: string) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new Error('runner event stream: no response')), RUNNER_TIMEOUTS_MS.connect);
    try { return await fetch(`${this.url}/runs/${runId}/events`, { headers: this.headers, redirect: 'error', signal: ac.signal }); }
    finally { clearTimeout(t); }
  }
  async resume(runId: string, job: ResumeJob) { const r = await this.post(`/runs/${runId}/resume`, job); return { ok: r.ok, status: r.status }; }
  async approval(runId: string, body: unknown) { await this.post(`/runs/${runId}/approval`, body); }
  /** local demo only */
  async crash() { await this.post('/__crash', {}).catch(() => {}); }
}
