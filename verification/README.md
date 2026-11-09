# Formal verification

The money logic and the run/quote/bond protocol are machine-checked. The proofs found three real bugs, and all three were fixed.

Contract v5 removed revenue shares, dividends and the share auction (see the main README, *No investment features*). Their proofs and vectors are archived with that design in `archive/revenue-shares-2026-11-04/` and at git tag `archive/revenue-shares`. Everything below is about the current contract. The *bond* is the recipe's guarantee deposit: collateral the creator posts.

| What | Tool | Result |
|---|---|---|
| Settlement split (0–8 parts), partial settlement at checkpoints, guarantee-deposit (bond) accounting, market-driven pricing (v6) | Z3 4.x SMT, unbounded integers in the u128 range | 66 theorems: 64 proved for all inputs, 2 reachability witnesses found as expected |
| Run / quote / bond lifecycle with an adversarial buyer | TLA+ / TLC | 7 invariants hold over 22,748,834 distinct states; the old rule is caught violating `NoBondDrain` |
| Durable runs: crashes anywhere, resume from checkpoints, partial billing | TLA+ / TLC | `DepositsOnce`, `PaidExactlyOnce` and liveness `EventuallyDone` hold (all 313 states); without the write-ahead checkpoint TLC finds a double deposit |
| Recipe versions with notice and the vault | TLA+ / TLC | `NoticeRespected`, `ExecutesPaidVersion` and `NoStrandedRun` hold (13,622 states); keeping only the current version strands runs |
| The proved models match the shipped code | Conformance vectors | 400 settlement, 200 deposit and 300 pricing cases, replayed by the Rust contract and the TypeScript mirror |

```bash
pip install z3-solver
npm run verify        # Z3 proofs + conformance freshness (~5 s)
npm run verify:tla    # also TLC on all three models (~10 min; Java 11+, TLA2TOOLS=/path/to/tla2tools.jar)
```

`verification/RESULTS.json` holds every theorem and its outcome.

## What exactly is proven

### Settlement (`smt/prove_money.py`, model `smt/models.py :: settlement` ⇔ `src/settlement.rs`)

These hold for every price, fee and reserve share in the u128 range, under the checks the contract enforces: protocol fee ≤ 10%, `reserve_bps` ≤ 10000.

- **Conservation.** Protocol + runner + every part + creator + reserve = the price, to the unit.
- **No negative payout,** and the reserve is never negative.
- **The reserve is the creator's money.** Creator + reserve = the remainder, so the reserve only moves part of the creator's own cut into the recipe's deposit.
- **Caps.** The protocol takes at most 10%; the reserve never exceeds the remainder, and is 0 when `reserve_bps` is 0.
- **Never fails when fees fit.** If the fixed fees fit in the price (the publish minimum) and the price is below 2¹²⁸/10⁴ units, no operation overflows and settlement returns a split.

### Partial settlement (contract v4, checkpoint mode)

For recipes with 1, 3 and 5 parts and any subset of parts already billed at checkpoints:
- the parts billed at checkpoints + the final payouts + the reserve equal the price exactly;
- a failed or timed-out run refunds `price − billed`, which is never negative, given the price minimum enforced at publish.

### Bonds (`models.py :: bond_*` ⇔ `src/bond.rs`)

