//! # Fungible Recipes
//!
//! Sealed no-code workflows ("recipes") composed from third-party parts, sold
//! pay-per-run through NEAR Intents and executed by an attested TEE runner.
//! Each recipe is also a fungible share class: shareholders earn a pro-rata
//! dividend from every run and can trade shares in frequent uniform-price
//! batch auctions (one clearing price per batch, no continuous matching).
//!
//! Canonical interface: `docs/CONTRACT_SPEC.md`.

#![allow(clippy::too_many_arguments)] // publish_recipe mirrors the spec signature

use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::store::{IterableMap, LookupMap, LookupSet};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, CurveType, Gas, NearToken, PanicOnDefault,
    Promise, PromiseOrValue, PublicKey,
};
use serde_json::json;

pub mod auction;
pub mod bond;
pub mod dividends;
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
pub const SIGNED_MESSAGE_PREFIX: &str = "frs-run-v3";
pub const QUOTE_MESSAGE_PREFIX: &str = "frs-quote-v2";
pub const CHECKPOINT_MESSAGE_PREFIX: &str = "frs-ckpt-v1";
/// Accepted `settle_mode` values: settle everything at the end, or bill parts at checkpoints.
pub const SETTLE_MODES: [&str; 2] = ["final", "checkpoint"];
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_ON_WITHDRAW: Gas = Gas::from_tgas(10);
/// Upper bound on resting orders per recipe book; bounds `clear_batch` gas and storage spam.
pub const MAX_ORDERS_PER_BOOK: usize = 200;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Parts,
    Runners,
    Recipes,
    Runs,
    Holdings,
    Balances,
    Books,
    OrderIndex,
    Batches,
    UsedQuotes,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Part {
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
    pub parts: Vec<String>,
    pub price_per_run: U128,
    pub royalty_bps: u16,
    pub total_shares: U128,
    pub acc_per_share: U128,
    /// Successful runs.
    pub runs: u64,
    pub revenue: U128,
    pub listed: bool,
    // ---- public track record (v2) ----
    /// Refunded runs that count against the recipe: reported failures and timeouts.
    pub failed: u64,
    /// Refunded runs the runner aborted before executing (inputs or market changed since the
    /// quote). Shown in the track record but not counted against the recipe.
    pub aborted: u64,
    /// Sum of `promised` over successful quoted runs.
    pub promised_total: U128,
    /// Sum of `delivered` over successful quoted runs.
    pub delivered_total: U128,
    /// Total paid to buyers from the bond for shortfalls.
    pub compensated_total: U128,
    /// Bond that can still back new quotes or be withdrawn by the creator.
    pub bond_available: U128,
    /// Bond set aside for pending quoted runs.
    pub bond_locked: U128,
    // ---- v4: durable runs and versioned recipes ----
    /// `"final"`: every party is paid in the final settlement. `"checkpoint"`: parts are billed
    /// to their authors at signed checkpoints as they complete (long-running workflows).
    pub settle_mode: String,
    /// Version number of `sealed_hash` (1 at publish, +1 on each activated update).
    pub version: u32,
    /// Announced next version (`""` when none). Takes effect at `update_effective_ns`.
    pub pending_sealed_hash: String,
    pub update_effective_ns: U64,
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
    /// sha256 of the canonical job inputs the quote was made for; `""` for unquoted runs.
    pub job_hash: String,
    /// Value the signed quote expected to deliver (best estimate), in payment-token units
    /// (0 when unquoted). Informational: compensation is measured against `promised`.
    pub expected: U128,
    /// Value the signed quote promised to deliver, in payment-token units (0 when unquoted).
    pub promised: U128,
    /// Part of the recipe's bond set aside for this run: the quote's signed `cover`.
    pub covered: U128,
    // ---- v4: durable runs ----
    /// Last runner-signed checkpoint recorded on-chain (0 = none).
    pub checkpoint_seq: u32,
    /// sha256 of the sealed run state at that checkpoint (`""` = none).
    pub state_hash: String,
    /// Parts already paid to their authors at checkpoints (checkpoint mode).
    pub parts_billed: Vec<String>,
    /// Sum of the fees paid at checkpoints; a refund returns `amount - billed`.
    pub billed: U128,
    /// Last progress (payment or checkpoint); `reclaim_run` counts the timeout from here.
    pub last_progress_ns: U64,
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
    pub parts: Vec<U128>,
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
    pub update_delay_ns: U64,
}

