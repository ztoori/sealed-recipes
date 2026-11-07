# Landscape: comparable offerings, integrations, and where this project adds value

Sealed Recipes is not a workflow engine. It is a market and settlement layer for **sealed workflows that other
people pay to run**: buyers post a job, sealed recipes compete with signed and bonded quotes, and one settlement pays
every part author, the runner and the creator. Several products overlap with pieces of that. This page
says what each does, where it overlaps, how this project would use it, and what is actually built in this repo.

Status key: **built** (in this repo and tested), **partly** (some of it is built), **integration path (not built)**.
Facts we could not confirm from a primary source are marked *unverified*.

## Offerings

### Chainlink Runtime Environment (CRE)
- **What it is.** An orchestration layer: workflows written in Go or TypeScript, compiled to WASM, run by a
  Workflow DON when a trigger fires (cron, HTTP, EVM log; Solana log per a third-party summary). Results are agreed
  by DON consensus. Confidential Workflows run a handler inside a TEE so node operators cannot see the computation;
  that feature is in private beta. Chainlink announced that Coinbase's x402 standard lets AI agents pay for CRE workflows.
- **Supported chains.** EVM chains and Solana. We found no announcement of NEAR support.
- **Overlap.** Triggers, confidential execution, secrets, pay-per-use by agents.
- **Integration path.** A pluggable execution backend (the `ExecutionBackend` interface is built; see
  [EXECUTION_BACKENDS.md](EXECUTION_BACKENDS.md)): a recipe could execute as a CRE confidential workflow while
  this project's contract keeps doing quotes, bonds, settlement and revenue splits. Because CRE does not write to NEAR
  today, the run report would come back through this project's relayer, signed inside the TEE handler.
- **Status.** Integration path (not built).

### OutLayer (FastNEAR)
- **What it is.** Verifiable off-chain compute for NEAR: Rust compiled to WASM runs inside Intel TDX enclaves and
  returns results with an attestation. NEAR contracts call it through yield/resume; apps can call it over HTTPS.
  Features include encrypted secrets, confidential key derivation, MPC vaults and USDC payment keys. NEAR's docs note
  it is a third-party platform.
- **Overlap.** Attested execution and secrets for single functions.
- **Integration path.** Run untrusted or closed-source parts as OutLayer WASM jobs (attested per call) instead of
  bundling them into the runner image; use its secrets for parts that need API keys.
- **Status.** Integration path (not built).

### Shade Agents (NEAR)
- **What it is.** A framework for agents that run in TEEs (dstack; Phala Cloud by default) with an agent contract that
  registers agents after checking attestation, approved measurements and PPIDs, enforces guardrails, and gives
  valid agents multichain signing through Chain Signatures.
- **Overlap.** The attested-runner pattern this project uses (dstack/TDX runner, code hash pinned).
- **Integration path.** Replace the owner-approved `add_runner` with the Shade agent contract's on-chain attestation
  check, so any operator running the audited runner image can register. Use Chain Signatures for parts that act on
  other chains.
- **Status.** Partly: the runner is designed for dstack/TDX and clients verify its attestation; on-chain attestation
  and Chain Signatures are not built.

### NEAR AI Cloud, IronClaw and the Confidential GPU Marketplace
- **What they are.** NEAR AI Cloud runs models in TEEs (Intel TDX + NVIDIA GPU TEE) with per-request attestation; it
  is in beta. IronClaw is NEAR AI's open-source agent runtime with a WASM tool sandbox and routines (cron schedules,
  event triggers, webhook handlers); it can be deployed in TEEs on NEAR AI Cloud. The Confidential GPU Marketplace is
  a TEE-secured compute network for enterprise AI workloads. NEAR AI states a long-term goal of a decentralized
  confidential compute layer coordinated on-chain.
- **Overlap.** Private inference (used here), and IronClaw's routines cover triggers for a single agent.
- **Integration path.** NEAR AI Cloud is already the model backend for this project's AI parts. IronClaw routines
  could act as the buyer-side trigger that posts jobs on a schedule.
