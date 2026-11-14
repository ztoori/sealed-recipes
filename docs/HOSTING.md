# Hosting

How the public demo sandbox is served, and how every process limits its calls to outside services. Deploying the live testnet site is in [scripts/testnet/README.md](../scripts/testnet/README.md).

## The public demo sandbox

`npm run demo` is for one person on their own machine. A shared server needs `npm run gateway` (`scripts/gateway.mjs`) instead:

- **A private sandbox per visitor.** Demo accounts sign with keys anyone can derive (it is a demo wallet), and anyone can read a creator copy in the demo. On one shared market, a visitor could act as any account or open another visitor's recipe. The gateway gives each visitor their own marketplace (contract mirror, market, part reviews, sealed-recipe store), keyed by an HttpOnly cookie, so nothing one visitor does reaches anyone else. Sandboxes are deleted after 10 idle minutes; warm spares mean a new visitor doesn't wait.
- **One shared runner.** All sandboxes use one runner process. Each request names its marketplace; the runner accepts only local marketplaces on the gateway's ports and keeps their runs apart.
- **No dev endpoints.** Sandboxes run with `SRS_PUBLIC=1`, which turns off the endpoints the test suites use to crash the runner or make the solver fail.
- **Local only.** The gateway and every sandbox listen on 127.0.0.1; put Cloudflare Tunnel (or another reverse proxy) in front. Attestation reaches browsers through `/runner/attestation` on the same origin.

**Pre-compiled.** `npm run build` also bundles the marketplace, the runner and the seeding script into plain JavaScript (`scripts/build-node.mjs`, `*.bundle.mjs` next to each entry, gitignored); the gateway uses them when they are newer than the sources and falls back to TypeScript through tsx otherwise. Measured with 10 sandboxes starting at once: ready in 3.6 s instead of 5.9 s, 584 MB instead of 753 MB. `npm run demo` and the tests still run the TypeScript.

**Capacity.** Measured on a 2-CPU, 4 GB machine: 20 browsing visitors at once used about 830 MB in total (API p99 under 30 ms, no errors); 10 visitors running the full story at the same moment all passed. A sandbox's processes show about 100 MB RSS, but much of it is shared code, so each extra visitor costs about 40–45 MB of real memory (pre-compiled), plus one shared runner (~140 MB). Start-up is CPU-bound: when many visitors arrive in the same second, raise `SANDBOX_SPARE`.

**Traffic and performance.** `curl -s http://127.0.0.1:8080/gateway/metrics` (on the server only; it answers 404 through the tunnel) shows requests, latency percentiles, visitors, boot times and the memory and swap of every process; the gateway logs a one-line summary every minute (`journalctl -u srs-demo`). `npm run loadtest -- --visitors 20 --mode browse` (or `--mode story`) simulates visitors and prints what they experienced next to the server's peak memory.

`deploy/srs-demo.service` runs it under systemd from a read-only checkout; `deploy/cloudflared-config.example.yml` shows the tunnel side.

None of this makes the demo wallet a real wallet. Real signatures and a real chain are on the live page, below.

## Calls to outside services

Every call our processes make to a service outside the machine (FastNEAR, NEAR RPC, 1Click, NEAR AI Cloud, NVIDIA attestation) goes through one guard, `core/src/outbound.ts`, so a busy demo or a bug can't get us rate-limited or blocked:

- per service, a rate limit and a cap on calls in flight;
- "too many requests" (429) pauses that service for its `Retry-After` and the call is retried (a rejected request was never executed);
- network errors and 502/503/504 are retried, with backoff, only for requests that are safe to repeat: reads, NEAR RPC queries (never a transaction broadcast) and 1Click quotes (no funds move);
- repeated lookups (FastNEAR account data, the 1Click token list) are cached briefly, and identical lookups in flight share one request;
- a call that would wait too long fails fast instead of piling up.

Limits are per process and tunable without a code change: `SRS_OUTBOUND='{"api.fastnear.com":{"rps":20}}'`. The runner's `/health` shows the counts per service. Calls to this machine (the demo's mocks) are not limited.
