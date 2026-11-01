//! # Fungible Recipes
//!
//! Sealed no-code workflows ("recipes") composed from third-party blocks, sold
//! pay-per-run through NEAR Intents and executed by an attested TEE runner.
//! Each recipe is also a fungible share class: shareholders earn a pro-rata
//! dividend from every run and can trade shares in frequent uniform-price
//! batch auctions (one clearing price per batch, no continuous matching).
//!
//! Canonical interface: `docs/CONTRACT_SPEC.md`.

#![allow(clippy::too_many_arguments)] // publish_recipe mirrors the spec signature

use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, CurveType, Gas, NearToken, PanicOnDefault,
    Promise, PromiseOrValue, PublicKey,
};
use serde_json::json;

pub mod auction;
pub mod settlement;
pub use auction::{clear_auction, AuctionFill, AuctionOrder, AuctionResult, AuctionSide};
pub use settlement::{protocol_fee, settlement_split, Split, ACC_SCALE};

#[cfg(test)]
mod tests;

pub const RUN_TIMEOUT_NS: u64 = 15 * 60 * 1_000_000_000;
pub const MAX_PROTOCOL_FEE_BPS: u16 = 1_000;
pub const MAX_ROYALTY_BPS: u16 = 5_000;
pub const EVENT_STANDARD: &str = "fungible-recipes";
pub const EVENT_VERSION: &str = "1.0.0";
pub const SIGNED_MESSAGE_PREFIX: &str = "frs-run-v1";
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_ON_WITHDRAW: Gas = Gas::from_tgas(10);
/// Upper bound on resting orders per recipe book; bounds `clear_batch` gas and storage spam.
pub const MAX_ORDERS_PER_BOOK: usize = 200;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Blocks,
    Runners,
    Recipes,
    Runs,
    Holdings,
    Balances,
    Books,
    OrderIndex,
    Batches,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Block {
    pub id: String,
    pub version: String,
    pub author: AccountId,
    pub fee_per_call: U128,
    pub manifest_hash: String,
    pub active: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Runner {
    /// The runner's NEAR account. Runner fees are credited here.
    pub id: AccountId,
    /// `ed25519:<base58>` key held inside the TEE; signs run reports.
    pub signing_pk: String,
    /// X25519 public key (hex) that creators/buyers seal recipes and inputs to.
    pub enc_pk_hex: String,
    /// Measurement of the runner image (e.g. TDX compose hash) the owner approved.
    pub codehash: String,
    pub fee_per_run: U128,
    pub active: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Recipe {
    pub id: String,
    pub name: String,
    pub creator: AccountId,
    pub sealed_hash: String,
    pub runner_id: AccountId,
    pub blocks: Vec<String>,
    pub price_per_run: U128,
    pub royalty_bps: u16,
    pub total_shares: U128,
    pub acc_per_share: U128,
    pub runs: u64,
    pub revenue: U128,
    pub listed: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RunStatus {
    Pending,
    Settled,
    Refunded,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Run {
    pub run_id: String,
    pub recipe_id: String,
    pub buyer: AccountId,
    pub amount: U128,
    pub inputs_hash: String,
    /// The recipe's `sealed_hash` at payment time: the exact sealed version this run paid for.
    /// `update_sealed` only affects runs created afterwards.
    pub sealed_hash: String,
    pub status: RunStatus,
    pub created_ns: U64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Side {
    Bid,
    Ask,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Order {
    pub id: u64,
    pub recipe_id: String,
    pub owner: AccountId,
    pub side: Side,
    /// Payment-token units per one share.
    pub price: U128,
    /// Remaining shares.
    pub qty: U128,
    pub created_ns: U64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default)]
pub struct Book {
    /// Sorted best-first: highest price, then oldest.
    pub bids: Vec<Order>,
    /// Sorted best-first: lowest price, then oldest.
    pub asks: Vec<Order>,
}

/// Current auction batch of a recipe. Orders rest until the batch is cleared.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Batch {
    pub id: u64,
    pub opened_ns: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct BatchView {
    pub id: u64,
    pub opened_ns: U64,
    pub closes_ns: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct IndicativeView {
    pub price: Option<U128>,
    pub volume: U128,
    pub demand: U128,
    pub supply: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct FillView {
    pub order_id: u64,
    pub owner: AccountId,
    pub side: Side,
    pub qty: U128,
}

/// Result of `clear_batch` (same fields as the `batch_cleared` event).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ClearSummary {
    pub recipe_id: String,
    pub batch_id: u64,
    pub price: Option<U128>,
    pub volume: U128,
    pub fills: Vec<FillView>,
}

/// Share position of one account in one recipe.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
pub struct Holding {
    pub shares: u128,
    /// Shares escrowed in open asks. They keep earning dividends until filled.
    pub locked: u128,
    pub reward_debt: u128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Payout {
    pub account_id: AccountId,
    pub role: String,
    pub amount: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SplitView {
    pub price: U128,
    pub protocol: U128,
    pub runner: U128,
    pub blocks: Vec<U128>,
    pub remainder: U128,
    pub creator: U128,
    pub pool: U128,
    pub acc_increment: U128,
    pub distributed: U128,
    pub dust_to_protocol: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ShareView {
    pub shares: U128,
    pub locked: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ConfigView {
    pub owner: AccountId,
    pub payment_token: AccountId,
    pub protocol_account: AccountId,
    pub protocol_fee_bps: u16,
    pub batch_interval_ns: U64,
}

/// `msg` accepted by `ft_on_transfer`.
#[near(serializers = [json])]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum TransferMsg {
    Run {
        recipe_id: String,
        run_id: String,
        inputs_hash: String,
        /// Account that owns the run (refunds, reclaim). Needed because a NEAR Intents
        /// solver, not the buyer, is the `sender_id` of the ft_transfer_call.
        #[serde(default)]
        on_behalf_of: Option<AccountId>,
    },
    Bid {
        recipe_id: String,
        price: U128,
        qty: U128,
        /// Account that owns the bid and receives the shares (see `Run::on_behalf_of`).
        #[serde(default)]
        on_behalf_of: Option<AccountId>,
    },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    payment_token: AccountId,
    protocol_account: AccountId,
    protocol_fee_bps: u16,
    blocks: IterableMap<String, Block>,
    runners: IterableMap<AccountId, Runner>,
    recipes: IterableMap<String, Recipe>,
    runs: LookupMap<String, Run>,
    holdings: LookupMap<(String, AccountId), Holding>,
    balances: LookupMap<AccountId, u128>,
    books: LookupMap<String, Book>,
    order_index: LookupMap<u64, String>,
    next_order_id: u64,
    batch_interval_ns: u64,
    batches: LookupMap<String, Batch>,
}

fn emit(event: &str, data: serde_json::Value) {
    let log = json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{}", log));
}

/// Block ids end up inside the `|`/`,`-delimited signed report, so they are restricted.
fn valid_block_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'@' | b'-')
        })
}

fn valid_run_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Exactly 64 lowercase hex characters (a sha256 digest).
fn valid_hash(h: &str) -> bool {
    h.len() == 64 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn valid_ticker(id: &str) -> bool {
    (3..=6).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}

fn parse_ed25519(pk: &str) -> [u8; 32] {
    let key: PublicKey = pk.parse().unwrap_or_else(|_| env::panic_str("invalid public key"));
    require!(
        key.curve_type() == CurveType::ED25519,
        "signing key must be ed25519"
    );
    let bytes = key.as_bytes();
    require!(bytes.len() == 33, "invalid ed25519 key length");
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes[1..]);
    out
}

/// The exact UTF-8 message a runner signs for `report_run`.
pub fn run_report_message(
    contract_id: &str,
    run_id: &str,
    recipe_id: &str,
    success: bool,
    output_hash: &str,
    blocks_used: &[String],
) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}|{}",
        SIGNED_MESSAGE_PREFIX,
        contract_id,
        run_id,
        recipe_id,
        if success { "ok" } else { "fail" },
        output_hash,
        blocks_used.join(",")
    )
}

fn is_sub_multiset(used: &[String], allowed: &[String]) -> bool {
    let mut pool: Vec<&String> = allowed.iter().collect();
    for u in used {
        match pool.iter().position(|a| *a == u) {
            Some(i) => {
                pool.swap_remove(i);
            }
            None => return false,
        }
    }
    true
}

#[near]
impl Contract {
    // ------------------------------------------------------------------ admin

    #[init]
    pub fn new(
        owner: AccountId,
        payment_token: AccountId,
        protocol_account: AccountId,
        protocol_fee_bps: u16,
        batch_interval_ns: U64,
    ) -> Self {
        require!(
            protocol_fee_bps <= MAX_PROTOCOL_FEE_BPS,
            "protocol fee too high"
        );
        require!(batch_interval_ns.0 > 0, "batch_interval_ns must be > 0");
        Self {
            owner,
            payment_token,
            protocol_account,
            protocol_fee_bps,
            blocks: IterableMap::new(StorageKey::Blocks),
            runners: IterableMap::new(StorageKey::Runners),
            recipes: IterableMap::new(StorageKey::Recipes),
            runs: LookupMap::new(StorageKey::Runs),
            holdings: LookupMap::new(StorageKey::Holdings),
            balances: LookupMap::new(StorageKey::Balances),
            books: LookupMap::new(StorageKey::Books),
            order_index: LookupMap::new(StorageKey::OrderIndex),
            next_order_id: 1,
            batch_interval_ns: batch_interval_ns.0,
            batches: LookupMap::new(StorageKey::Batches),
        }
    }

    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "owner only"
        );
    }

    pub fn add_runner(
        &mut self,
        id: AccountId,
        signing_pk: String,
        enc_pk_hex: String,
        codehash: String,
        fee_per_run: U128,
    ) {
        self.assert_owner();
        require!(!self.runners.contains_key(&id), "runner exists");
        parse_ed25519(&signing_pk);
        require!(
            enc_pk_hex.len() == 64 && enc_pk_hex.bytes().all(|b| b.is_ascii_hexdigit()),
            "enc_pk_hex must be 32 bytes hex"
        );
        let runner = Runner {
            id: id.clone(),
            signing_pk,
            enc_pk_hex,
            codehash,
            fee_per_run,
            active: true,
        };
        emit("runner_added", json!(runner));
        self.runners.insert(id, runner);
    }

    pub fn set_runner_active(&mut self, id: AccountId, active: bool) {
        self.assert_owner();
        let r = self
            .runners
            .get_mut(&id)
            .unwrap_or_else(|| env::panic_str("unknown runner"));
        r.active = active;
    }

    // ---------------------------------------------------- builders & creators

    pub fn register_block(
        &mut self,
        id: String,
        version: String,
        fee_per_call: U128,
        manifest_hash: String,
    ) {
        require!(valid_block_id(&id), "block id must match ^[a-z0-9._@-]{1,64}$");
        require!(!self.blocks.contains_key(&id), "block exists");
        let block = Block {
            id: id.clone(),
            version,
            author: env::predecessor_account_id(),
            fee_per_call,
            manifest_hash,
            active: true,
        };
        emit("block_registered", json!(block));
        self.blocks.insert(id, block);
    }

    #[allow(clippy::too_many_arguments)]
    pub fn publish_recipe(
        &mut self,
        id: String,
        name: String,
        sealed_hash: String,
        runner_id: AccountId,
        blocks: Vec<String>,
        price_per_run: U128,
        royalty_bps: u16,
        total_shares: U128,
    ) {
        require!(valid_ticker(&id), "recipe id must match ^[A-Z0-9]{3,6}$");
        require!(!self.recipes.contains_key(&id), "recipe exists");
        require!(royalty_bps <= MAX_ROYALTY_BPS, "royalty too high");
        require!(total_shares.0 > 0, "total_shares must be > 0");
        require!(!sealed_hash.is_empty(), "sealed_hash required");
        require!(!blocks.is_empty(), "recipe needs at least one block");
        let runner = self
            .runners
            .get(&runner_id)
            .unwrap_or_else(|| env::panic_str("unknown runner"));
        require!(runner.active, "runner inactive");
        let mut fixed = protocol_fee(price_per_run.0, self.protocol_fee_bps) + runner.fee_per_run.0;
        for b in &blocks {
            let blk = self
                .blocks
                .get(b)
                .unwrap_or_else(|| env::panic_str(&format!("unknown block {}", b)));
            require!(blk.active, "block inactive");
            fixed += blk.fee_per_call.0;
        }
        require!(
            price_per_run.0 >= fixed,
            format!(
                "price_per_run below minimum viable price {} (protocol + runner + block fees)",
                fixed
            )
        );
        let creator = env::predecessor_account_id();
        let recipe = Recipe {
            id: id.clone(),
            name,
            creator: creator.clone(),
            sealed_hash,
            runner_id,
            blocks,
            price_per_run,
            royalty_bps,
            total_shares,
            acc_per_share: U128(0),
            runs: 0,
            revenue: U128(0),
            listed: true,
        };
        emit("recipe_published", json!(recipe));
        self.recipes.insert(id.clone(), recipe);
        // the first batch is the recipe's opening auction
        self.batches.insert(id.clone(), Batch { id: 1, opened_ns: U64(env::block_timestamp()) });
        self.holdings.insert(
            (id, creator),
            Holding {
                shares: total_shares.0,
                locked: 0,
                reward_debt: 0,
            },
        );
    }

    pub fn update_sealed(&mut self, id: String, sealed_hash: String) {
        let r = self
            .recipes
            .get_mut(&id)
            .unwrap_or_else(|| env::panic_str("unknown recipe"));
        require!(env::predecessor_account_id() == r.creator, "creator only");
        r.sealed_hash = sealed_hash.clone();
        emit("recipe_updated", json!({"recipe_id": id, "sealed_hash": sealed_hash}));
    }

    // ------------------------------------------------- pay-per-run (Intents)

    /// NEP-141 receiver. Solvers delivering a 1Click swap with
    /// `customRecipientMsg` land here.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(
            env::predecessor_account_id() == self.payment_token,
            "only the payment token is accepted"
        );
        let parsed: TransferMsg =
            serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("invalid msg"));
        let (on_behalf_of, result) = match parsed {
            TransferMsg::Run {
                recipe_id,
                run_id,
                inputs_hash,
                on_behalf_of,
            } => {
                let owner = on_behalf_of.clone().unwrap_or_else(|| sender_id.clone());
                (
                    on_behalf_of,
                    self.internal_request_run(owner, amount.0, recipe_id, run_id, inputs_hash),
                )
            }
            TransferMsg::Bid {
                recipe_id,
                price,
                qty,
                on_behalf_of,
            } => {
                let owner = on_behalf_of.clone().unwrap_or_else(|| sender_id.clone());
                (
                    on_behalf_of,
                    self.internal_place_bid(owner, amount.0, recipe_id, price.0, qty.0),
                )
            }
        };
        if let Err(reason) = result {
            match on_behalf_of {
                // Delivered through NEAR Intents: a panic would refund the solver/intents side,
                // not the buyer. Keep the funds for the buyer instead.
                Some(owner) => {
                    self.credit(&owner, amount.0);
                    emit(
                        "transfer_rejected",
                        json!({"on_behalf_of": owner, "sender_id": sender_id, "amount": amount, "reason": reason}),
                    );
                }
                // Direct ft_transfer_call: panic so the token contract refunds the sender.
                None => env::panic_str(&reason),
            }
        }
        PromiseOrValue::Value(U128(0))
    }

    fn internal_request_run(
        &mut self,
        buyer: AccountId,
        amount: u128,
        recipe_id: String,
        run_id: String,
        inputs_hash: String,
    ) -> Result<(), String> {
        // All checks happen before any state change, so a rejection leaves no partial state.
        if !valid_run_id(&run_id) {
            return Err("run_id must match ^[A-Za-z0-9_-]{1,64}$".into());
        }
        if !valid_hash(&inputs_hash) {
            return Err("inputs_hash must be 64 lowercase hex".into());
        }
        if self.runs.contains_key(&run_id) {
            return Err("run exists".into());
        }
        let recipe = self.recipes.get(&recipe_id).ok_or("unknown recipe")?;
        if !recipe.listed {
            return Err("recipe not listed".into());
        }
        let price = recipe.price_per_run.0;
        let sealed_hash = recipe.sealed_hash.clone();
        if amount < price {
            return Err("payment below price_per_run".into());
        }
        if amount > price {
            self.credit(&buyer, amount - price);
        }
        let run = Run {
            run_id: run_id.clone(),
            recipe_id,
            buyer,
            amount: U128(price),
            inputs_hash,
            sealed_hash,
            status: RunStatus::Pending,
            created_ns: U64(env::block_timestamp()),
        };
        emit("run_requested", json!(run));
        self.runs.insert(run_id, run);
        Ok(())
    }

    pub fn report_run(
        &mut self,
        run_id: String,
        success: bool,
        blocks_used: Vec<String>,
        output_hash: String,
        signature: Base64VecU8,
    ) -> Vec<Payout> {
        let run = self
            .runs
            .get(&run_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown run"));
        require!(run.status == RunStatus::Pending, "run not pending");
        require!(valid_hash(&output_hash), "output_hash must be 64 lowercase hex");
        let recipe = self
            .recipes
            .get(&run.recipe_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown recipe"));
        let runner = self
            .runners
            .get(&recipe.runner_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown runner"));
        require!(runner.active, "runner inactive");

        let msg = run_report_message(
            env::current_account_id().as_str(),
            &run_id,
            &recipe.id,
            success,
            &output_hash,
            &blocks_used,
        );
        let sig: [u8; 64] = signature
            .0
            .as_slice()
            .try_into()
            .unwrap_or_else(|_| env::panic_str("signature must be 64 bytes"));
        let pk = parse_ed25519(&runner.signing_pk);
        require!(
            env::ed25519_verify(&sig, msg.as_bytes(), &pk),
            "invalid runner signature"
        );

        if !success {
            self.credit(&run.buyer, run.amount.0);
            self.set_run_status(&run_id, RunStatus::Refunded);
            emit(
                "run_refunded",
                json!({"run_id": run_id, "buyer": run.buyer, "amount": run.amount, "reason": "runner_reported_failure"}),
            );
            return vec![];
        }

        require!(
            is_sub_multiset(&blocks_used, &recipe.blocks),
            "blocks_used not part of recipe"
        );
        let block_infos: Vec<Block> = blocks_used
            .iter()
            .map(|b| self.blocks.get(b).cloned().unwrap())
            .collect();
        let fees: Vec<u128> = block_infos.iter().map(|b| b.fee_per_call.0).collect();
        let split = settlement_split(
            run.amount.0,
            self.protocol_fee_bps,
            runner.fee_per_run.0,
            &fees,
            recipe.royalty_bps,
            recipe.total_shares.0,
        )
        .unwrap_or_else(|| env::panic_str("fees exceed price"));

        let mut payouts: Vec<Payout> = Vec::new();
        let mut pay = |c: &mut Self, account: &AccountId, role: &str, amount: u128| {
            if amount > 0 {
                c.credit(account, amount);
            }
            payouts.push(Payout {
                account_id: account.clone(),
                role: role.to_string(),
                amount: U128(amount),
            });
        };
        let protocol_account = self.protocol_account.clone();
        pay(self, &protocol_account, "protocol", split.protocol_total());
        pay(self, &runner.id, "runner", split.runner);
        for (blk, fee) in block_infos.iter().zip(fees.iter()) {
            pay(self, &blk.author, &format!("block:{}", blk.id), *fee);
        }
        pay(self, &recipe.creator, "creator_royalty", split.creator);

        let r = self.recipes.get_mut(&recipe.id).unwrap();
        r.acc_per_share = U128(r.acc_per_share.0 + split.acc_increment);
        r.runs += 1;
        r.revenue = U128(r.revenue.0 + run.amount.0);
        self.set_run_status(&run_id, RunStatus::Settled);

        emit(
            "frs_settlement",
            json!({
                "run_id": run_id,
                "recipe_id": recipe.id,
                "buyer": run.buyer,
                "price": run.amount,
                "output_hash": output_hash,
                "payouts": payouts,
                "shareholder_pool": U128(split.distributed),
                "acc_increment": U128(split.acc_increment),
            }),
        );
        payouts
    }

    pub fn reclaim_run(&mut self, run_id: String) {
        let run = self
            .runs
            .get(&run_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown run"));
        require!(env::predecessor_account_id() == run.buyer, "buyer only");
        require!(run.status == RunStatus::Pending, "run not pending");
        require!(
            env::block_timestamp() >= run.created_ns.0 + RUN_TIMEOUT_NS,
            "run not timed out"
        );
        self.credit(&run.buyer, run.amount.0);
        self.set_run_status(&run_id, RunStatus::Refunded);
        emit(
            "run_refunded",
            json!({"run_id": run_id, "buyer": run.buyer, "amount": run.amount, "reason": "timeout"}),
        );
    }

    fn set_run_status(&mut self, run_id: &String, status: RunStatus) {
        self.runs.get_mut(run_id).unwrap().status = status;
    }

    // ------------------------------------------------------------- balances

    fn credit(&mut self, account: &AccountId, amount: u128) {
        let b = self.balances.get(account).copied().unwrap_or(0);
        self.balances.insert(account.clone(), b + amount);
    }

    fn debit(&mut self, account: &AccountId, amount: u128) {
        let b = self.balances.get(account).copied().unwrap_or(0);
        require!(b >= amount, "insufficient balance");
        self.balances.insert(account.clone(), b - amount);
    }

    /// Withdraws the caller's balance (all of it when `amount` is omitted) as an `ft_transfer`.
    /// Requires exactly 1 yoctoNEAR attached (NEP-141 convention: full-access-key confirmation).
    #[payable]
    pub fn withdraw(&mut self, amount: Option<U128>) -> Promise {
        near_sdk::assert_one_yocto();
        let account = env::predecessor_account_id();
        let available = self.balances.get(&account).copied().unwrap_or(0);
        let amount = amount.map(|a| a.0).unwrap_or(available);
        require!(amount > 0, "nothing to withdraw");
        self.debit(&account, amount);
        Promise::new(self.payment_token.clone())
            .function_call(
                "ft_transfer".to_string(),
                json!({"receiver_id": account, "amount": U128(amount), "memo": "fungible-recipes withdraw"})
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_FT_TRANSFER,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_WITHDRAW)
                    .on_withdraw(account, U128(amount)),
            )
    }

    #[private]
    pub fn on_withdraw(&mut self, account_id: AccountId, amount: U128) -> bool {
        // `ft_transfer` returns nothing; only success/failure matters. (A typed
        // `#[callback_result] Result<(), _>` would try to JSON-decode the empty result and fail.)
        let ok = env::promise_results_count() == 1 && env::promise_result_checked(0, 64).is_ok();
        if !ok {
            self.credit(&account_id, amount.0);
            emit(
                "withdraw_failed",
                json!({"account_id": account_id, "amount": amount}),
            );
            false
        } else {
            emit(
                "withdrawn",
                json!({"account_id": account_id, "amount": amount}),
            );
            true
        }
    }

    // ---------------------------------------------------- shares & dividends

    fn holding(&self, recipe_id: &str, account: &AccountId) -> Holding {
        self.holdings
            .get(&(recipe_id.to_string(), account.clone()))
            .cloned()
            .unwrap_or_default()
    }

    fn acc(&self, recipe_id: &str) -> u128 {
        self.recipes
            .get(recipe_id)
            .unwrap_or_else(|| env::panic_str("unknown recipe"))
            .acc_per_share
            .0
    }

    /// Credits pending dividends to the withdrawable balance and resets the debt.
    fn harvest(&mut self, recipe_id: &str, account: &AccountId) -> u128 {
        let acc = self.acc(recipe_id);
        let mut h = self.holding(recipe_id, account);
        let accrued = h.shares * acc / ACC_SCALE;
        let pending = accrued - h.reward_debt;
        h.reward_debt = accrued;
        self.holdings
            .insert((recipe_id.to_string(), account.clone()), h);
        if pending > 0 {
            self.credit(account, pending);
        }
        pending
    }

    /// Moves available (unlocked) shares, harvesting both sides first.
    fn move_shares(&mut self, recipe_id: &str, from: &AccountId, to: &AccountId, qty: u128) {
        let acc = self.acc(recipe_id);
        self.harvest(recipe_id, from);
        self.harvest(recipe_id, to);
        let mut hf = self.holding(recipe_id, from);
        require!(hf.shares - hf.locked >= qty, "insufficient shares");
        hf.shares -= qty;
        hf.reward_debt = hf.shares * acc / ACC_SCALE;
        self.holdings.insert((recipe_id.to_string(), from.clone()), hf);
        let mut ht = self.holding(recipe_id, to);
        ht.shares += qty;
        ht.reward_debt = ht.shares * acc / ACC_SCALE;
        self.holdings.insert((recipe_id.to_string(), to.clone()), ht);
    }

    pub fn transfer_shares(&mut self, recipe_id: String, receiver_id: AccountId, qty: U128) {
        require!(qty.0 > 0, "qty must be > 0");
        let sender = env::predecessor_account_id();
        require!(sender != receiver_id, "cannot transfer to self");
        self.move_shares(&recipe_id, &sender, &receiver_id, qty.0);
        emit(
            "shares_transferred",
            json!({"recipe_id": recipe_id, "from": sender, "to": receiver_id, "qty": qty}),
        );
    }

    pub fn claim_dividends(&mut self, recipe_id: String) -> U128 {
        let account = env::predecessor_account_id();
        let amount = self.harvest(&recipe_id, &account);
        emit(
            "dividends_claimed",
            json!({"recipe_id": recipe_id, "account_id": account, "amount": U128(amount)}),
        );
        U128(amount)
    }

    // ------------------------------------------------ batch auctions (shares)

    fn new_order(&mut self, recipe_id: &str, owner: &AccountId, side: Side, price: u128, qty: u128) -> Order {
        let id = self.next_order_id;
        self.next_order_id += 1;
        Order {
            id,
            recipe_id: recipe_id.to_string(),
            owner: owner.clone(),
            side,
            price: U128(price),
            qty: U128(qty),
            created_ns: U64(env::block_timestamp()),
        }
    }

    fn book_full(&self, recipe_id: &str) -> bool {
        self.books
            .get(recipe_id)
            .map(|b| b.bids.len() + b.asks.len() >= MAX_ORDERS_PER_BOOK)
            .unwrap_or(false)
    }

    /// Inserts a resting order keeping each side sorted best-first (price, then age).
    fn rest_order(&mut self, order: Order) {
        let recipe_id = order.recipe_id.clone();
        self.order_index.insert(order.id, recipe_id.clone());
        emit("order_placed", json!(order));
        let mut book = self.books.get(&recipe_id).cloned().unwrap_or_default();
        let price = order.price.0;
        match order.side {
            Side::Bid => {
                let pos = book.bids.iter().position(|o| o.price.0 < price).unwrap_or(book.bids.len());
                book.bids.insert(pos, order);
            }
            Side::Ask => {
                let pos = book.asks.iter().position(|o| o.price.0 > price).unwrap_or(book.asks.len());
                book.asks.insert(pos, order);
            }
        }
        self.books.insert(recipe_id, book);
    }

    /// Bids only join the current batch; nothing matches until `clear_batch`.
    fn internal_place_bid(&mut self, buyer: AccountId, amount: u128, recipe_id: String, price: u128, qty: u128) -> Result<(), String> {
        if !self.recipes.contains_key(&recipe_id) {
            return Err("unknown recipe".into());
        }
        if price == 0 || qty == 0 {
            return Err("price and qty must be > 0".into());
        }
        let escrow = price.checked_mul(qty).ok_or("price * qty overflows")?;
        if amount < escrow {
            return Err("deposit below price * qty".into());
        }
        if self.book_full(&recipe_id) {
            return Err("order book full".into());
        }
        if amount > escrow {
            self.credit(&buyer, amount - escrow);
        }
        let order = self.new_order(&recipe_id, &buyer, Side::Bid, price, qty);
        self.rest_order(order);
        Ok(())
    }

    /// Locks shares and joins the current batch.
    pub fn place_ask(&mut self, recipe_id: String, price: U128, qty: U128) -> u64 {
        let seller = env::predecessor_account_id();
        let (price, qty) = (price.0, qty.0);
        require!(price > 0 && qty > 0, "price and qty must be > 0");
        require!(self.recipes.contains_key(&recipe_id), "unknown recipe");
        require!(!self.book_full(&recipe_id), "order book full");
        // Escrow (lock) the shares; they keep earning dividends until filled.
        let mut h = self.holding(&recipe_id, &seller);
        require!(h.shares - h.locked >= qty, "insufficient shares");
        h.locked += qty;
        self.holdings.insert((recipe_id.clone(), seller.clone()), h);
        let order = self.new_order(&recipe_id, &seller, Side::Ask, price, qty);
        let id = order.id;
        self.rest_order(order);
        id
    }

    fn auction_orders(book: &Book) -> Vec<AuctionOrder> {
        book.bids
            .iter()
            .map(|o| AuctionOrder { id: o.id, side: AuctionSide::Bid, price: o.price.0, qty: o.qty.0 })
            .chain(book.asks.iter().map(|o| AuctionOrder { id: o.id, side: AuctionSide::Ask, price: o.price.0, qty: o.qty.0 }))
            .collect()
    }

    /// Permissionless: closes the recipe's batch once `batch_interval_ns` has elapsed and clears
    /// every crossing order at one uniform price. Always opens the next batch.
    pub fn clear_batch(&mut self, recipe_id: String) -> ClearSummary {
        let batch = self
            .batches
            .get(&recipe_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown recipe"));
        let now = env::block_timestamp();
        require!(now >= batch.opened_ns.0 + self.batch_interval_ns, "batch still open");
        let mut book = self.books.get(&recipe_id).cloned().unwrap_or_default();
        let result = clear_auction(&Self::auction_orders(&book));
        let acc = self.acc(&recipe_id);
        let mut fills = Vec::with_capacity(result.fills.len());
        if let Some(p) = result.price {
            for f in &result.fills {
                let side_vec = if f.side == AuctionSide::Bid { &mut book.bids } else { &mut book.asks };
                let idx = side_vec.iter().position(|o| o.id == f.order_id).unwrap();
                let owner = side_vec[idx].owner.clone();
                if side_vec[idx].qty.0 == f.qty {
                    side_vec.remove(idx);
                    self.order_index.remove(&f.order_id);
                } else {
                    side_vec[idx].qty = U128(side_vec[idx].qty.0 - f.qty);
                }
                // harvest before the share balance changes (acc is constant during clearing)
                self.harvest(&recipe_id, &owner);
                let mut h = self.holding(&recipe_id, &owner);
                match f.side {
                    AuctionSide::Bid => {
                        h.shares += f.qty;
                        let improvement = (f.limit - p) * f.qty;
                        if improvement > 0 {
                            self.credit(&owner, improvement);
                        }
                    }
                    AuctionSide::Ask => {
                        h.shares -= f.qty;
                        h.locked -= f.qty;
                        self.credit(&owner, f.qty * p);
                    }
                }
                h.reward_debt = h.shares * acc / ACC_SCALE;
                self.holdings.insert((recipe_id.clone(), owner.clone()), h);
                fills.push(FillView {
                    order_id: f.order_id,
                    owner,
                    side: if f.side == AuctionSide::Bid { Side::Bid } else { Side::Ask },
                    qty: U128(f.qty),
                });
            }
        }
        self.books.insert(recipe_id.clone(), book);
        let summary = ClearSummary {
            recipe_id: recipe_id.clone(),
            batch_id: batch.id,
            price: result.price.map(U128),
            volume: U128(result.volume),
            fills,
        };
        emit("batch_cleared", json!(summary));
        self.batches.insert(recipe_id, Batch { id: batch.id + 1, opened_ns: U64(now) });
        summary
    }

    pub fn cancel_order(&mut self, order_id: u64) {
        let recipe_id = self
            .order_index
            .get(&order_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown order"));
        let mut book = self.books.get(&recipe_id).cloned().unwrap_or_default();
        let caller = env::predecessor_account_id();
        let order = if let Some(i) = book.bids.iter().position(|o| o.id == order_id) {
            book.bids.remove(i)
        } else if let Some(i) = book.asks.iter().position(|o| o.id == order_id) {
            book.asks.remove(i)
        } else {
            env::panic_str("unknown order")
        };
        require!(order.owner == caller, "order owner only");
        match order.side {
            Side::Bid => self.credit(&caller, order.price.0 * order.qty.0),
            Side::Ask => {
                let mut h = self.holding(&recipe_id, &caller);
                h.locked -= order.qty.0;
                self.holdings.insert((recipe_id.clone(), caller.clone()), h);
            }
        }
        self.order_index.remove(&order_id);
        self.books.insert(recipe_id.clone(), book);
        emit("order_cancelled", json!(order));
    }

    // ----------------------------------------------------------------- views

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner: self.owner.clone(),
            payment_token: self.payment_token.clone(),
            protocol_account: self.protocol_account.clone(),
            protocol_fee_bps: self.protocol_fee_bps,
            batch_interval_ns: U64(self.batch_interval_ns),
        }
    }

    pub fn get_recipe(&self, recipe_id: String) -> Option<Recipe> {
        self.recipes.get(&recipe_id).cloned()
    }

    pub fn list_recipes(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Recipe> {
        self.recipes
            .values()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50) as usize)
            .cloned()
            .collect()
    }

    pub fn get_block(&self, block_id: String) -> Option<Block> {
        self.blocks.get(&block_id).cloned()
    }

    pub fn list_blocks(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Block> {
        self.blocks
            .values()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50) as usize)
            .cloned()
            .collect()
    }

    pub fn get_runner(&self, runner_id: AccountId) -> Option<Runner> {
        self.runners.get(&runner_id).cloned()
    }

    pub fn get_run(&self, run_id: String) -> Option<Run> {
        self.runs.get(&run_id).cloned()
    }

    pub fn get_book(&self, recipe_id: String) -> Book {
        self.books.get(&recipe_id).cloned().unwrap_or_default()
    }

    pub fn get_batch(&self, recipe_id: String) -> Option<BatchView> {
        self.batches.get(&recipe_id).map(|b| BatchView {
            id: b.id,
            opened_ns: b.opened_ns,
            closes_ns: U64(b.opened_ns.0 + self.batch_interval_ns),
        })
    }

    /// What would clear if the batch closed now.
    pub fn indicative_clearing(&self, recipe_id: String) -> IndicativeView {
        let book = self.books.get(&recipe_id).cloned().unwrap_or_default();
        let r = clear_auction(&Self::auction_orders(&book));
        IndicativeView {
            price: r.price.map(U128),
            volume: U128(r.volume),
            demand: U128(r.demand),
            supply: U128(r.supply),
        }
    }

    pub fn shares_of(&self, recipe_id: String, account_id: AccountId) -> ShareView {
        let h = self.holding(&recipe_id, &account_id);
        ShareView {
            shares: U128(h.shares),
            locked: U128(h.locked),
        }
    }

    pub fn pending_dividends(&self, recipe_id: String, account_id: AccountId) -> U128 {
        let acc = self.recipes.get(&recipe_id).map(|r| r.acc_per_share.0).unwrap_or(0);
        let h = self.holding(&recipe_id, &account_id);
        U128(h.shares * acc / ACC_SCALE - h.reward_debt)
    }

    pub fn balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.balances.get(&account_id).copied().unwrap_or(0))
    }

    pub fn quote_settlement(&self, recipe_id: String, blocks_used: Option<Vec<String>>) -> SplitView {
        let recipe = self
            .recipes
            .get(&recipe_id)
            .unwrap_or_else(|| env::panic_str("unknown recipe"));
        let used = blocks_used.unwrap_or_else(|| recipe.blocks.clone());
        require!(is_sub_multiset(&used, &recipe.blocks), "blocks_used not part of recipe");
        let fees: Vec<u128> = used
            .iter()
            .map(|b| self.blocks.get(b).unwrap().fee_per_call.0)
            .collect();
        let runner_fee = self.runners.get(&recipe.runner_id).unwrap().fee_per_run.0;
        let s = settlement_split(
            recipe.price_per_run.0,
            self.protocol_fee_bps,
            runner_fee,
            &fees,
            recipe.royalty_bps,
            recipe.total_shares.0,
        )
        .unwrap_or_else(|| env::panic_str("fees exceed price"));
        SplitView {
            price: recipe.price_per_run,
            protocol: U128(s.protocol),
            runner: U128(s.runner),
            blocks: s.blocks.iter().map(|b| U128(*b)).collect(),
            remainder: U128(s.remainder),
            creator: U128(s.creator),
            pool: U128(s.pool),
            acc_increment: U128(s.acc_increment),
            distributed: U128(s.distributed),
            dust_to_protocol: U128(s.dust_to_protocol),
        }
    }
}