/// A runner-signed quote attached to a run payment (recipe intents).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct QuoteMsg {
    /// The recipe version that was quoted; must equal the recipe's current `sealed_hash`.
    pub sealed_hash: String,
    pub job_hash: String,
    pub expected: U128,
    pub promised: U128,
    /// Amount of the promise the bond guarantees; `cover <= promised`.
    pub cover: U128,
    pub expires_ns: U64,
    /// base64 ed25519 signature over `quote_message(...)` by the recipe's runner.
    pub signature: Base64VecU8,
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
        /// Optional signed quote; when present the run is backed by the recipe's bond.
        #[serde(default)]
        quote: Option<QuoteMsg>,
    },
    Bid {
        recipe_id: String,
        price: U128,
        qty: U128,
        /// Account that owns the bid and receives the shares (see `Run::on_behalf_of`).
        #[serde(default)]
        on_behalf_of: Option<AccountId>,
    },
    /// Adds to a recipe's bond, which backs its quotes.
    Bond {
        recipe_id: String,
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
    parts: IterableMap<String, Part>,
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
    /// sha256 of every accepted quote message: each signed quote backs exactly one run.
    used_quotes: LookupSet<Vec<u8>>,
    /// Notice period before an announced recipe version takes effect.
    update_delay_ns: u64,
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

/// Part ids end up inside the `|`/`,`-delimited signed report, so they are restricted.
fn valid_part_id(id: &str) -> bool {
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

/// Accepted `report_run` outcomes.
pub const OUTCOMES: [&str; 3] = ["ok", "fail", "abort"];

/// The exact UTF-8 message a runner signs for `report_run` (frs-run-v3).
pub fn run_report_message(
    contract_id: &str,
    run_id: &str,
    recipe_id: &str,
    outcome: &str,
    output_hash: &str,
    delivered: u128,
    parts_used: &[String],
) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}|{}|{}",
        SIGNED_MESSAGE_PREFIX,
        contract_id,
        run_id,
        recipe_id,
        outcome,
        output_hash,
        delivered,
        parts_used.join(",")
    )
}

/// The exact UTF-8 message a runner signs for `checkpoint_run` (frs-ckpt-v1).
pub fn checkpoint_message(
    contract_id: &str,
    run_id: &str,
    recipe_id: &str,
    seq: u32,
    state_hash: &str,
    parts_done: &[String],
) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}|{}",
        CHECKPOINT_MESSAGE_PREFIX,
        contract_id,
        run_id,
        recipe_id,
        seq,
        state_hash,
        parts_done.join(",")
    )
}

/// Removes the first occurrence of each element of `remove` from `from`; `None` if one is missing.
fn multiset_minus(from: &[String], remove: &[String]) -> Option<Vec<String>> {
    let mut left: Vec<String> = from.to_vec();
    for r in remove {
        let i = left.iter().position(|x| x == r)?;
        left.remove(i);
    }
    Some(left)
}

/// The exact UTF-8 message a runner signs for a quote (frs-quote-v2). It binds the quote to
/// the recipe version, the job, the buyer's sealed inputs and the buyer, so it can't be
/// replayed for another version, another job, another input set or another account.
pub fn quote_message(
    contract_id: &str,
    recipe_id: &str,
    sealed_hash: &str,
    job_hash: &str,
    inputs_hash: &str,
    buyer: &str,
    expected: u128,
    promised: u128,
    cover: u128,
    expires_ns: u64,
) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
        QUOTE_MESSAGE_PREFIX,
        contract_id,
        recipe_id,
        sealed_hash,
        job_hash,
        inputs_hash,
        buyer,
        expected,
        promised,
        cover,
        expires_ns
    )
}

