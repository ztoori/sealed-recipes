//! Dividend accumulator rules (pure). Modelled in `verification/smt/models.py`; the solvency invariant
//! (holders can never claim more than settlement set aside, across any sequence of runs, claims, transfers
//! and auction fills) is proved by induction in `verification/smt/prove_money.py`.
//!
//! Rounding always favours the contract: accrual rounds down, and the debt set after a share-count change
//! rounds up. At most one payment-token unit per holder per share movement stays in the contract.

use crate::settlement::ACC_SCALE;

/// What a holding has accrued in total at `acc` (rounded down).
pub fn accrued(shares: u128, acc: u128) -> u128 {
    shares.checked_mul(acc).expect("dividend overflow: lifetime revenue bound exceeded") / ACC_SCALE
}

/// Claimable now; never negative.
pub fn pending(shares: u128, debt: u128, acc: u128) -> u128 {
    accrued(shares, acc).saturating_sub(debt)
}

/// Claim: returns (paid, new_debt). The debt only ever rises.
pub fn harvest(shares: u128, debt: u128, acc: u128) -> (u128, u128) {
    let a = accrued(shares, acc);
    (a.saturating_sub(debt), a.max(debt))
}

/// Debt after the share count changes (call `harvest` first). Rounded up.
pub fn rebase(shares: u128, acc: u128) -> u128 {
    let x = shares.checked_mul(acc).expect("dividend overflow: lifetime revenue bound exceeded");
    x / ACC_SCALE + u128::from(!x.is_multiple_of(ACC_SCALE))
}
