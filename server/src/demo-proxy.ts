/**
 * The demo's backend under /demo on the live site. The demo itself has its own address (SRS_DEMO_URL, e.g.
 * https://demo.sealedrecipes.xyz, served by the demo gateway through its own tunnel hostname); this path stays for one
 * reason: the live site's Compose page runs the practice composer against the demo's simulated services, and its
 * calls (/demo/api/…, /demo/runner/…) must stay on this origin so the sandbox cookie (srs_sb) applies.
 *   - a browser navigation to /demo… (Sec-Fetch-Mode: navigate) is redirected to SRS_DEMO_URL, same path and query,
 *     so old links keep working and the address bar always shows the demo's own address;
 *   - every other request goes to the demo gateway (scripts/gateway.mjs) on this machine, unchanged apart from the
 *     /demo prefix. Streams (the run's event stream) pass through as they arrive.
 *   SRS_DEMO_GATEWAY=http://127.0.0.1:8080 (default); empty to turn /demo off.
 *   SRS_DEMO_URL=https://demo.sealedrecipes.xyz; unset: navigations are served under /demo as before.
 * Mount before any body parser: request bodies are piped through as they are.
 */
import http from 'node:http';
import type express from 'express';

export function mountDemoProxy(app: express.Express, target = process.env.SRS_DEMO_GATEWAY ?? 'http://127.0.0.1:8080', demoUrl = process.env.SRS_DEMO_URL ?? '') {
  if (!target) return;
  const up = new URL(target);
  const home = demoUrl ? new URL(demoUrl) : null;
  if (home && home.protocol !== 'https:' && home.hostname !== '127.0.0.1' && home.hostname !== 'localhost') throw new Error('SRS_DEMO_URL must be an https URL');
  app.use('/demo', (req, res) => {
    // people go to the demo's own address; the browser keeps the #/… part across the redirect
    if (home && req.method === 'GET' && req.get('sec-fetch-mode') === 'navigate') {
      res.redirect(302, new URL(req.url === '/' ? '/' : req.url, home.origin).href);
      return;
    }
    // /demo → /demo/ so the page's relative asset and API paths resolve under /demo
    if (req.originalUrl === '/demo' || req.originalUrl.startsWith('/demo?')) { res.redirect(301, '/demo/' + req.originalUrl.slice(5)); return; }
    if (req.url.startsWith('/gateway/') && req.url !== '/gateway/health') { res.status(404).end(); return; } // the gateway's metrics stay on this machine
    const headers = { ...req.headers, host: up.host };
    const out = http.request({ protocol: up.protocol, hostname: up.hostname, port: up.port || 80, method: req.method, path: req.url, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    out.on('error', () => {
      if (!res.headersSent) res.status(503).type('text/plain').send('The guided demo is not running right now. The live marketplace is at /.');
      else res.end();
    });
    res.on('close', () => { if (!res.writableFinished) out.destroy(); });
    req.pipe(out);
  });
}
