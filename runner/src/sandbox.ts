/**
 * The part sandbox (SRS-1 §11). Parts admitted without human review (the open tier) never run in the runner's own
 * process. Each call:
 *  - compiles the part to one JavaScript file, refusing any import outside the allowed runner helpers and node:crypto;
 *  - runs it in a separate Node process with the permission model on: it can read only that file, cannot write
 *    files, start processes or workers, load native code, or compile code from strings, and its network functions
 *    are removed before the part loads;
 *  - gives it one way out: ctx.http, relayed over IPC to the runner, which checks the declared hosts and counts calls;
 *  - kills the process when it runs past max_ms (time waiting for the buyer's wallet does not count), so even a tight
 *    loop is stopped, which the in-process limits cannot do.
 *
 * Production target: the same contract as a WASM module with fuel metering inside the TEE (see THREAT_MODEL.md).
 */
import { fork } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { ALLOWED_IMPORTS } from '../../core/src/review.js';
import type { ApprovalRequest, ApprovalResult, Endpoints } from './types.js';
import type { PartManifest } from '../../core/src/srs.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PARTS_DIR = join(HERE, 'parts');
const CHILD = join(HERE, 'sandbox-child.mjs');
const DIR = join(process.env.SRS_SANDBOX_DIR ?? tmpdir(), `srs-sandbox-${randomBytes(4).toString('hex')}`);

export class SandboxError extends Error {}

/** Bundles a part's TypeScript into one ES module. Imports are checked here as well as by the static scan. */
export async function compilePart(source: string): Promise<string> {
  const { build } = await import('esbuild');
  const r = await build({
    stdin: { contents: source, resolveDir: PARTS_DIR, loader: 'ts', sourcefile: 'part.ts' },
    bundle: true, write: false, format: 'esm', platform: 'node', target: 'node22', logLevel: 'silent',
    plugins: [{
      name: 'srs-sandbox-imports',
      setup(b) {
        b.onResolve({ filter: /.*/ }, (a) => {
          if (a.importer === '<stdin>' && !ALLOWED_IMPORTS.includes(a.path)) return { errors: [{ text: `import "${a.path}" is not allowed in a part` }] };
          if (a.path.startsWith('node:')) return a.path === 'node:crypto' ? { path: a.path, external: true } : { errors: [{ text: `${a.path} is not available in the sandbox` }] };
          return undefined;
        });
      },
    }],
  });
  return r.outputFiles[0].text;
}

/** Writes compiled code where the sandbox may read it; returns the path. */
export function stageCompiled(js: string): string {
  mkdirSync(DIR, { recursive: true });
  const file = join(DIR, `${createHash('sha256').update(js).digest('hex').slice(0, 24)}.mjs`);
  writeFileSync(file, js);
  return file;
}

export interface SandboxHost {
  http: (url: string, init?: RequestInit) => Promise<Response>;
  requestApproval: (req: ApprovalRequest) => Promise<ApprovalResult>;
  saveState: (state: unknown) => Promise<void>;
  log: (msg: string, data?: Record<string, unknown>) => void;
  wait: (ms: number) => Promise<void>;
}
export interface SandboxCall {
  file: string; exportName: string; inputs: Record<string, unknown>; maxMs: number;
  ctx: { nodeId: string; manifest: PartManifest; params: Record<string, unknown>; mode: 'run' | 'quote'; endpoints: Endpoints; resumeState?: unknown; priorApproval?: ApprovalResult };
}

type Msg = { t: string; id?: number; [k: string]: unknown };

/** Runs one part call in a fresh sandboxed process. Secrets are never passed in: open-tier parts call no models. */
export function runSandboxed(call: SandboxCall, host: SandboxHost): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = fork(CHILD, [], {
      execArgv: ['--permission', `--allow-fs-read=${call.file}`, `--allow-fs-read=${CHILD}`, '--disallow-code-generation-from-strings', '--max-old-space-size=128'],
      env: {}, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr?.on('data', (b) => { if (stderr.length < 2000) stderr += String(b); });
    let paused = 0, pausedAt = 0, settled = false;
    const t0 = Date.now();
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearInterval(timer); child.kill('SIGKILL'); fn(); };
    const timer = setInterval(() => {
      const active = Date.now() - t0 - paused - (pausedAt ? Date.now() - pausedAt : 0);
      if (active > call.maxMs) finish(() => reject(new SandboxError(`${call.ctx.manifest.id} exceeded max_ms (${call.maxMs} ms) and was stopped`)));
    }, 25);
    const pause = async <T>(fn: () => Promise<T>) => { pausedAt = Date.now(); try { return await fn(); } finally { paused += Date.now() - pausedAt; pausedAt = 0; } };
    const reply = (id: number | undefined, payload: Record<string, unknown>) => { if (!settled && child.connected) child.send({ id, ...payload }); };
    child.on('message', async (raw) => {
      const m = raw as Msg;
      try {
        if (m.t === 'http') {
          const init = m.init as RequestInit | undefined;
          const r = await host.http(String(m.url), init);
          reply(m.id, { status: r.status, headers: Object.fromEntries(r.headers), body: await r.text() });
        } else if (m.t === 'approval') reply(m.id, { result: await pause(() => host.requestApproval(m.req as ApprovalRequest)) });
        else if (m.t === 'save') { await pause(() => host.saveState(m.state)); reply(m.id, {}); }
        else if (m.t === 'wait') { await pause(() => host.wait(Number(m.ms))); reply(m.id, {}); }
        else if (m.t === 'log') host.log(String(m.msg), m.data as Record<string, unknown> | undefined);
        else if (m.t === 'done') finish(() => resolve((m.output ?? {}) as Record<string, unknown>));
        else if (m.t === 'error') finish(() => reject(new SandboxError(String(m.message))));
      } catch (e) { reply(m.id, { error: (e as Error).message }); }
    });
    child.on('exit', (code) => finish(() => reject(new SandboxError(`sandbox exited (${code})${stderr ? ': ' + stderr.split('\n').find((l) => /Error/.test(l)) : ''}`))));
    child.on('error', (e) => finish(() => reject(new SandboxError(e.message))));
    child.send({ t: 'start', file: call.file, exportName: call.exportName, inputs: call.inputs, ctx: call.ctx });
  });
}

/** The handler name a part exports (`export const <name>: PartHandler = …`). */
export const exportNameOf = (src: string) => /export\s+const\s+(\w+)\s*:\s*PartHandler\b/.exec(src)?.[1];
