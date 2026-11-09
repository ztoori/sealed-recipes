//! # Sealed Recipes
//!
//! Sealed no-code workflows ("recipes") composed from third-party parts, sold
//! pay-per-run through NEAR Intents and executed by an attested TEE runner.
//! Every run is settled in one receipt: protocol fee, runner fee, part fees,
//! then the creator. A recipe can set aside `reserve_bps` of the creator's
//! remainder into its guarantee deposit (`bond_available`), which backs quotes.
//! There are no shares, dividends or order books (v5). Each recipe's price per run follows
//! demand inside a band its creator sets (v6, `pricing.rs`), and a signed quote can lock a price.
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

pub mod bond;
pub mod pricing;
pub mod settlement;
pub use settlement::{protocol_fee, settlement_split, Split};

#[cfg(test)]
mod tests;

pub const RUN_TIMEOUT_NS: u64 = 15 * 60 * 1_000_000_000;
pub const MAX_PROTOCOL_FEE_BPS: u16 = 1_000;
pub const EVENT_STANDARD: &str = "sealed-recipes";
pub const EVENT_VERSION: &str = "1.0.0";
pub const SIGNED_MESSAGE_PREFIX: &str = "srs-run-v3";
pub const QUOTE_MESSAGE_PREFIX: &str = "srs-quote-v3";
pub const CHECKPOINT_MESSAGE_PREFIX: &str = "srs-ckpt-v1";
/// Accepted `settle_mode` values: settle everything at the end, or bill parts at checkpoints.
pub const SETTLE_MODES: [&str; 2] = ["final", "checkpoint"];
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_ON_WITHDRAW: Gas = Gas::from_tgas(10);
/// Size limits on the fixed-format fields of `register_part` and `publish_recipe` (a semver version,
/// hashes). Names and part lists have no cap (SRS-1 §12: nothing caps the nodes in a recipe); the
/// caller pays for every byte stored (see `charge_storage`), so the contract's NEAR can't be drained.
pub const MAX_VERSION_LEN: usize = 32;
pub const MAX_HASH_LEN: usize = 128;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Parts,
    Runners,
    Recipes,
    Runs,
    Balances,
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
    /// Share of the creator's remainder (after protocol, runner and part fees) added to the
    /// recipe's guarantee deposit (`bond_available`) on every successful run. 0..=10000.
    pub reserve_bps: u16,
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
    // ---- v6: market-driven pricing (`price_per_run` is the current list price) ----
    /// Lowest list price; at least the minimum viable price (protocol + runner + part fees).
    pub price_floor: U128,
    /// Highest list price.
    pub price_ceiling: U128,
    /// Paid runs per period at which the list price holds steady.
    pub target_runs: u32,
    /// Start of the current pricing period.
    pub period_start_ns: U64,
    /// Paid runs counted in the current period.
    pub period_runs: u64,
}

/// Creator-set pricing band (v6). Omitted at publish: a fixed price (floor = ceiling = price).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PricingInput {
    pub price_floor: U128,
    pub price_ceiling: U128,
    pub target_runs: u32,
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
    pub reserve: U128,
    pub creator: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ConfigView {
    pub owner: AccountId,
    pub payment_token: AccountId,
    pub protocol_account: AccountId,
    pub protocol_fee_bps: u16,
    pub update_delay_ns: U64,
    pub price_period_ns: U64,
}

/// A runner-signed quote attached to a run payment (recipe intents).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct QuoteMsg {
    /// The recipe version that was quoted; must equal the recipe's current `sealed_hash`.
    pub sealed_hash: String,
    pub job_hash: String,
    /// Price per run this quote locks in (v6); must lie within the recipe's floor and ceiling.
    pub price: U128,
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
#[allow(clippy::large_enum_variant)] // parsed once per call; boxing would complicate the serde shape
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
        /// Most the buyer will pay (v6): the run is rejected if the price is above it.
        #[serde(default)]
        max_price: Option<U128>,
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
    balances: LookupMap<AccountId, u128>,
    /// sha256 of every accepted quote message: each signed quote backs exactly one run.
    used_quotes: LookupSet<Vec<u8>>,
    /// Notice period before an announced recipe version takes effect.
    update_delay_ns: u64,
    /// Length of a pricing period (v6).
    price_period_ns: u64,
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