- **Status.** NEAR AI Cloud: built (AI parts call it and verify its signatures; local mode uses a mock with real
  secp256k1 signatures and no hardware quote). IronClaw and GPU Marketplace: integration path (not built).

### NEAR AI Agent Market
- **What it is.** A marketplace where AI agents bid on tasks, funds are escrowed, and payment settles in NEAR; built on
  NEAR Intents. Third-party reporting cites several hundred agents and thousands of jobs in 2026 (figures from
  secondary sources; *unverified* by us).
- **Overlap.** "Post a job, providers compete, escrowed payment" is close to this project's recipe intents.
- **Integration path.** List recipes as Agent Market services so that its agents can buy runs (not built).
- **Status.** Integration path (not built). Requesting new recipes is left to Agent Market itself; this project is for creating, sharing and running recipes.

### NEAR yield/resume (NEP-519)
- **What it is.** A protocol feature that lets a contract pause until an external service resumes it; the wait is
  limited to about 200 blocks (around 4 minutes) before a timeout.
- **Overlap.** Waiting on off-chain work.
- **Integration path.** Suitable for short off-chain calls (it is how OutLayer is called). Long workflows here use
  durable runs with on-chain checkpoints instead, because they wait for hours.
- **Status.** Not used; durable runs are built.

### NEAR Intents
- **What it is.** Intent-based cross-chain swaps settled by the verifier contract (`intents.near`), which applies a
  batch of intents together; cross-contract calls it makes are not guaranteed to finish in order.
- **Overlap.** None; it is infrastructure this project uses.
- **Integration path.** Already the payment rail (1Click EXACT_OUTPUT delivers the run price to the contract) and the
  swap rail (confidential swaps). Bundling a recipe's swaps into one verifier batch would make them all-or-nothing.
- **Status.** Built for payments and swaps (local mode uses 1Click fixtures; `npm run live-check` calls the real API).
  Atomic bundles: built against a local stand-in for the Verifier and Solver Relay (`intents.atomic-swap` part, ATOM
  recipe, `npm run test:atomic`): one NEP-413-signed bundle, all swaps and the payout or nothing. Not yet run against
  the live relay.

### Olas Mech Marketplace
- **What it is.** An on-chain marketplace where agents hire other agents' tools per request, paying in native tokens,
  OLAS or USDC, or by subscription.
- **Overlap.** Pay-per-request agent services.
- **Integration path.** None planned; a different chain family. It is a reference design for agent-to-agent payment.
- **Status.** Not applicable.

### Gelato Web3 Functions
- **What it is.** Serverless functions triggered by time intervals, on-chain events or webhooks, with secrets and state,
  executing on EVM chains.
- **Overlap.** Triggers and scheduled automation.
- **Integration path.** None on NEAR; a reference for the trigger model.
- **Status.** Not applicable.

### Venice (VVV / DIEM)
- **What it is.** A private AI platform. Staking VVV grants a share of inference capacity; DIEM represents $1 per day of
  API credit indefinitely. In its standard mode the GPU provider can see the plaintext of a request; its strongest
  privacy mode uses TEEs, including through NEAR AI.
- **Overlap.** Paying for compute and private inference, not workflows.
- **Integration path.** The prepaid-credit idea fits scheduled workflows: a buyer could hold run credits for a recipe
  instead of paying per run.
- **Status.** Integration path (not built).

## What only Sealed Recipes offers

Among the offerings above, as far as their public documentation shows:

- **Sealed recipes sold to third parties.** A creator's workflow is sealed in their browser to an attested runner.
  Buyers pay to run it without seeing it, and the marketplace stores only ciphertext. CRE's confidential workflows hide
  computation from node operators, but the workflow owner is the one who deploys and pays; selling runs of a hidden
  workflow to strangers is not part of its model. (Holds only when the runner runs in a TEE; local mode has none.)
- **Competing signed quotes on standard job types.** Recipes that implement a job type quote from dry runs inside the
  runner; quotes are signed, bound to buyer, job and recipe version, and single use.