- Lock, settle and refund each conserve `available + locked (+ compensation)`. Nothing underflows.
- A deposit (a top-up, or a settlement's reserve) only adds to `available` and leaves locked cover untouched.
- Compensation is exactly `min(max(0, promised − delivered), cover)`. A covered shortfall is paid in full.
- **Inductive ledger invariant over unbounded histories:** `locked = Σ cover of pending runs` and `deposited = available + locked + withdrawn + compensated`. It is preserved by deposit, withdraw, lock, refund, settle, and settle with the creator's reserve added.

### Market-driven pricing (`models.py :: next_price` ⇔ `src/pricing.rs`, contract v6)

For every list price, demand (`runs` < 2^64), target (1..10^6) and band (`floor <= ceiling <= 10^30`):
- **Never overflows.** Every checked operation in `next_price` fits in u128.
- **Stays in the band.** `floor <= next price <= ceiling`, whatever the starting price.
- **Bounded step.** From a price in the band, one period moves it by at most 1/8 (12.5%) either way.
- **Right direction.** `runs >= target` never lowers the price; `runs <= target` never raises it.
- **Monotone in demand.** More paid runs in a period never give a lower next price.
- **Every price in the band is viable.** If the floor covers the protocol fee on itself plus runner and part fees (checked at publish and `set_pricing`), so does every price `>= floor`.

Two extra checks make sure both branches of the rule are reachable under the hypotheses (Z3 finds a witness with
`runs > target` and one with `runs < target`). They were added after a near-miss: the first encoding computed both
branches' divisions unconditionally, and a division with a negative numerator has no solution, so the hypotheses
quietly excluded every case but `runs == target`. The vacuity check did not catch it (`runs == target` is satisfiable);
a mutation did (a 25% step still "proved"). The fixed encoding clamps both numerators at 0, and the same mutation now
fails `step-at-most-12.5%`.

### Protocol (`tla/BondedRuns.tla`)

Model: 2 runs, 2 quotes, 2 buyers, wallets up to 3, bond 3, market loss up to 1.

The buyer is adversarial:
- pays with any quote;
- drains the wallet at any moment;
- deposits less than asked.

The market may lose value or fail. The creator may withdraw at any time. Runs can time out.

Invariants:
- `BondConservation` and `LockedIsInFlightCover` (never overdrawn);
- `QuoteSingleUseAndBound`;
- `CompensationOnlyOnOk`;
- `HonestBuyerMadeWhole`;
- **`NoBondDrain`**: the bond pays at most the 2% re-check tolerance plus the market's actual loss on what the buyer really handed over.

### Durable runs (`tla/DurableRuns.tla` ⇔ `runner/src/main.ts`, `executor.ts`, `parts/intents-swap.ts`)

The model is a three-part recipe, scan → swap → merge, where:
- the runner can crash between any two steps, up to 3 times;
- the marketplace detects the crash and withdraws any open approval request, but the buyer may already have approved it;
- the runner resumes from the stored checkpoint.

Checked properties:
- **`DepositsOnce`:** the buyer's funds go into the swap at most once.
- **`PaidExactlyOnce`:** each part's author is paid once, either at a checkpoint or in the final receipt, never both.
- **`EventuallyDone`:** the run always completes, under fairness and with bounded crashes.

Removing the write-ahead store before the approval request (`MC_DurableNoWAL`) produces a double-deposit trace. That trace is the reason the swap part saves its quotes first.

### Versions (`tla/VersionedRecipes.tla` ⇔ contract v4 versioning, `server/src/main.ts` vault)

Checked properties:
- **Notice respected:** a version becomes current only at least `Delay` after it was announced.
- **Paid version executed:** every run executes the version it paid for, even when it runs after a newer version is live.
- **No stranded runs:** a pending run can always fetch its recipe.

With a vault that keeps only the current version (`MC_VersionsNoRetain`), TLC finds a stranded run.

## What the proofs found (and what changed)

1. *(v4, design since removed)* **Settlement could leave the contract insolvent** (Z3 counterexample: 3 shares, two runs). Per-run rounding sent dust to the protocol while holders' total claim rounded up across runs. Fix: the shareholders' share now telescopes (`src/settlement.rs`). Regression: `solvency_two_runs_rounding`.
2. *(v4, design since removed)* **Share transfers and auction fills could do the same.** The debt was rounded down after a share movement, so two holders could claim 3 units from 2 paid in. Fix: the debt rounds up and harvest saturates (`src/dividends.rs`). Regression: `solvency_transfer_rebase_rounding`.
3. **The bond could be drained during execution** (TLC trace, depth 5, in `tla/results/MC_v3.log`). The buyer passes the re-check, then deposits less than asked, and the shortfall is billed to the bond. Fix: bonded runs report `delivered` credited with what the buyer withheld after the re-check (`runner/src/metrics.ts :: creditedDelivered`).

Also fixed in v4: `remainder × royalty` could overflow and panic instead of returning `None` (found by the conformance vectors). The v5 split uses checked arithmetic throughout, and the conformance vectors include overflow and out-of-range `reserve_bps` cases that must return `None`.

## How the proofs are tied to the code

The Z3 models are written once in Python and run two ways:
- **symbolically,** for the proofs;
- **on concrete integers,** to generate `contracts/test-vectors/conformance-money.json`.

The Rust contract (`conformance_*` tests) and the TypeScript mirror must reproduce every vector exactly. That includes when settlement must return `None`.

Mutation checks confirm the link works. Each of these deliberate bugs is caught:
- paying the creator one unit more in the model fails 21 theorems;
- a 25% price step in the pricing model fails `step-at-most-12.5%`;
- rounding the reserve up in the Rust contract fails `conformance_settlement_matches_proved_model`.

Every proof also checks that its hypotheses are satisfiable, so nothing can pass vacuously.

## What is *not* proven (stated plainly)

- **The compiled Rust itself.** These are proofs about models that are line-by-line transcriptions of the Rust and are tied to it by conformance tests, not proofs over the compiled code. The next step is [Kani](https://github.com/model-checking/kani) harnesses on `settlement.rs`, `bond.rs` and `pricing.rs`. Kani needs a nightly toolchain that this build environment could not download.
- **The protocol beyond the models' bounds.** The bonds model uses 2 runs and wallets up to 3. The durable model uses 1 run, 3 parts and 3 crashes. The versions model uses 3 versions, 2 runs and 6 time steps. TLC is exhaustive within these bounds.
- **The durable store itself.** The models assume the marketplace's checkpoint store is durable once it acknowledges a write. In the demo it is in memory.
- **Signatures, hashing and TEE attestation.** These are assumed sound (ed25519, sha256, Intel TDX). In the model, a quote "binds the buyer" because the contract verifies a signature.
- **The runner, the marketplace server, the web UI, the local mocks and external services.** They are covered by tests (72 TypeScript, 112 Rust, an end-to-end story, an attack script, crash, version and atomicity suites), not by proofs. Formal proof is not meaningful for a UI or for third-party APIs.
- **Market moves in the seconds between the re-check and execution.** These are not insured by the bond, by design.