/// Charges the caller for the storage this call added since `before` (`env::storage_usage()`):
/// the attached deposit must cover it, and the rest is refunded to the caller.
fn charge_storage(before: u64) {
    let used = env::storage_usage().saturating_sub(before);
    let cost = env::storage_byte_cost().saturating_mul(used as u128);
    let attached = env::attached_deposit();
    require!(
        attached >= cost,
        format!(
            "attach at least {} yoctoNEAR to pay for {} bytes of storage",
            cost.as_yoctonear(),
            used
        )
    );
    let refund = attached.saturating_sub(cost);
    if !refund.is_zero() {
        let _ = Promise::new(env::predecessor_account_id()).transfer(refund);
    }
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

/// The exact UTF-8 message a runner signs for `report_run` (srs-run-v3).
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

/// The exact UTF-8 message a runner signs for `checkpoint_run` (srs-ckpt-v1).
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

/// The exact UTF-8 message a runner signs for a quote (srs-quote-v3). It binds the quote to
/// the recipe version, the job, the buyer's sealed inputs, the buyer and the price, so it can't be
/// replayed for another version, another job, another input set, another account or another price.
pub fn quote_message(
    contract_id: &str,
    recipe_id: &str,
    sealed_hash: &str,
    job_hash: &str,
    inputs_hash: &str,
    buyer: &str,
    price: u128,
    expected: u128,
    promised: u128,
    cover: u128,
    expires_ns: u64,
) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
        QUOTE_MESSAGE_PREFIX,
        contract_id,
        recipe_id,
        sealed_hash,
        job_hash,
        inputs_hash,
        buyer,
        price,
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
        update_delay_ns: U64,
        price_period_ns: U64,
    ) -> Self {
        require!(
            protocol_fee_bps <= MAX_PROTOCOL_FEE_BPS,
            "protocol fee too high"
        );
        require!(price_period_ns.0 > 0, "price_period_ns must be > 0");
        Self {
            owner,
            payment_token,
            protocol_account,
            protocol_fee_bps,
            parts: IterableMap::new(StorageKey::Parts),
            runners: IterableMap::new(StorageKey::Runners),
            recipes: IterableMap::new(StorageKey::Recipes),
            runs: LookupMap::new(StorageKey::Runs),
            balances: LookupMap::new(StorageKey::Balances),
            used_quotes: LookupSet::new(StorageKey::UsedQuotes),
            update_delay_ns: update_delay_ns.0,
            price_period_ns: price_period_ns.0,
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

    /// Registers a part. Payable: attach enough NEAR for the part's storage (the error says how
    /// much); the rest is refunded.
    #[payable]
    pub fn register_part(
        &mut self,
        id: String,
        version: String,
        fee_per_call: U128,
        manifest_hash: String,
    ) {
        let before = env::storage_usage();
        require!(valid_part_id(&id), "part id must match ^[a-z0-9._@-]{1,64}$");
        require!(!self.parts.contains_key(&id), "part exists");
        require!(
            (1..=MAX_VERSION_LEN).contains(&version.len()),
            "version must be 1..=32 bytes"
        );
        require!(
            (1..=MAX_HASH_LEN).contains(&manifest_hash.len()),
            "manifest_hash must be 1..=128 bytes"
        );
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
        self.parts.flush();
        charge_storage(before);
    }

    /// Publishes a recipe. Payable: attach enough NEAR for the recipe's storage (the error says how
    /// much); the rest is refunded.
    #[allow(clippy::too_many_arguments)]
    #[payable]
    pub fn publish_recipe(
        &mut self,
        id: String,
        name: String,
        sealed_hash: String,
        runner_id: AccountId,
        parts: Vec<String>,
        price_per_run: U128,
        reserve_bps: u16,
        settle_mode: Option<String>,
        pricing: Option<PricingInput>,
    ) {
        let before = env::storage_usage();
        require!(valid_ticker(&id), "recipe id must match ^[A-Z0-9]{3,6}$");
        require!(
            sealed_hash.len() <= MAX_HASH_LEN,
            "sealed_hash must be at most 128 bytes"
        );
        let settle_mode = settle_mode.unwrap_or_else(|| "final".to_string());
        require!(
            SETTLE_MODES.contains(&settle_mode.as_str()),
            r#"settle_mode must be "final" or "checkpoint""#
        );
        require!(!self.recipes.contains_key(&id), "recipe exists");
        require!(reserve_bps <= 10_000, "reserve_bps must be <= 10000");
        require!(!sealed_hash.is_empty(), "sealed_hash required");
        require!(!parts.is_empty(), "recipe needs at least one part");
        let runner = self
            .runners
            .get(&runner_id)
            .unwrap_or_else(|| env::panic_str("unknown runner"));
        require!(runner.active, "runner inactive");
        let pricing = pricing.unwrap_or(PricingInput {
            price_floor: price_per_run,
            price_ceiling: price_per_run,
            target_runs: 1,
        });
        let mut fees = runner.fee_per_run.0;
        for part_id in &parts {
            let part = self
                .parts
                .get(part_id)
                .unwrap_or_else(|| env::panic_str(&format!("unknown part {}", part_id)));
            require!(part.active, "part inactive");
            fees += part.fee_per_call.0;
        }
        self.check_pricing(&pricing, fees);
        require!(
            pricing.price_floor.0 <= price_per_run.0 && price_per_run.0 <= pricing.price_ceiling.0,
            "price_per_run must be within price_floor and price_ceiling"
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
            reserve_bps,
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
            price_floor: pricing.price_floor,
            price_ceiling: pricing.price_ceiling,
            target_runs: pricing.target_runs,
            period_start_ns: U64(env::block_timestamp()),
            period_runs: 0,
        };
        emit("recipe_published", json!(recipe));
        self.recipes.insert(id, recipe);
        self.recipes.flush();
        charge_storage(before);
    }

    /// Validates a pricing band: `floor` must cover the protocol fee on itself plus the runner and
    /// part fees (the protocol fee only grows with the price, so every price >= floor is viable).
    fn check_pricing(&self, p: &PricingInput, fees: u128) {
        require!(
            p.target_runs >= 1 && p.target_runs <= pricing::MAX_TARGET_RUNS,
            "target_runs must be 1..=1000000"
        );
        require!(p.price_floor.0 <= p.price_ceiling.0, "price_floor must be <= price_ceiling");
        require!(p.price_ceiling.0 <= pricing::MAX_PRICE, "price_ceiling too high");
        let fixed = protocol_fee(p.price_floor.0, self.protocol_fee_bps) + fees;
        require!(
            p.price_floor.0 >= fixed,
            format!(
                "price_floor below minimum viable price {} (protocol + runner + part fees)",
                fixed
            )
        );
    }

    /// Creator changes the pricing band. The list price is first brought up to date, then
    /// clamped into the new band; the current period's count carries over.
    pub fn set_pricing(&mut self, id: String, pricing: PricingInput) {
        let r = self
            .recipes
            .get(&id)
            .unwrap_or_else(|| env::panic_str("unknown recipe"))
            .clone();
        require!(env::predecessor_account_id() == r.creator, "creator only");
        let runner = self.runners.get(&r.runner_id).unwrap_or_else(|| env::panic_str("unknown runner"));
        let mut fees = runner.fee_per_run.0;
        for part_id in &r.parts {
            fees += self.parts.get(part_id).map(|p| p.fee_per_call.0).unwrap_or(0);
        }
        self.check_pricing(&pricing, fees);
        self.roll_price(&id);
        let r = self.recipes.get_mut(&id).unwrap();
        r.price_floor = pricing.price_floor;
        r.price_ceiling = pricing.price_ceiling;
        r.target_runs = pricing.target_runs;
        r.price_per_run = U128(r.price_per_run.0.clamp(pricing.price_floor.0, pricing.price_ceiling.0));
        emit(
            "pricing_updated",
            json!({"recipe_id": id, "price_floor": r.price_floor, "price_ceiling": r.price_ceiling,
                   "target_runs": r.target_runs, "price": r.price_per_run}),
        );
    }

    /// Anyone may apply ended pricing periods (a keeper keeps `price_updated` events timely; a
    /// payment would apply them anyway). Returns the current list price.
    pub fn update_price(&mut self, id: String) -> U128 {
        require!(self.recipes.contains_key(&id), "unknown recipe");
        self.roll_price(&id);
        self.recipes.get(&id).unwrap().price_per_run
    }

    /// The recipe with every ended pricing period applied (pure).
    fn rolled(&self, r: &Recipe) -> (Recipe, u64) {
        let (price, start, ended) = pricing::roll(
            r.price_per_run.0,
            r.period_runs,
            r.period_start_ns.0,
            self.price_period_ns,
            env::block_timestamp(),
            r.target_runs,
            r.price_floor.0,
            r.price_ceiling.0,
        )
        .unwrap_or_else(|| env::panic_str("pricing out of range"));
        let mut out = r.clone();
        if ended > 0 {
            out.price_per_run = U128(price);
            out.period_start_ns = U64(start);
            out.period_runs = 0;
        }
        (out, ended)
    }

    /// Applies ended pricing periods to storage; emits `price_updated` when the price moved.
    fn roll_price(&mut self, id: &str) {
        let Some(r) = self.recipes.get(id) else { return };
        let (next, ended) = self.rolled(r);
        if ended == 0 {
            return;
        }
        let (previous, runs) = (r.price_per_run, r.period_runs);
        if next.price_per_run.0 != previous.0 {
            emit(
                "price_updated",
                json!({"recipe_id": id, "previous": previous, "price": next.price_per_run,
                       "periods": U64(ended), "runs": U64(runs), "target_runs": next.target_runs}),
            );
        }
        self.recipes.insert(id.to_string(), next);
    }

    /// Announces a new sealed version. It takes effect `update_delay_ns` later, so buyers get
    /// notice; runs paid before then keep the version they paid for.
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
                max_price,
            } => {
                let owner = on_behalf_of.clone().unwrap_or_else(|| sender_id.clone());
                // a due recipe update and ended pricing periods take effect before this payment is checked
                self.activate_due(&recipe_id);
                self.roll_price(&recipe_id);
                (
                    on_behalf_of,
                    self.internal_request_run(owner, amount.0, recipe_id, run_id, inputs_hash, quote, max_price),
                )
            }
            TransferMsg::Bond {
                recipe_id,
                on_behalf_of,
            } => {
                let from = on_behalf_of.clone().unwrap_or_else(|| sender_id.clone());
                (on_behalf_of, self.internal_post_bond(from, amount.0, recipe_id))
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
        max_price: Option<U128>,
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
        // a signed quote locks its price (within the band); otherwise the current list price applies
        let price = match &quote {
            Some(q) => q.price.0,
            None => recipe.price_per_run.0,
        };
        if price < recipe.price_floor.0 || price > recipe.price_ceiling.0 {
            return Err("quoted price outside price_floor..price_ceiling".into());
        }
        if let Some(m) = max_price {
            if price > m.0 {
                return Err("price above max_price".into());
            }
        }
        let sealed_hash = recipe.sealed_hash.clone();
        if amount < price {
            return Err("payment below price".into());
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
                    q.price.0,
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
        {
            let r = self.recipes.get_mut(&recipe_id).unwrap();
            if covered > 0 {
                let b = bond::lock(bond_of(r), covered).unwrap_or_else(|| env::panic_str("bond below quoted cover"));
                set_bond(r, b);
            }
            r.period_runs += 1; // demand counted at payment
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
            recipe.reserve_bps,
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
        pay(self, &protocol_account, "protocol", split.protocol);
        pay(self, &runner.id, "runner", split.runner);
        for ((part, fee), unpaid) in part_infos.iter().zip(fees.iter()).zip(unpaid.iter()) {
            if *unpaid {
                pay(self, &part.author, &format!("part:{}", part.id), *fee);
            }
        }
        pay(self, &recipe.creator, "creator", split.creator);

        // bonded quote: pay any shortfall to the buyer from the cover set aside at payment
        let r = self.recipes.get_mut(&recipe.id).unwrap();
        let (b, compensation) = bond::settle(bond_of(r), run.covered.0, run.promised.0, delivered.0)
            .unwrap_or_else(|| env::panic_str("bond accounting"));
        // the reserve share of this run tops up the guarantee deposit
        let b = bond::deposit(b, split.reserve).unwrap_or_else(|| env::panic_str("bond accounting"));
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
            "srs_settlement",
            json!({
                "run_id": run_id,
                "recipe_id": recipe.id,
                "buyer": run.buyer,
                "price": run.amount,
                "output_hash": output_hash,
                "payouts": payouts,
                "reserve": U128(split.reserve),
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
                json!({"receiver_id": account, "amount": U128(amount), "memo": "sealed-recipes withdraw"})
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

    // ----------------------------------------------------------------- views

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner: self.owner.clone(),
            payment_token: self.payment_token.clone(),
            protocol_account: self.protocol_account.clone(),
            protocol_fee_bps: self.protocol_fee_bps,
            update_delay_ns: U64(self.update_delay_ns),
            price_period_ns: U64(self.price_period_ns),
        }
    }

    /// The recipe as of now: ended pricing periods are applied to the returned copy, so
    /// `price_per_run` is the price a payment made now would be charged.
    pub fn get_recipe(&self, recipe_id: String) -> Option<Recipe> {
        self.recipes.get(&recipe_id).map(|r| self.rolled(r).0)
    }

    pub fn list_recipes(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Recipe> {
        self.recipes
            .values()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50) as usize)
            .map(|r| self.rolled(r).0)
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

    pub fn balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.balances.get(&account_id).copied().unwrap_or(0))
    }

    pub fn quote_settlement(&self, recipe_id: String, parts_used: Option<Vec<String>>) -> SplitView {
        let recipe = self
            .recipes
            .get(&recipe_id)
            .map(|r| self.rolled(r).0)
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
            recipe.reserve_bps,
        )
        .unwrap_or_else(|| env::panic_str("fees exceed price"));
        SplitView {
            price: recipe.price_per_run,
            protocol: U128(s.protocol),
            runner: U128(s.runner),
            parts: s.parts.iter().map(|b| U128(*b)).collect(),
            remainder: U128(s.remainder),
            reserve: U128(s.reserve),
            creator: U128(s.creator),
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
