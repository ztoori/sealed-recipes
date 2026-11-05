# `fungible-recipes` — NEAR smart contract

Rust / near-sdk 5.30. The canonical interface is [`docs/CONTRACT_SPEC.md`](../../docs/CONTRACT_SPEC.md).

What it does:

- **Registry.** Part authors register parts (code, specialist agents, data sources) with a fixed per-call fee. The owner approves TEE runners
  (ed25519 signing key, X25519 sealing key, image codehash, fee per run).
- **Sealed recipes.** A creator publishes a recipe. Only its `sealed_hash` and its list of parts go on chain;
  the workflow graph itself stays encrypted to the runner. The creator sets `reserve_bps` (0–10000): the share
  of each run's remainder that goes into the recipe's guarantee deposit instead of the creator's balance.
  Publishing fails if the price can't cover protocol, runner and part fees.
- **Pay-per-run through NEAR Intents.** A 1Click swap delivers the payment token with
  `customRecipientMsg = {"action":"run",...}`, which arrives as `ft_transfer_call` → `ft_on_transfer`. The run
  stays in escrow until the runner sends a report.
- **Recipe intents with bonded quotes.** Recipes compete for a buyer's job with quotes signed by the TEE runner
  (`frs-quote-v2|…`). A quote is bound to the recipe version, the job, the buyer's sealed inputs and the buyer,
  and can back only one run. It names a `cover` (at most `promised`) that the recipe's bond (`{"action":"bond"}`)
  must hold in full; paying the quote locks that cover. If the run delivers less than promised, the shortfall is
  paid to the buyer from the cover in the same settlement. A runner that finds the inputs or market changed since
  the quote reports `abort`: the buyer is refunded and the recipe's record is not penalised. Each recipe keeps a
  public track record: successful, failed and aborted runs, promised vs delivered totals, compensation paid,
  bond available and locked.
- **Signed settlement.** Anyone can relay `report_run`, because the contract checks the runner's ed25519
  signature (`env::ed25519_verify`). In one receipt it pays the protocol, the runner, every part author used
  (not already billed at a checkpoint) and the creator, and adds the reserve to the recipe's guarantee deposit
  (`bond_available`). A `fail` or `abort` report refunds the buyer. If no report arrives within 15 minutes, the
  buyer can call `reclaim_run`.
- **Market-driven prices (v6, `src/pricing.rs`).** Each recipe's `price_per_run` is its current list price. It follows
  paid runs per period inside a band the creator sets (`price_floor`, `price_ceiling`, `target_runs`), by the
  EIP-1559 base-fee rule: at most ±12.5% a period. A signed quote (`frs-quote-v3`) locks a price inside the band;
  a run msg's `max_price` caps what the buyer pays.
- **No investment features (v5).** Recipes are products, not share classes: there are no shares, dividends,
  order books or auctions. Every payment is a fee for a service rendered (protocol, runner, part author, creator).
  The guarantee deposit (`bond_*` in code) belongs to the creator, backs quotes, pays shortfalls to buyers, and
  can be withdrawn with `withdraw_bond`; it earns nothing.

Settlement split (`src/settlement.rs`, all floors, checked arithmetic, `None` on fees above the price or overflow):

```
protocol  = floor(price * protocol_fee_bps / 10000)
remainder = price - protocol - runner_fee - sum(part_fees)
reserve   = floor(remainder * reserve_bps / 10000)   -> bond_available
creator   = remainder - reserve                       -> creator's balance
protocol + runner_fee + sum(part_fees) + reserve + creator == price   (exact)
```

## Test

```bash
cargo test          # 105 unit tests, including the shared vectors ../test-vectors/settlement.json and bonds.json and the settlement, bond and pricing conformance cases from verification/
cargo clippy --all-targets
```

`../test-vectors/settlement.json` (8 v5 cases) is the file the TypeScript mirror is tested against too, so
on-chain and off-chain math must agree. The v4 share, dividend and auction code is archived under the git tag
`archive/revenue-shares`.

## Build the wasm

