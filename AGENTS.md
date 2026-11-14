# AGENTS.md

For AI agents and human reviewers who need to build, run and verify this repository without guessing. Everything here is a command you can run and the output you should see. The README tells the story; this file is the checklist.

## What this is, in three lines

Sealed Recipes is a marketplace on NEAR. An expert's workflow (a *recipe*, made of *parts*) is encrypted to a runner inside Intel TDX hardware and sold one run at a time. A user (a person or an AI agent) gets a runner-signed quote, pays into escrow in the contract, and one settlement pays the part builders, the runner, the protocol and the creator.

Keywords: NEAR, TEE, Intel TDX, dstack, Phala Cloud, remote attestation, DCAP, NEAR AI Cloud, private inference, confidential compute, sealed workflows, pay per run, escrow, NEP-141 `ft_transfer_call`, NEP-297 events, NEP-413, NEAR Intents, 1Click, AI agents, agent commerce, function-call access keys, scam detection, Z3, TLA+.

## Setup

```bash
git clone https://github.com/ztoori/sealed-recipes.git && cd sealed-recipes
npm install          # Node.js 20.6 or newer (22 recommended). Linux, macOS or WSL. No keys, no .env.
npm run doctor       # optional: lists what is installed and what each script needs
```

Nothing below needs a key, an account or the network unless its row says so. There is no data to seed by hand: `npm run demo` and every `test:*` script start their own runner and marketplace and seed the sample recipes (`scripts/seed.ts`). State lives in `.data/` (gitignored); delete it to start clean.

Optional toolchains: Rust (`npm run test:rust`), Python with `z3-solver` (`npm run verify`), Java with `tla2tools.jar` (`npm run verify:tla`), ffmpeg and Playwright (`npm run record:film`). On Ubuntu or WSL, `bash scripts/setup-wsl.sh --all` installs all of them.

## Verify in five minutes

Run these in order. Each exits non-zero on failure.

| # | Command | Time | Passes when |
|---|---|---|---|
| 1 | `npm run typecheck` | 20 s | no output |
| 2 | `npm test` | 40 s | `# pass 106`, `# fail 0` |
| 3 | `npm run test:e2e` | 30 s | last line `✔ story complete`, and above it `payouts + reserve == price ($0.7500): every unit accounted for` |
| 4 | `npm run test:privacy` | 40 s | `✔ privacy check passed: the canary accounts appear only inside data sealed to the buyer` |
| 5 | `npm run build` | 10 s | `web/dist/` holds `index.html` (local demo) and `live.html` (live site) |

## Every feature, and the command that shows it

| Feature | Command | What you should see |
|---|---|---|
| Whole loop: compose, seal, signed quote, payment, sealed run, one settlement | `npm run test:e2e` | two quotes (SWPR, CLNP), a policy picks CLNP, payouts sum to the price, `✔ story complete` |
| The app | `npm run demo` | http://127.0.0.1:8080 opens; press **Play demo** for the guided story |
| Sample recipes that read keys, staking, contracts, balances | `npm run test:recipes` | AUDT, KEYS, STAK, CHEK and TRIM each report their result |
| Privacy: inputs never appear in the clear | `npm run test:privacy` | 11 checks pass |
| Durable runs: the runner is killed twice mid-run | `npm run test:durable` | resumes, deposits once, settles once |
| Atomic swaps through NEAR Intents (mock) | `npm run test:atomic` | a failed leg moves nothing; then everything settles in one `execute_intents` |
| Recipe versions with a notice period | `npm run test:versions` | a run paid on v1 finishes on v1 after v2 is live |
| Prices follow demand inside the creator's band | `npm run test:pricing` | +12.5% after a busy period, back toward the floor when idle |
| An AI agent as the buyer (local) | after the attack demo below, or on a fresh `npm run demo`: `npm run story`, then `npm run agent` | quotes, a policy decision, payment, delivery checked against the promise |
| The same agent on the live site | `npm run agent:live` (internet) | attestation verified, three signed quotes, the cheapest within policy is paid on NEAR testnet, links to the payment and settlement |
| Attack: drain the creator's deposit | terminal 1: `npm run demo`; terminal 2: `npm run story`, then `npm run attack:drain` | the runner aborts, the buyer is refunded, the deposit is untouched |
| The live runner is Intel TDX running the audited code | `RUNNER_URL=https://sealedrecipes.xyz/runner npx tsx scripts/verify-quote.ts` (internet) | DCAP verification passes; keys and code hash match the contract |
| Money logic proved | `pip install z3-solver && npm run verify` | 66 of 66 theorems as expected |
| Protocol models checked | `npm run verify:tla` (Java, about 10 min) | three models hold; their unsafe variants fail as designed |
| Contract | `npm run test:rust` (Rust) | 114 tests pass |
| Contract wasm | `npm run build:wasm` (cargo-near) | `contracts/sealed-recipes/target/near/` |
| Real outside services | `npm run live-check` (internet; `NEAR_AI_API_KEY` for the AI part) | real 1Click dry quotes, FastNEAR and RPC reads, a verified NEAR AI Cloud completion |
| The film | `npm run build && npm run record:film` and `npm run record:x` (ffmpeg, Playwright) | `docs/media/demo.mp4` and `docs/media/demo-x.mp4` |