- **Guaranteed outcomes.** A creator's guarantee deposit (a performance bond) pays the buyer any shortfall against the signed promise, up to the
  quoted cover. Bond safety (conservation, never overdrawn, no bond drain) is model-checked with TLA+ and its
  arithmetic proved with Z3; the proofs are about models tied to the code by conformance tests, not about the compiled
  Rust.
- **Per-part attribution and settlement in one receipt.** Every part author, the runner and the creator
  are paid in the same settlement, with conservation proved.
- **SRS-1 typed parts.** Swappable parts with typed ports, capability limits, resource limits, and disclosure of model,
  instructions, harness and verification with a withdrawal-risk label.
- **Market-driven prices for workflows.** Each recipe's price per run follows its demand inside a band its creator
  sets (an EIP-1559-style rule, on-chain and proved), and quotes lock the price; unique recipes for one job type compete
  on price and promised value. CRE and n8n-style tools price compute, not outcomes.
- **No investment features.** Buyers pay for a service and creators post collateral; there are no shares, dividends,
  tokens or trading, so nothing in the product is plausibly a security and any wallet can use it.
- **Durable runs with partial settlement.** Runs survive runner crashes with exactly-once deposits; in checkpoint mode
  each part is paid when it finishes.
- **Versions with notice.** Updates are announced on-chain and take effect after a notice period; every run executes
  the version it paid for.

## Where others are ahead

- **CRE**: decentralized execution with DON consensus (this project uses one attested runner), multiple trigger types,
  a secrets vault, institutional adoption, and far greater maturity.
- **NEAR AI Agent Market**: a live network of agents and jobs; this project is not deployed.
- **IronClaw**: routines (cron, events, webhooks) and a WASM sandbox for untrusted tools; this project has no triggers
  and runs parts as reviewed in-process code.
- **OutLayer**: production attested execution with secrets, confidential key derivation and a WASM sandbox, callable
  from NEAR contracts today.

## Sources

- Chainlink CRE: https://docs.chain.link/cre
- CRE overview (third-party summary of triggers and chains): https://eco.com/support/en/articles/17698095-what-is-chainlink-cre-the-chainlink-runtime-environment-explained
- CRE confidential workflows: https://docs.chain.link/cre/concepts/confidential-workflows
- SmartCon 2025 recap (x402 and CRE): https://blog.chain.link/smartcon-2025-recap/
- OutLayer on NEAR docs: https://docs.near.org/primitives/off-chain-compute/outlayer
- OutLayer docs: https://outlayer.fastnear.com/docs
- Shade Agents: https://docs.near.org/ai/shade-agents/concepts/framework-overview
- NEAR AI Cloud private inference: https://docs.near.ai/cloud/private-inference
- IronClaw: https://github.com/nearai/ironclaw
- IronClaw and Confidential GPU Marketplace: https://near.ai/blog/near-ai-launches-ironclaw-confidential-gpu-marketplace-and-multimodal-confidential-inference
- NEAR AI Cloud launch (DCML vision): https://near.ai/introducing-near-ai-cloud-private-chat
- NEAR AI Agent Market: https://near.ai/blog/introducing-near-ai-agent-market
- Agent Market coverage: https://en.cryptonomist.ch/2026/02/05/near-ai-agents-marketplace
- NEAR yield/resume: https://docs.near.org/smart-contracts/anatomy/yield-resume
- NEAR Intents execution: https://docs.near-intents.org/integration/verifier-contract/intent-types-and-execution
- Olas Mech Marketplace: https://olas.network/mech-marketplace
- Gelato Web3 Functions: https://gelato.cloud/blog/web3-functions-serverless-apps
- Venice and NEAR AI: https://www.near.ai/blog/venice-is-now-verifiably-private-with-near-ai
- Venice privacy modes: https://docs.venice.ai/overview/privacy
- Venice VVV/DIEM: https://www.spartangroup.io/insights/venice-the-gateway-to-intelligence