Requires `rustup target add wasm32-unknown-unknown` and [cargo-near](https://github.com/near/cargo-near).

```bash
cargo near build non-reproducible-wasm
# -> target/near/fungible_recipes.wasm
```

Before a reproducible build (`cargo near build reproducible-wasm`), pin `image` / `image_digest` in
`Cargo.toml` from a fresh `cargo near new` template.

## Deploy to testnet (near-cli-rs)

```bash
export CONTRACT=frs-demo.testnet          # your account
export OWNER=you.testnet
# PLACEHOLDER: any NEP-141 you control on testnet (e.g. a test USDC you deployed). Mainnet USDC is
# 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 (NEAR Intents has no testnet).
export TOKEN=usdc.fakes.testnet

near account create-account sponsor-by-faucet-service $CONTRACT autogenerate-new-keypair save-to-keychain network-config testnet create

cargo near deploy build-non-reproducible-wasm $CONTRACT \
  with-init-call new json-args "{\"owner\":\"$OWNER\",\"payment_token\":\"$TOKEN\",\"protocol_account\":\"$OWNER\",\"protocol_fee_bps\":200,\"update_delay_ns\":\"86400000000000\",\"price_period_ns\":\"3600000000000\"}" \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-keychain send

# approve the TEE runner after verifying its attestation (keys + codehash are printed at runner boot
# and returned by GET /attestation)
near contract call-function as-transaction $CONTRACT add_runner json-args \
  '{"id":"runner.testnet","signing_pk":"ed25519:<base58>","enc_pk_hex":"<64 hex>","codehash":"<runner codehash hex, printed at runner boot>","fee_per_run":"30000"}' \
  prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as $OWNER network-config testnet sign-with-keychain send

# register the token's storage for the contract so it can receive ft_transfer_call
near contract call-function as-transaction $TOKEN storage_deposit json-args "{\"account_id\":\"$CONTRACT\"}" \
  prepaid-gas '30.0 Tgas' attached-deposit '0.0125 NEAR' sign-as $OWNER network-config testnet sign-with-keychain send
```

The contract pays for its own storage in v1, so there are no per-user storage deposits. In production,
`register_part` and `publish_recipe` should require a storage deposit (sybil resistance).

## Methods

| Method | Kind | Args |
|---|---|---|
| `new` | init | `owner: AccountId, payment_token: AccountId, protocol_account: AccountId, protocol_fee_bps: u16` (≤1000), `update_delay_ns: U64` (notice before a new recipe version takes effect), `price_period_ns: U64` (pricing period, >0) |
| `add_runner` | owner | `id: AccountId, signing_pk: String ("ed25519:…"), enc_pk_hex: String (64 hex), codehash: String, fee_per_run: U128` |
| `set_runner_active` | owner | `id: AccountId, active: bool` |
| `register_part` | call | `id: String, version: String, fee_per_call: U128, manifest_hash: String` |
| `publish_recipe` | call | `id: String (^[A-Z0-9]{3,6}$), name: String, sealed_hash: String, runner_id: AccountId, parts: Vec<String>, price_per_run: U128, reserve_bps: u16 (≤10000), settle_mode: Option<String>` (`"final"` default, or `"checkpoint"`), `pricing: Option<{price_floor: U128, price_ceiling: U128, target_runs: u32}>` (omitted: fixed price) |
| `set_pricing` | creator | `id: String, pricing: {price_floor, price_ceiling, target_runs}` (floor must cover the fees) |
| `update_price` | anyone | `id: String` → `U128` (applies ended pricing periods; also done lazily by the next payment) |
| `update_sealed` | creator | `id: String, sealed_hash: String` (64 hex): announces the next version, active after `update_delay_ns` |
| `cancel_update` | creator | `id: String` |
| `apply_update` | anyone, once due | `id: String` (also applied lazily by the next run payment) |
| `checkpoint_run` | anyone relays; runner-signed `frs-ckpt-v1` | `run_id: String, seq: u32, state_hash: String, parts_done: Vec<String>, signature: Base64VecU8`: records progress (extends the timeout) and, in checkpoint mode, pays the parts done |
| `ft_on_transfer` | payment token only | `sender_id: AccountId, amount: U128, msg: String` → `U128("0")` |
| `report_run` | anyone (signature-gated) | `run_id: String, outcome: String ("ok" \| "fail" \| "abort"), parts_used: Vec<String>, output_hash: String, delivered: U128, signature: Base64VecU8` → `Vec<Payout>` |
| `withdraw_bond` | creator | `recipe_id: String, amount: U128` (≤ `bond_available`; credited to the creator's balance) |
| `reclaim_run` | buyer, 15 min after the last progress (payment or checkpoint) | `run_id: String`; refunds `amount - billed` |
| `withdraw` | call, 1 yocto | `amount: Option<U128>` (default: whole balance) |
| `on_withdraw` | private callback | `account_id, amount` |
| views | view | `get_config`, `get_recipe(recipe_id)`, `list_recipes(from_index?, limit?)`, `get_part(part_id)`, `list_parts(from_index?, limit?)`, `get_runner(runner_id)`, `get_run(run_id)`, `balance_of(account_id)`, `quote_settlement(recipe_id, parts_used?)` → `{price, protocol, runner, parts, remainder, reserve, creator}` |

`ft_on_transfer` msgs:

```json
{"action":"run","recipe_id":"CLNP","run_id":"r-123","inputs_hash":"<sha256 hex>","on_behalf_of":"bob.testnet"}
{"action":"run","recipe_id":"CLNP","run_id":"r-124","inputs_hash":"<sha256 hex>","on_behalf_of":"bob.testnet",
 "max_price":"800000",
 "quote":{"sealed_hash":"<recipe sealed_hash>","job_hash":"<sha256 hex>","price":"750000","expected":"28000000","promised":"27500000",
          "cover":"25000000","expires_ns":"1793500000000000000","signature":"<base64>"}}
{"action":"bond","recipe_id":"CLNP"}
```

`on_behalf_of` is optional (defaults to `sender_id`). It exists because with NEAR Intents the
`ft_transfer_call` comes from the solver, not from the buyer.

Failure semantics: if a `run` or `bond` msg with `on_behalf_of` fails a business rule (unknown or unlisted
recipe, duplicate or malformed `run_id`, malformed `inputs_hash`, underpayment, quote checks), the
contract does **not** panic: it credits the whole amount to `on_behalf_of` and emits `transfer_rejected`,
because a panic would refund the Intents/solver side rather than the buyer. Without `on_behalf_of` it panics
and the token refunds the sender. Validation: part ids `^[a-z0-9._@-]{1,64}$`, run ids `^[A-Za-z0-9_-]{1,64}$`,
`inputs_hash` / `output_hash` 64 lowercase hex, `publish_recipe` needs at least one part. Each `Run` records
the recipe's `sealed_hash` at payment time. Exact event shapes: [`docs/CONTRACT_EVENTS.md`](../../docs/CONTRACT_EVENTS.md).

Runner signatures: ed25519 over the UTF-8 strings

```
frs-run-v3|<contract_account_id>|<run_id>|<recipe_id>|<ok|fail|abort>|<output_hash>|<delivered>|<parts_used joined by ",">
frs-quote-v2|<contract_account_id>|<recipe_id>|<sealed_hash>|<job_hash>|<inputs_hash>|<buyer>|<expected>|<promised>|<cover>|<expires_ns>
```

`buyer` is `on_behalf_of`, else `sender_id`. Quote checks, in order: `job_hash must be 64 lowercase hex`,
`quote for an outdated recipe version`, `runner inactive`, `invalid quote signature`, `quote expired`,
`quote already used`, `cover exceeds promise`, `bond below quoted cover`.

Events: NEP-297 `EVENT_JSON:` logs with `standard: "fungible-recipes"`, `version: "1.0.0"`. The event names are
`runner_added`, `part_registered`, `recipe_published`, `recipe_update_scheduled`, `recipe_update_cancelled`,
`recipe_updated`, `run_requested`, `run_checkpoint`, `frs_settlement`, `run_refunded`, `transfer_rejected`,
`withdrawn`, `withdraw_failed`, `bond_posted` and `bond_withdrawn`. `frs_settlement` data, in order: `run_id, recipe_id,
buyer, price, output_hash, payouts, reserve, delivered, compensation`; payouts are `protocol`, `runner`, unbilled
`part:<id>` entries, then `creator`.

## v4: durable runs and versioned recipes

- Runner-signed checkpoints (`checkpoint_run`) record progress on-chain and extend the reclaim timeout, so long
  workflows can't be reclaimed mid-way. In `settle_mode: "checkpoint"` each checkpoint also pays the parts that
  completed since the last one; the final settlement skips them, and a refund returns `amount - billed`.
- `update_sealed` announces a version that activates after `update_delay_ns`; runs paid before then keep the
  version they paid for. See `docs/CONTRACT_SPEC.md` ("v4 changes").

## v5: no investment features

Removed: shares, dividends, order books, batch auctions (`transfer_shares`, `claim_dividends`, `place_ask`,
`cancel_order`, `clear_batch`, the `bid` action, their views and events, and the `batch_interval_ns` init
param). `royalty_bps`, `total_shares` and `acc_per_share` are replaced by `reserve_bps`. See
`docs/CONTRACT_SPEC.md` ("v5 changes").

## v6: market-driven pricing

`new` takes `price_period_ns`; `publish_recipe` takes `pricing`; new `set_pricing` and `update_price`; quotes are
`frs-quote-v3` and carry `price`; run msgs accept `max_price`; events `price_updated` and `pricing_updated`. Recipe
fields `price_floor, price_ceiling, target_runs, period_start_ns, period_runs` are appended. Views return the price with
ended periods applied. See `docs/CONTRACT_SPEC.md` ("v6 changes").