`npm run agent` and `npm run attack:drain` expect a running demo whose story has been played once (`npm run story` plays it from the terminal), because they buy the recipe the story publishes. Run the attack first: it puts the wallet back when it is done, while the agent really sweeps that wallet, so an attack after the agent finds nothing to quote (`no quote`). To start over, stop the demo, delete `.data/` and start it again.

## The live deployment

- Site: https://sealedrecipes.xyz. Plain-text summary with the HTTP API: https://sealedrecipes.xyz/llms.txt (source: `web/public/llms.txt`).
- Contract: `market.sealedrecipes.testnet`. Token: `tusdc.sealedrecipes.testnet` (test token, no value). Runner: `tee.sealedrecipes.testnet`.
- Read the chain yourself: `near view market.sealedrecipes.testnet get_recipe '{"recipe_id":"CHECK"}' --networkId testnet`, or the same through `GET https://sealedrecipes.xyz/api/chain/recipes/CHECK`.
- Deploying your own: [scripts/testnet/README.md](scripts/testnet/README.md) (ordered scripts `00-tools.sh` to `50-run.ts`; accounts in `scripts/testnet/config.sh`; server settings in `deploy/live.env.example`).

## Where things live

| Path | What |
|---|---|
| `contracts/sealed-recipes/` | the Rust contract: registry, escrow, signed quotes, settlement, guarantee deposits, pricing |
| `core/src/` | shared TypeScript: SRS-1, sealing, quotes, settlement mirror, attestation, outside-call guard |
| `runner/src/` | the sealed runner: dry-run quotes, execution, checkpoints, limits, sandbox, the parts |
| `server/src/` | `main.ts` local marketplace with mocks; `live.ts` the testnet marketplace |
| `web/src/` | the React app; `live/` is the testnet site; `components/DemoFilm.tsx` the film |
| `scripts/` | launchers, tests that boot the stack, the agent buyer, verification and deployment tools |
| `standard/` | the part catalog and the signed release log |
| `verification/` | Z3 proofs and TLA+ models, with results |
| `docs/` | [SRS-1](docs/SRS-1.md), [architecture](docs/ARCHITECTURE.md), [threat model](docs/THREAT_MODEL.md), [contract spec](docs/CONTRACT_SPEC.md), [events](docs/CONTRACT_EVENTS.md), [submission kit](docs/SUBMISSION.md) |

## What is not real, said once

Testnet only, with a test token. One runner, approved by the contract owner; no reproducible build yet. NEAR Intents has no testnet, so live payments are direct transfers and the Intents path runs against a mock locally. No wallet connect: live buyers pay from a guest key made in the browser. The no-code composer publishes on simulated services; on testnet a creator publishes from the command line. Wallet recipes accept any public account (proof of ownership is required before mainnet). The full list is in the README under *Limitations and next steps*.

## Working on the code

- `runner/src`, `core/src` and `standard/*.json` are inside the runner's code hash (`AUDITED_CODEHASH`, checked by CI). Changing them means a new runner release; nothing else does.
- Tests: `node --import tsx --test tests/<file>.test.ts` runs one file.
- No secrets in the repo. `.env.example` lists the optional keys.
