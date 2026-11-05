//! Market-driven list prices (contract v6). Shared spec: docs/CONTRACT_SPEC.md ("v6 changes").
//!
//! Each recipe has a list price that follows demand inside a band the creator sets, with the same
//! rule Ethereum uses for its base fee (EIP-1559). Time is cut into periods of `price_period_ns`.
//! At the end of a period with `runs` paid runs against a target of `target` runs:
//!
//! ```text
//! used  = min(runs, 2 * target)
//! price' = price + floor(price * (used - target) / (8 * target))   if used >= target
//! price' = price - floor(price * (target - used) / (8 * target))   otherwise
//! price' = clamp(price', floor, ceiling)
//! ```
//!
//! So a period can move the price by at most 12.5% either way, an idle recipe drifts down to its
//! floor and a busy one up to its ceiling. Periods with no activity are applied lazily, at most
//! `MAX_CATCHUP_PERIODS` at a time (after 64 idle periods any price is at its floor anyway:
//! 0.875^64 < 0.0002). The TypeScript mirror implements the same functions and both are checked
//! against vectors generated from the model proved in verification/smt.

/// Highest allowed `price_ceiling` (10^30 payment-token units). With `target <= MAX_TARGET_RUNS`
/// every intermediate product stays below 2^128 (proved in verification/smt).
pub const MAX_PRICE: u128 = 1_000_000_000_000_000_000_000_000_000_000;
/// Highest allowed `target_runs` per period.
pub const MAX_TARGET_RUNS: u32 = 1_000_000;
/// Idle periods applied in one catch-up; bounds gas.
pub const MAX_CATCHUP_PERIODS: u64 = 64;

/// One period of the demand rule. `None` only for out-of-range inputs, which publish and
/// `set_pricing` reject (`target == 0`, `floor > ceiling`, `ceiling > MAX_PRICE`, `target > MAX_TARGET_RUNS`).
pub fn next_price(price: u128, runs: u64, target: u32, floor: u128, ceiling: u128) -> Option<u128> {
    if target == 0 || target > MAX_TARGET_RUNS || floor > ceiling || ceiling > MAX_PRICE || price > MAX_PRICE {
        return None;
    }
    let t = target as u128;
    let used = (runs as u128).min(2 * t);
    let p = if used >= t {
        price.checked_add(price.checked_mul(used - t)? / (8 * t))?
    } else {
        price - price.checked_mul(t - used)? / (8 * t)
    };
    Some(p.clamp(floor, ceiling))
}

/// Applies every period that ended before `now`: the first one with the runs counted in it, the
/// rest as idle periods (capped at `MAX_CATCHUP_PERIODS`). Returns the new price, the new period
/// start and the number of periods that ended. Pure, so views can show the current price too.
pub fn roll(
    price: u128,
    period_runs: u64,
    period_start_ns: u64,
    period_ns: u64,
    now: u64,
    target: u32,
    floor: u128,
    ceiling: u128,
) -> Option<(u128, u64, u64)> {
    if period_ns == 0 || now < period_start_ns.saturating_add(period_ns) {
        return Some((price, period_start_ns, 0));
    }
    let ended = (now - period_start_ns) / period_ns;
    let mut p = next_price(price, period_runs, target, floor, ceiling)?;
    for _ in 1..ended.min(MAX_CATCHUP_PERIODS) {
        if p == floor {
            break;
        }
        p = next_price(p, 0, target, floor, ceiling)?;
    }
    Some((p, period_start_ns + ended * period_ns, ended))
}
