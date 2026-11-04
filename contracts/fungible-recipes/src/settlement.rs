//! Pure settlement math. Shared spec: docs/CONTRACT_SPEC.md ("Settlement").
//! The TypeScript mirror (packages/core) implements the same function and both
//! are checked against contracts/test-vectors/settlement.json.

/// Fixed-point scale of `acc_per_share`.
pub const ACC_SCALE: u128 = 1_000_000_000_000_000_000; // 1e18
pub const BPS_DENOM: u128 = 10_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Split {
    pub protocol: u128,
    pub runner: u128,
    pub parts: Vec<u128>,
    pub remainder: u128,
    pub creator: u128,
    pub pool: u128,
    pub acc_increment: u128,
    pub distributed: u128,
    pub dust_to_protocol: u128,
}

impl Split {
    /// Protocol fee plus rounding dust from the shareholder pool.
    pub fn protocol_total(&self) -> u128 {
        self.protocol + self.dust_to_protocol
    }
}

/// Protocol fee charged on a price.
pub fn protocol_fee(price: u128, protocol_fee_bps: u16) -> u128 {
    price * protocol_fee_bps as u128 / BPS_DENOM
}

/// Splits one run payment between every party.
///
/// `acc_before` is the recipe's `acc_per_share` before this run. The shareholders' share is computed so that
/// the total ever set aside telescopes to `floor(acc * total_shares / ACC_SCALE)`, which is exactly the most
/// holders can claim in total: the contract can never owe holders more than it set aside
/// (verification/smt/prove_money.py: telescoping-two-runs-solvent, dividends K-invariant).
///
/// Returns `None` when the fixed fees exceed the price (publish rejects such recipes), when
/// `total_shares == 0`, or when a product would overflow u128. Overflow is proven impossible while the
/// recipe's lifetime settled revenue stays below 3.4e20 payment-token units (never-fails-when-fees-fit).
pub fn settlement_split(
    price: u128,
    protocol_fee_bps: u16,
    runner_fee: u128,
    part_fees: &[u128],
    royalty_bps: u16,
    total_shares: u128,
    acc_before: u128,
) -> Option<Split> {
    if total_shares == 0 {
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
    let creator = remainder.checked_mul(royalty_bps as u128)? / BPS_DENOM;
    let pool = remainder - creator;
    let acc_increment = pool.checked_mul(ACC_SCALE)? / total_shares;
    let acc_after = acc_before.checked_add(acc_increment)?;
    let set_aside_before = acc_before.checked_mul(total_shares)? / ACC_SCALE;
    let set_aside_after = acc_after.checked_mul(total_shares)? / ACC_SCALE;
    let distributed = set_aside_after - set_aside_before;
    let dust_to_protocol = pool - distributed;
    Some(Split {
        protocol,
        runner: runner_fee,
        parts: part_fees.to_vec(),
        remainder,
        creator,
        pool,
        acc_increment,
        distributed,
        dust_to_protocol,
    })
}
