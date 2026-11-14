# Security

Sealed Recipes is a hackathon build running on NEAR **testnet** with a test token. No real funds are at stake. Reports are still very welcome.

## Reporting a problem

Please report privately through GitHub: **Security › Report a vulnerability** on this repository. Include what you did, what happened and what you expected. If it is not sensitive (a bug in the demo, a wrong claim in the docs), a normal issue is fine.

## What is in scope

- The contract (`contracts/sealed-recipes`, `contracts/tusdc`): anything that moves or strands money, lets a quote be reused, or breaks the settlement invariants.
- The sealing and attestation path (`core/src/seal.ts`, `core/src/attestation.ts`, `web/src/tdx.ts`, `web/src/compose.ts`): anything that lets the marketplace, a creator or an observer read a buyer's inputs or a sealed recipe, or lets a runner pass the browser's checks without being the attested one.
- The runner (`runner/src`): escaping a part's declared limits or allowed hosts.
- The live site, https://sealedrecipes.xyz. Please keep probing read-only and light: it is one small server.

## What we already know

The limits of this build are written down, so you don't have to rediscover them:

- [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md): who is trusted for what.
- README, [What the sealing protects, and what it doesn't](README.md#what-the-sealing-protects-and-what-it-doesnt) and [Status](README.md#status): one runner and one runner key, no reproducible build, Intel TDX side channels.

## How the code is checked

`npm test` (106 tests), `npm run test:rust` (114), `npm run verify` (66 Z3 theorems), `npm run verify:tla` (three TLA+ models), `npm run test:privacy` (inputs never appear in the clear), `npm run attack:drain` (an adversarial buyer against the guarantee deposit). CI runs the tests, the typecheck, the end-to-end story and the pinned code-hash check on every push.
