# `fungible-recipes` — NEAR smart contract

Rust / near-sdk 5.30. The canonical interface is [`docs/CONTRACT_SPEC.md`](../../docs/CONTRACT_SPEC.md).

What it does:

- **Registry.** Block authors register blocks with a fixed per-call fee. The owner approves TEE runners
  (ed25519 signing key, X25519 sealing key, image codehash, fee per run).
- **Sealed recipes.** A creator publishes a recipe. Only its `sealed_hash` and its list of blocks go on chain;
  the workflow graph itself stays encrypted to the runner. The creator receives 100% of `total_shares`.
  Publishing fails if the price can't cover protocol, runner and block fees.
- **Pay-per-run through NEAR Intents.** A 1Click swap delivers the payment token with
  `customRecipientMsg = {"action":"run",...}`, which arrives as `ft_transfer_call` → `ft_on_transfer`. The run
  stays in escrow until the runner sends a report.
- **Signed settlement.** Anyone can relay `report_run`, because the contract checks the runner's ed25519
  signature (`env::ed25519_verify`). In one receipt it pays the protocol, the runner, every block author used,
  the creator's royalty and the shareholder dividend pool. A failed run refunds the buyer. If no report arrives
  within 15 minutes, the buyer can call `reclaim_run`.
- **Shares and dividends.** Dividends use an accumulator (`acc_per_share`, scale 1e18). Pending dividends are
  harvested before any change to a balance, and shares escrowed in asks keep earning.
- **Order book.** Each recipe has a limit order book with price-time priority, fills at the maker's price,
  price-improvement refunds and cancellation.

## Test

```bash
cargo test          # 44 unit tests, including the shared vectors in ../test-vectors/*.json
cargo clippy --all-targets
```

The settlement vectors (`../test-vectors/settlement.json`, `dividends.json`) are the same files the
TypeScript mirror is tested against, so on-chain and off-chain math must agree.

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
  with-init-call new json-args "{\"owner\":\"$OWNER\",\"payment_token\":\"$TOKEN\",\"protocol_account\":\"$OWNER\",\"protocol_fee_bps\":200}" \
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
`register_block`, `publish_recipe` and order placement should require a storage deposit (sybil resistance).

## Methods

| Method | Kind | Args |
|---|---|---|
| `new` | init | `owner: AccountId, payment_token: AccountId, protocol_account: AccountId, protocol_fee_bps: u16` (≤1000) |
| `add_runner` | owner | `id: AccountId, signing_pk: String ("ed25519:…"), enc_pk_hex: String (64 hex), codehash: String, fee_per_run: U128` |
| `set_runner_active` | owner | `id: AccountId, active: bool` |
| `register_block` | call | `id: String, version: String, fee_per_call: U128, manifest_hash: String` |
| `publish_recipe` | call | `id: String (^[A-Z0-9]{3,6}$), name: String, sealed_hash: String, runner_id: AccountId, blocks: Vec<String>, price_per_run: U128, royalty_bps: u16 (≤5000), total_shares: U128` |
| `update_sealed` | creator | `id: String, sealed_hash: String` |
| `ft_on_transfer` | payment token only | `sender_id: AccountId, amount: U128, msg: String` → `U128("0")` |
| `report_run` | anyone (signature-gated) | `run_id: String, success: bool, blocks_used: Vec<String>, output_hash: String, signature: Base64VecU8` → `Vec<Payout>` |
| `reclaim_run` | buyer, after 15 min | `run_id: String` |
| `withdraw` | call, 1 yocto | `amount: Option<U128>` (default: whole balance) |
| `on_withdraw` | private callback | `account_id, amount` |
| `transfer_shares` | call | `recipe_id: String, receiver_id: AccountId, qty: U128` |
| `claim_dividends` | call | `recipe_id: String` → `U128` |
| `place_ask` | call | `recipe_id: String, price: U128, qty: U128` → `u64` order id |
| `cancel_order` | order owner | `order_id: u64` |
| views | view | `get_config`, `get_recipe(recipe_id)`, `list_recipes(from_index?, limit?)`, `get_block(block_id)`, `list_blocks(from_index?, limit?)`, `get_runner(runner_id)`, `get_run(run_id)`, `get_book(recipe_id)`, `shares_of(recipe_id, account_id)`, `pending_dividends(recipe_id, account_id)`, `balance_of(account_id)`, `quote_settlement(recipe_id, blocks_used?)` |

`ft_on_transfer` msgs:

```json
{"action":"run","recipe_id":"CLNP","run_id":"r-123","inputs_hash":"<sha256 hex>","on_behalf_of":"bob.testnet"}
{"action":"bid","recipe_id":"CLNP","price":"120","qty":"1000","on_behalf_of":"bob.testnet"}
```

`on_behalf_of` is optional (defaults to `sender_id`). It exists because with NEAR Intents the
`ft_transfer_call` comes from the solver, not from the buyer.

Failure semantics: if a `run`/`bid` msg with `on_behalf_of` fails a business rule (unknown or unlisted
recipe, duplicate or malformed `run_id`, malformed `inputs_hash`, underpayment, bad bid price/qty), the
contract does **not** panic: it credits the whole amount to `on_behalf_of` and emits `transfer_rejected`,
because a panic would refund the Intents/solver side rather than the buyer. Without `on_behalf_of` it panics
and the token refunds the sender. Validation: block ids `^[a-z0-9._@-]{1,64}$`, run ids `^[A-Za-z0-9_-]{1,64}$`,
`inputs_hash` / `output_hash` 64 lowercase hex, `publish_recipe` needs at least one block. Each `Run` records
the recipe's `sealed_hash` at payment time. Exact event shapes: [`docs/CONTRACT_EVENTS.md`](../../docs/CONTRACT_EVENTS.md).

Runner report signature: ed25519 over the UTF-8 string

```
frs-run-v1|<contract_account_id>|<run_id>|<recipe_id>|<ok|fail>|<output_hash>|<blocks_used joined by ",">
```

Events: NEP-297 `EVENT_JSON:` logs with `standard: "fungible-recipes"`, `version: "1.0.0"`. The event names are
`runner_added`, `block_registered`, `recipe_published`, `recipe_updated`, `run_requested`, `frs_settlement`,
`run_refunded`, `order_placed`, `trade`, `order_cancelled`, `shares_transferred`, `dividends_claimed`,
`withdrawn`, `withdraw_failed` and `transfer_rejected`.
