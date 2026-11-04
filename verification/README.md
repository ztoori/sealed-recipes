# Formal verification

The money logic and the run/quote/bond protocol are machine-checked. The proofs found three real bugs, and all three are now fixed.

| What | Tool | Result |
|---|---|---|
| Settlement split (0–8 parts), bond accounting, dividend solvency | Z3 4.x SMT, unbounded integers in the u128 range | 64 theorems; 61 proved for all inputs, 3 are kept counterexamples to the old rules |
| Uniform-price batch auction (books of 2, 3 and 4 orders) | Z3 | 27 theorems proved |
| Run / quote / bond lifecycle with an adversarial buyer | TLA+ / TLC | 7 invariants hold over 22,748,834 distinct states; the old rule is caught violating `NoBondDrain` |
| The proved models match the shipped code | Conformance vectors | 400 settlement, 200 bond, 195 dividend and 60 auction cases, replayed by the Rust contract and the TypeScript mirror |

```bash
pip install z3-solver
npm run verify        # Z3 proofs + conformance freshness (~10 s)
npm run verify:tla    # also TLC (~10 min; Java 11+, TLA2TOOLS=/path/to/tla2tools.jar)
```

`verification/RESULTS.json` holds every theorem and its outcome.

## What exactly is proven

### Settlement (`smt/prove_money.py`, model `smt/models.py :: settlement` ⇔ `src/settlement.rs`)

These hold for every price, fee, royalty, share count and accumulator value in the u128 range, under the checks the contract enforces: protocol fee ≤ 10%, royalty ≤ 50%, total_shares > 0.

- **Conservation.** Protocol + rounding dust + runner + every part + creator + shareholders = the price, exactly.
- **No negative payout,** and the shareholders' share never exceeds the pool.
- **Fee caps.** The protocol takes at most 10% and the royalty at most 50% of the remainder.
- **Rounding bound.** Rounding withheld from shareholders ≤ 1 + total_shares/10¹⁸ units per run.
- **Never fails when fees fit.** If the fixed fees fit in the price and the recipe's lifetime revenue is below 3.4×10²⁰ units (3.4×10¹⁴ USDC), no multiplication overflows and settlement succeeds. The invariant that makes this inductive (`acc·TS ≤ lifetime_pool·10¹⁸`) is also proved.

### Bonds (`models.py :: bond_*` ⇔ `src/bond.rs`)

- Lock, settle and refund each conserve `available + locked (+ compensation)`. Nothing underflows.
- Compensation is exactly `min(max(0, promised − delivered), cover)`. A covered shortfall is paid in full.
- **Inductive ledger invariant over unbounded histories:** `locked = Σ cover of pending runs` and `deposited = available + locked + withdrawn + compensated`. It is preserved by deposit, withdraw, lock, refund and settle.

### Dividends (`models.py :: harvest/rebase` ⇔ `src/dividends.rs`)

The solvency invariant is K: `paid·10¹⁸ + Σ_h max(0, shares_h·acc − debt_h·10¹⁸) ≤ TS·acc`.

K is proved:
- to hold at publish;
- to be preserved by paid runs, claims, share transfers and auction fills;
- to imply that everything paid plus everything claimable is at most `floor(TS·acc/10¹⁸)`. That is exactly the total settlement ever set aside.

Together these mean that **for every possible history, holders can never claim more than the contract set aside.**

### Batch auction (`smt/prove_auction.py` ⇔ `src/auction.rs`)

These hold for every book of up to 4 orders, with any side, price and quantity:
- shares bought = shares sold = volume;
- the clearing price itself trades the maximum volume, and no price at all would trade more;
- limits are respected (buyers pay ≤ their limit, sellers get ≥ theirs), and fills never exceed order size;
- price-time priority holds;
- no remaining bid crosses a remaining ask;
- if nothing clears, no bid ever crossed an ask;
- the price lies between the tied candidates.

For each of the 60 random books in the conformance file, the generator checks that the encoding has exactly one solution.

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

## What the proofs found (and what changed)

1. **Settlement could leave the contract insolvent** (Z3 counterexample: 3 shares, two runs). Per-run rounding sent dust to the protocol while holders' total claim rounded up across runs. Fix: the shareholders' share now telescopes (`src/settlement.rs`). Regression: `solvency_two_runs_rounding`.
2. **Share transfers and auction fills could do the same.** The debt was rounded down after a share movement, so two holders could claim 3 units from 2 paid in. Fix: the debt rounds up and harvest saturates (`src/dividends.rs`). Regression: `solvency_transfer_rebase_rounding`.
3. **The bond could be drained during execution** (TLC trace, depth 5, in `tla/results/MC_v3.log`). The buyer passes the re-check, then deposits less than asked, and the shortfall is billed to the bond. Fix: bonded runs report `delivered` credited with what the buyer withheld after the re-check (`runner/src/metrics.ts :: creditedDelivered`).

Also fixed: `remainder × royalty` could overflow and panic instead of returning `None` (found by the conformance vectors).

## How the proofs are tied to the code

The Z3 models are written once in Python and run two ways:
- **symbolically,** for the proofs;
- **on concrete integers,** to generate `contracts/test-vectors/conformance-*.json`.

The Rust contract (`conformance_*` tests) and the TypeScript mirror must reproduce every vector exactly. That includes when settlement must return `None`.

Mutation checks confirm the link works. Each of these deliberate bugs is caught:
- dust off by one in the model fails 18 theorems;
- rounding the debt down in Rust fails the solvency test;
- taking the top tied price in Rust's auction fails conformance.

Every proof also checks that its hypotheses are satisfiable, so nothing can pass vacuously.

## What is *not* proven (stated plainly)

- **The compiled Rust itself.** These are proofs about models that are line-by-line transcriptions of the Rust and are tied to it by conformance tests, not proofs over the compiled code. The next step is [Kani](https://github.com/model-checking/kani) harnesses on `settlement.rs`, `bond.rs`, `dividends.rs` and `auction.rs`. Kani needs a nightly toolchain that this build environment could not download.
- **The auction beyond 4 orders.** Larger books are covered by the 60 conformance books, of up to 7 orders.
- **The protocol beyond the model's bounds** (2 runs, wallets up to 3). TLC is exhaustive within them.
- **Signatures, hashing and TEE attestation.** These are assumed sound (ed25519, sha256, Intel TDX). In the model, a quote "binds the buyer" because the contract verifies a signature.
- **The runner, the marketplace server, the web UI, the local mocks and external services.** They are covered by tests (34 TypeScript, 73 Rust, an end-to-end story, an attack script), not by proofs. Formal proof is not meaningful for a UI or for third-party APIs.
- **Market moves in the seconds between the re-check and execution.** These are not insured by the bond, by design.
