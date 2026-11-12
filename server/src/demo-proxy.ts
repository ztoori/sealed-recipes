/**
 * The guided demo under /demo on the live site, so one address serves both: requests to /demo/* go to the demo
 * gateway (scripts/gateway.mjs) on this machine, unchanged apart from the /demo prefix. The gateway keeps one sandbox
 * per visitor (cookie srs_sb, set for this site), created on the first demo page view only: visitors who stay on the
 * live pages cost nothing. Streams (the run's event stream) pass through as they arrive.
 *   SRS_DEMO_GATEWAY=http://127.0.0.1:8080 (default); empty to turn /demo off.
 * Mount before any body parser: request bodies are piped through as they are.
 */
import http from 'node:http';
import type express from 'express';

export function mountDemoProxy(app: express.Express, target = process.env.SRS_DEMO_GATEWAY ?? 'http://127.0.0.1:8080') {
  if (!target) return;
  const up = new URL(target);
  app.use('/demo', (req, res) => {
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
