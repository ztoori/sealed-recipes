# Execution backends

A recipe's sealed graph can run on any backend that can do two things:
- hold the runner keys inside attested hardware;
- implement `ExecutionBackend` (`server/src/backends.ts`).

The contract does not change from one backend to another. It only checks these things:

| Contract expects | What it is |
|---|---|
| a registered runner: `signing_pk` (ed25519), `enc_pk_hex` (X25519), `codehash` | recipes and buyer inputs are sealed to `enc_pk_hex`; everything below is signed with `signing_pk` |
| `srs-quote-v3` signatures | quotes from dry runs, bound to buyer, job, sealed inputs, recipe version and price |
| `srs-ckpt-v1` signatures | durable progress (and partial billing in checkpoint mode) |
| `srs-run-v3` signatures | the final report: outcome, delivered value, parts used |

## Built: `TeeRunnerBackend`

This is the runner in `runner/`. It is a Node process designed for an Intel TDX confidential VM (dstack). Its keys come from the TEE's key service, and clients verify a fresh attestation before they seal anything. In local demo mode it runs with no hardware protection, and the UI says so.

## Integration path (not built): Chainlink CRE confidential workflow

| Interface method | How it would map |
|---|---|
| `attestation` | the enclave attestation of the TEE handler; the runner keys come from secrets fetched inside the enclave |
| `quote`, `start`, `resume` | HTTP-triggered handlers registered to run in a TEE (`handlerInTee` in the CRE SDK) |
| `events`, `approval` | an HTTP capability back to the marketplace; buyer payloads stay sealed to the buyer's reply key |
| reports to NEAR | CRE writes to EVM chains and Solana, not NEAR, so the signed reports are relayed by our relayer, exactly as today |

Things to resolve before building it:
- confidential workflows are in private beta;
- whether the parts' TypeScript compiles to CRE's WASM runtime;
- how long-running waits work inside a callback;
- how the runner keys get into the enclave.

## Integration path (not built): OutLayer (FastNEAR)

| Interface method | How it would map |
|---|---|
| `attestation` | OutLayer's Intel TDX attestation of code hash + input + output |
| key custody | Confidential Key Derivation: keys that exist only inside the WASM code and persist across upgrades |
| `quote`, `start` | HTTPS API calls, or `request_execution` from a NEAR contract via yield/resume |
| payment | OutLayer payment keys (USDC), or NEAR on-chain |

Things to resolve before building it:
- OutLayer runs Rust compiled to WASI, so the runner (TypeScript) would need porting, or only individual parts would run there;
- runs are short request/response jobs, so long workflows would use our checkpoints between OutLayer calls.

A narrower first step is to run individual untrusted parts as OutLayer WASM jobs, which gives them a hardware sandbox, while the recipe still runs in our runner.

## Why this matters

These parts are the same on every backend: competing quotes, guarantee deposits, per-part payouts, durable runs and versions. They live in the contract and the SRS-1 standard, not in any one executor. A workflow engine that comes to NEAR becomes another place to run recipes, not a replacement for the marketplace and settlement layer.