fn verify_ed25519(signature: &[u8], message: &str, signing_pk: &str) -> bool {
    let sig: [u8; 64] = match signature.try_into() {
        Ok(s) => s,
        Err(_) => return false,
    };
    env::ed25519_verify(&sig, message.as_bytes(), &parse_ed25519(signing_pk))
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
        update_delay_ns: U64,
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
            parts: IterableMap::new(StorageKey::Parts),
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
            used_quotes: LookupSet::new(StorageKey::UsedQuotes),
            update_delay_ns: update_delay_ns.0,
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

    pub fn register_part(
        &mut self,
        id: String,
        version: String,
        fee_per_call: U128,
        manifest_hash: String,
    ) {
        require!(valid_part_id(&id), "part id must match ^[a-z0-9._@-]{1,64}$");
        require!(!self.parts.contains_key(&id), "part exists");
        let part = Part {
            id: id.clone(),
            version,
            author: env::predecessor_account_id(),
            fee_per_call,
            manifest_hash,
            active: true,
        };
        emit("part_registered", json!(part));
        self.parts.insert(id, part);
    }

    #[allow(clippy::too_many_arguments)]
    pub fn publish_recipe(
        &mut self,
        id: String,
        name: String,
        sealed_hash: String,
        runner_id: AccountId,
        parts: Vec<String>,
        price_per_run: U128,
        royalty_bps: u16,
        total_shares: U128,
        settle_mode: Option<String>,
    ) {
        require!(valid_ticker(&id), "recipe id must match ^[A-Z0-9]{3,6}$");
        let settle_mode = settle_mode.unwrap_or_else(|| "final".to_string());
        require!(
            SETTLE_MODES.contains(&settle_mode.as_str()),
            r#"settle_mode must be "final" or "checkpoint""#
        );
        require!(!self.recipes.contains_key(&id), "recipe exists");
        require!(royalty_bps <= MAX_ROYALTY_BPS, "royalty too high");
        require!(total_shares.0 > 0, "total_shares must be > 0");
        require!(!sealed_hash.is_empty(), "sealed_hash required");
        require!(!parts.is_empty(), "recipe needs at least one part");
        let runner = self
            .runners
            .get(&runner_id)
            .unwrap_or_else(|| env::panic_str("unknown runner"));
        require!(runner.active, "runner inactive");
        let mut fixed = protocol_fee(price_per_run.0, self.protocol_fee_bps) + runner.fee_per_run.0;
        for part_id in &parts {
            let part = self
                .parts
                .get(part_id)
                .unwrap_or_else(|| env::panic_str(&format!("unknown part {}", part_id)));
            require!(part.active, "part inactive");
            fixed += part.fee_per_call.0;
        }
        require!(
            price_per_run.0 >= fixed,
            format!(
                "price_per_run below minimum viable price {} (protocol + runner + part fees)",
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
            parts,
            price_per_run,
            royalty_bps,
            total_shares,
            acc_per_share: U128(0),
            runs: 0,
            revenue: U128(0),
            listed: true,
            failed: 0,
            aborted: 0,
            promised_total: U128(0),
            delivered_total: U128(0),
            compensated_total: U128(0),
            bond_available: U128(0),
            bond_locked: U128(0),
            settle_mode,
            version: 1,
            pending_sealed_hash: String::new(),
            update_effective_ns: U64(0),
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

    /// Announces a new sealed version. It takes effect `update_delay_ns` later, so shareholders
    /// and buyers get notice; runs paid before then keep the version they paid for.
    pub fn update_sealed(&mut self, id: String, sealed_hash: String) {
        let creator = self
            .recipes
            .get(&id)
            .unwrap_or_else(|| env::panic_str("unknown recipe"))
            .creator
            .clone();
        require!(env::predecessor_account_id() == creator, "creator only");
        require!(valid_hash(&sealed_hash), "sealed_hash must be 64 lowercase hex");
        self.activate_due(&id);
        let delay = self.update_delay_ns;
        let r = self.recipes.get_mut(&id).unwrap();
        require!(sealed_hash != r.sealed_hash, "same as current version");
        let effective_ns = env::block_timestamp() + delay;
        r.pending_sealed_hash = sealed_hash.clone();
        r.update_effective_ns = U64(effective_ns);
        let version = r.version + 1;
        emit(
            "recipe_update_scheduled",
            json!({"recipe_id": id, "sealed_hash": sealed_hash, "version": version, "effective_ns": U64(effective_ns)}),
        );
    }

    /// Creator withdraws an announced version before it takes effect.
    pub fn cancel_update(&mut self, id: String) {
        let r = self
            .recipes
            .get_mut(&id)
            .unwrap_or_else(|| env::panic_str("unknown recipe"));
        require!(env::predecessor_account_id() == r.creator, "creator only");
        require!(!r.pending_sealed_hash.is_empty(), "no pending update");
        let sealed_hash = std::mem::take(&mut r.pending_sealed_hash);
        r.update_effective_ns = U64(0);
        emit("recipe_update_cancelled", json!({"recipe_id": id, "sealed_hash": sealed_hash}));
    }

    /// Anyone may activate an announced version once its notice period is over.
    pub fn apply_update(&mut self, id: String) {
        let r = self
            .recipes
            .get(&id)
            .unwrap_or_else(|| env::panic_str("unknown recipe"));
        require!(
            !r.pending_sealed_hash.is_empty() && env::block_timestamp() >= r.update_effective_ns.0,
            "update not due"
        );
        self.activate_due(&id);
    }

    /// Activates a due pending version (no-op otherwise).
    fn activate_due(&mut self, id: &str) {
        let Some(r) = self.recipes.get_mut(id) else { return };
        if r.pending_sealed_hash.is_empty() || env::block_timestamp() < r.update_effective_ns.0 {
            return;
        }
        r.sealed_hash = std::mem::take(&mut r.pending_sealed_hash);
        r.update_effective_ns = U64(0);
        r.version += 1;
        emit(
            "recipe_updated",
            json!({"recipe_id": id, "sealed_hash": r.sealed_hash, "version": r.version}),
        );
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
                quote,
            } => {
                let owner = on_behalf_of.clone().unwrap_or_else(|| sender_id.clone());
                // a due recipe update takes effect before this payment is checked against it
                self.activate_due(&recipe_id);
                (
                    on_behalf_of,
                    self.internal_request_run(owner, amount.0, recipe_id, run_id, inputs_hash, quote),
                )
            }
            TransferMsg::Bond {
                recipe_id,
                on_behalf_of,
            } => {
                let from = on_behalf_of.clone().unwrap_or_else(|| sender_id.clone());
                (on_behalf_of, self.internal_post_bond(from, amount.0, recipe_id))
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
        quote: Option<QuoteMsg>,
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
        let recipe = self.recipes.get(&recipe_id).cloned().ok_or("unknown recipe")?;
        if !recipe.listed {
            return Err("recipe not listed".into());
        }
        let price = recipe.price_per_run.0;
        let sealed_hash = recipe.sealed_hash.clone();
        if amount < price {
            return Err("payment below price_per_run".into());
        }
        // signed quote (recipe intents): checked after the plain run checks, before any state change
        let (job_hash, expected, promised, covered, quote_key) = match &quote {
            None => (String::new(), 0u128, 0u128, 0u128, None),
            Some(q) => {
                if !valid_hash(&q.job_hash) {
                    return Err("job_hash must be 64 lowercase hex".into());
                }
                if q.sealed_hash != recipe.sealed_hash {
                    return Err("quote for an outdated recipe version".into());
                }
                let runner = self.runners.get(&recipe.runner_id).ok_or("unknown runner")?;
                if !runner.active {
                    return Err("runner inactive".into());
                }
                let msg = quote_message(
                    env::current_account_id().as_str(),
                    &recipe.id,
                    &q.sealed_hash,
                    &q.job_hash,
                    &inputs_hash,
                    buyer.as_str(),
                    q.expected.0,
                    q.promised.0,
                    q.cover.0,
                    q.expires_ns.0,
                );
                if !verify_ed25519(&q.signature.0, &msg, &runner.signing_pk) {
                    return Err("invalid quote signature".into());
                }
                if env::block_timestamp() > q.expires_ns.0 {
                    return Err("quote expired".into());
                }
                let key = env::sha256(msg.as_bytes());
                if self.used_quotes.contains(&key) {
                    return Err("quote already used".into());
                }
                if q.cover.0 > q.promised.0 {
                    return Err("cover exceeds promise".into());
                }
                if recipe.bond_available.0 < q.cover.0 {
                    return Err("bond below quoted cover".into());
                }
                (q.job_hash.clone(), q.expected.0, q.promised.0, q.cover.0, Some(key))
            }
        };
        if let Some(key) = quote_key {
            self.used_quotes.insert(key);
        }
        if amount > price {
            self.credit(&buyer, amount - price);
        }
        if covered > 0 {
            let r = self.recipes.get_mut(&recipe_id).unwrap();
            let b = bond::lock(bond_of(r), covered).unwrap_or_else(|| env::panic_str("bond below quoted cover"));
            set_bond(r, b);
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
            job_hash,
            expected: U128(expected),
            promised: U128(promised),
            covered: U128(covered),
            checkpoint_seq: 0,
            state_hash: String::new(),
            parts_billed: vec![],
            billed: U128(0),
            last_progress_ns: U64(env::block_timestamp()),
        };
        emit("run_requested", json!(run));
        self.runs.insert(run_id, run);
        Ok(())
    }

    fn internal_post_bond(&mut self, from: AccountId, amount: u128, recipe_id: String) -> Result<(), String> {
        let r = self.recipes.get_mut(&recipe_id).ok_or("unknown recipe")?;
        let b = bond::deposit(bond_of(r), amount).ok_or("bond overflow")?;
        set_bond(r, b);
        let available = r.bond_available;
        emit(
            "bond_posted",
            json!({"recipe_id": recipe_id, "from": from, "amount": U128(amount), "bond_available": available}),
        );
        Ok(())
    }

    /// Creator takes unlocked bond back into their withdrawable balance.
    pub fn withdraw_bond(&mut self, recipe_id: String, amount: U128) {
        let creator = env::predecessor_account_id();
        let r = self
            .recipes
            .get_mut(&recipe_id)
            .unwrap_or_else(|| env::panic_str("unknown recipe"));
        require!(r.creator == creator, "creator only");
        require!(amount.0 > 0, "amount must be > 0");
        require!(amount.0 <= r.bond_available.0, "amount exceeds bond_available");
        let b = bond::withdraw(bond_of(r), amount.0).unwrap_or_else(|| env::panic_str("amount exceeds bond_available"));
        set_bond(r, b);
        let available = r.bond_available;
        self.credit(&creator, amount.0);
        emit(
            "bond_withdrawn",
            json!({"recipe_id": recipe_id, "amount": amount, "bond_available": available}),
        );
    }

    /// Refunds a run's price, returns its cover to the bond and records it in the track record:
    /// `aborted` runs don't count against the recipe, every other refund counts as `failed`.
    fn refund_run(&mut self, run: &Run, reason: &str) {
        // parts already billed at checkpoints did their work and stay paid
        let refund = run.amount.0 - run.billed.0;
        self.credit(&run.buyer, refund);
        let r = self.recipes.get_mut(&run.recipe_id).unwrap();
        let b = bond::release(bond_of(r), run.covered.0).unwrap_or_else(|| env::panic_str("bond accounting"));
        set_bond(r, b);
        if reason == "runner_aborted" {
            r.aborted += 1;
        } else {
            r.failed += 1;
        }
        self.set_run_status(&run.run_id, RunStatus::Refunded);
        emit(
            "run_refunded",
            json!({"run_id": run.run_id, "buyer": run.buyer, "amount": U128(refund), "reason": reason}),
        );
    }

    pub fn report_run(
        &mut self,
        run_id: String,
        outcome: String,
        parts_used: Vec<String>,
        output_hash: String,
        delivered: U128,
        signature: Base64VecU8,
    ) -> Vec<Payout> {
        let run = self
            .runs
            .get(&run_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown run"));
        require!(run.status == RunStatus::Pending, "run not pending");
        require!(OUTCOMES.contains(&outcome.as_str()), "invalid outcome");
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
            &outcome,
            &output_hash,
            delivered.0,
            &parts_used,
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

        match outcome.as_str() {
            "fail" => {
                self.refund_run(&run, "runner_reported_failure");
                return vec![];
            }
            "abort" => {
                self.refund_run(&run, "runner_aborted");
                return vec![];
            }
            _ => {}
        }

        require!(
            is_sub_multiset(&parts_used, &recipe.parts),
            "parts_used not part of recipe"
        );
        require!(
            is_sub_multiset(&run.parts_billed, &parts_used),
            "parts_used must include billed parts"
        );
        // which entries of parts_used are still unpaid: drop the first occurrence of each billed part
        let mut still_billed: Vec<String> = run.parts_billed.clone();
        let unpaid: Vec<bool> = parts_used
            .iter()
            .map(|p| match still_billed.iter().position(|b| b == p) {
                Some(i) => {
                    still_billed.remove(i);
                    false
                }
                None => true,
            })
            .collect();
        let part_infos: Vec<Part> = parts_used
            .iter()
            .map(|part_id| self.parts.get(part_id).cloned().unwrap())
            .collect();
        let fees: Vec<u128> = part_infos.iter().map(|part| part.fee_per_call.0).collect();
        let split = settlement_split(
            run.amount.0,
            self.protocol_fee_bps,
            runner.fee_per_run.0,
            &fees,
            recipe.royalty_bps,
            recipe.total_shares.0,
            recipe.acc_per_share.0,
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
        for ((part, fee), unpaid) in part_infos.iter().zip(fees.iter()).zip(unpaid.iter()) {
            if *unpaid {
                pay(self, &part.author, &format!("part:{}", part.id), *fee);
            }
        }
        pay(self, &recipe.creator, "creator_royalty", split.creator);

        // bonded quote: pay any shortfall to the buyer from the cover set aside at payment
        let r = self.recipes.get_mut(&recipe.id).unwrap();
        let (b, compensation) = bond::settle(bond_of(r), run.covered.0, run.promised.0, delivered.0)
            .unwrap_or_else(|| env::panic_str("bond accounting"));
        r.acc_per_share = U128(r.acc_per_share.0 + split.acc_increment);
        r.runs += 1;
        r.revenue = U128(r.revenue.0 + run.amount.0);
        set_bond(r, b);
        if !run.job_hash.is_empty() {
            r.promised_total = U128(r.promised_total.0 + run.promised.0);
            r.delivered_total = U128(r.delivered_total.0 + delivered.0);
        }
        r.compensated_total = U128(r.compensated_total.0 + compensation);
        if compensation > 0 {
            self.credit(&run.buyer, compensation);
        }
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
                "delivered": delivered,
                "compensation": U128(compensation),
            }),
        );
        payouts
    }

    /// Records a runner-signed checkpoint of a pending run: progress (extends the timeout) and,
    /// in checkpoint mode, bills the parts completed since the last checkpoint to their authors.
    pub fn checkpoint_run(
        &mut self,
        run_id: String,
        seq: u32,
        state_hash: String,
        parts_done: Vec<String>,
        signature: Base64VecU8,
    ) -> Vec<Payout> {
        let run = self
            .runs
            .get(&run_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown run"));
        require!(run.status == RunStatus::Pending, "run not pending");
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
        require!(seq == run.checkpoint_seq + 1, "seq must be checkpoint_seq + 1");
        require!(valid_hash(&state_hash), "state_hash must be 64 lowercase hex");
        let msg = checkpoint_message(
            env::current_account_id().as_str(),
            &run_id,
            &recipe.id,
            seq,
            &state_hash,
            &parts_done,
        );
        require!(
            verify_ed25519(&signature.0, &msg, &runner.signing_pk),
            "invalid runner signature"
        );
        let mut payouts: Vec<Payout> = Vec::new();
        let mut billed = run.billed.0;
        let mut parts_billed = run.parts_billed.clone();
        if !parts_done.is_empty() {
            require!(
                recipe.settle_mode == "checkpoint",
                "parts can only be billed at checkpoints in checkpoint mode"
            );
            let mut all = parts_billed.clone();
            all.extend(parts_done.iter().cloned());
            require!(
                multiset_minus(&recipe.parts, &all).is_some(),
                "parts_done not part of recipe"
            );
            for part_id in &parts_done {
                let part = self.parts.get(part_id).cloned().unwrap();
                if part.fee_per_call.0 > 0 {
                    self.credit(&part.author, part.fee_per_call.0);
                }
                billed += part.fee_per_call.0;
                payouts.push(Payout {
                    account_id: part.author.clone(),
                    role: format!("part:{}", part.id),
                    amount: part.fee_per_call,
                });
            }
            parts_billed = all;
        }
        let r = self.runs.get_mut(&run_id).unwrap();
        r.checkpoint_seq = seq;
        r.state_hash = state_hash.clone();
        r.parts_billed = parts_billed;
        r.billed = U128(billed);
        r.last_progress_ns = U64(env::block_timestamp());
        emit(
            "run_checkpoint",
            json!({
                "run_id": run_id,
                "seq": seq,
                "state_hash": state_hash,
                "parts_done": parts_done,
                "billed": U128(billed),
                "payouts": payouts,
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
            env::block_timestamp() >= run.last_progress_ns.0 + RUN_TIMEOUT_NS,
            "run not timed out"
        );
        self.refund_run(&run, "timeout");
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
        let (pending, debt) = dividends::harvest(h.shares, h.reward_debt, acc);
        h.reward_debt = debt;
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
        hf.reward_debt = dividends::rebase(hf.shares, acc);
        self.holdings.insert((recipe_id.to_string(), from.clone()), hf);
        let mut ht = self.holding(recipe_id, to);
        ht.shares += qty;
        ht.reward_debt = dividends::rebase(ht.shares, acc);
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
                h.reward_debt = dividends::rebase(h.shares, acc);
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
            update_delay_ns: U64(self.update_delay_ns),
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

    pub fn get_part(&self, part_id: String) -> Option<Part> {
        self.parts.get(&part_id).cloned()
    }

    pub fn list_parts(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Part> {
        self.parts
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
        U128(dividends::pending(h.shares, h.reward_debt, acc))
    }

    pub fn balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.balances.get(&account_id).copied().unwrap_or(0))
    }

    pub fn quote_settlement(&self, recipe_id: String, parts_used: Option<Vec<String>>) -> SplitView {
        let recipe = self
            .recipes
            .get(&recipe_id)
            .unwrap_or_else(|| env::panic_str("unknown recipe"));
        let used = parts_used.unwrap_or_else(|| recipe.parts.clone());
        require!(is_sub_multiset(&used, &recipe.parts), "parts_used not part of recipe");
        let fees: Vec<u128> = used
            .iter()
            .map(|b| self.parts.get(b).unwrap().fee_per_call.0)
            .collect();
        let runner_fee = self.runners.get(&recipe.runner_id).unwrap().fee_per_run.0;
        let s = settlement_split(
            recipe.price_per_run.0,
            self.protocol_fee_bps,
            runner_fee,
            &fees,
            recipe.royalty_bps,
            recipe.total_shares.0,
            recipe.acc_per_share.0,
        )
        .unwrap_or_else(|| env::panic_str("fees exceed price"));
        SplitView {
            price: recipe.price_per_run,
            protocol: U128(s.protocol),
            runner: U128(s.runner),
            parts: s.parts.iter().map(|b| U128(*b)).collect(),
            remainder: U128(s.remainder),
            creator: U128(s.creator),
            pool: U128(s.pool),
            acc_increment: U128(s.acc_increment),
            distributed: U128(s.distributed),
            dust_to_protocol: U128(s.dust_to_protocol),
        }
    }
}

fn bond_of(r: &Recipe) -> bond::Bond {
    bond::Bond { available: r.bond_available.0, locked: r.bond_locked.0 }
}

fn set_bond(r: &mut Recipe, b: bond::Bond) {
    r.bond_available = U128(b.available);
    r.bond_locked = U128(b.locked);
}
