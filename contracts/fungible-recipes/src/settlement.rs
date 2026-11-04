//! Pure settlement math. Shared spec: docs/CONTRACT_SPEC.md ("v5 changes").
//! The TypeScript mirror (packages/core) implements the same function and both
//! are checked against contracts/test-vectors/settlement.json.
//!
//! ```text
//! protocol = floor(P * f / 10000)
//! R        = P - protocol - r - sum(b_i)
//! reserve  = floor(R * reserve_bps / 10000)   -> recipe guarantee deposit (bond_available)
//! creator  = R - reserve                       -> creator's withdrawable balance
//! ```
//! Conservation is exact: protocol + r + sum(b_i) + reserve + creator == P.

pub const BPS_DENOM: u128 = 10_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Split {
    pub protocol: u128,
    pub runner: u128,
    pub parts: Vec<u128>,
    pub remainder: u128,
    pub reserve: u128,
    pub creator: u128,
}

/// Protocol fee charged on a price (saturating; a price large enough to overflow cannot settle anyway).
pub fn protocol_fee(price: u128, protocol_fee_bps: u16) -> u128 {
    price.saturating_mul(protocol_fee_bps as u128) / BPS_DENOM
}

/// Splits one run payment between every party.
///
/// Returns `None` when the fixed fees exceed the price (publish rejects such recipes), when
/// `reserve_bps` or `protocol_fee_bps` exceed 10000, or when any intermediate value would overflow u128.
pub fn settlement_split(
    price: u128,
    protocol_fee_bps: u16,
    runner_fee: u128,
    part_fees: &[u128],
    reserve_bps: u16,
) -> Option<Split> {
    if reserve_bps as u128 > BPS_DENOM || protocol_fee_bps as u128 > BPS_DENOM {
        return None;
    }
    let protocol = price.checked_mul(protocol_fee_bps as u128)? / BPS_DENOM;
    let part_sum = part_fees
        .iter()
        .try_fold(0u128, |acc, f| acc.checked_add(*f))?;
    let remainder = price
        .checked_sub(protocol)?
        .checked_sub(runner_fee)?
        .checked_sub(part_sum)?;
    let reserve = remainder.checked_mul(reserve_bps as u128)? / BPS_DENOM;
    let creator = remainder.checked_sub(reserve)?;
    Some(Split {
        protocol,
        runner: runner_fee,
        parts: part_fees.to_vec(),
        remainder,
        reserve,
        creator,
    })
}
