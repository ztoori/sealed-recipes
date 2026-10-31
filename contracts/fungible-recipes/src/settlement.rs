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
    pub blocks: Vec<u128>,
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
/// Returns `None` when the fixed fees exceed the price (publish rejects such recipes)
/// or when `total_shares == 0`.
pub fn settlement_split(
    price: u128,
    protocol_fee_bps: u16,
    runner_fee: u128,
    block_fees: &[u128],
    royalty_bps: u16,
    total_shares: u128,
) -> Option<Split> {
    if total_shares == 0 {
        return None;
    }
    let protocol = protocol_fee(price, protocol_fee_bps);
    let block_sum = block_fees
        .iter()
        .try_fold(0u128, |acc, f| acc.checked_add(*f))?;
    let remainder = price
        .checked_sub(protocol)?
        .checked_sub(runner_fee)?
        .checked_sub(block_sum)?;
    let creator = remainder * royalty_bps as u128 / BPS_DENOM;
    let pool = remainder - creator;
    let acc_increment = pool.checked_mul(ACC_SCALE)? / total_shares;
    let distributed = acc_increment.checked_mul(total_shares)? / ACC_SCALE;
    let dust_to_protocol = pool - distributed;
    Some(Split {
        protocol,
        runner: runner_fee,
        blocks: block_fees.to_vec(),
        remainder,
        creator,
        pool,
        acc_increment,
        distributed,
        dust_to_protocol,
    })
}
