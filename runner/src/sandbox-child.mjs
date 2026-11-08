// The sandboxed side of runner/src/sandbox.ts. Runs with Node's permission model on (read-only access to one file,
// no writes, no child processes, no workers, no native addons) and with code generation from strings disabled.
// Before any part code loads, every network and native escape is taken away; the part's only channel is IPC.
const send = process.send.bind(process);
const onMessage = process.on.bind(process, 'message');
for (const k of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'WebAssembly', 'SharedArrayBuffer', 'Atomics']) {
  try { delete globalThis[k]; } catch { /* not configurable */ }
}
for (const k of ['binding', '_linkedBinding', 'dlopen', 'getBuiltinModule', 'kill', 'chdir']) {
  try { Object.defineProperty(process, k, { value: undefined, configurable: false }); } catch { /* already locked */ }
}
// the parent starts this process with an empty environment; freeze it so nothing can be put there either
try { Object.defineProperty(process, 'env', { value: Object.freeze({}), configurable: false }); } catch { /* already locked */ }

let seq = 0;
const pending = new Map();
const call = (t, payload) => new Promise((ok, fail) => { const id = ++seq; pending.set(id, { ok, fail }); send({ t, id, ...payload }); });

onMessage(async (m) => {
  if (m.t !== 'start') {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.fail(new Error(m.error)); else p.ok(m);
    return;
  }
  try {
    const mod = await import(m.file);
    const handler = mod[m.exportName];
    if (typeof handler !== 'function') throw new Error(`the part does not export ${m.exportName}`);
    const ctx = {
      ...m.ctx,
      secrets: {},
      http: async (url, init = {}) => {
        const headers = init.headers ? Object.fromEntries(new Headers(init.headers)) : undefined;
        const body = typeof init.body === 'string' ? init.body : init.body == null ? undefined : String(init.body);
        const r = await call('http', { url: String(url), init: { method: init.method, headers, body } });
        return new Response(r.body, { status: r.status, headers: r.headers });
      },
      log: (msg, data) => send({ t: 'log', msg: String(msg), data }),
      requestApproval: async (req) => (await call('approval', { req })).result,
      saveState: async (state) => { await call('save', { state }); },
      wait: async (ms) => { await call('wait', { ms }); },
    };
    const output = await handler(m.inputs, ctx);
    send({ t: 'done', output: JSON.parse(JSON.stringify(output ?? {})) });
  } catch (e) {
    send({ t: 'error', message: String(e && e.message ? e.message : e) });
  }
});
