//! Bond accounting (pure). Every function here is modelled line by line in
//! `verification/smt/models.py` and proved in `verification/smt/prove_money.py`:
//! cover is never overdrawn, `available + locked + compensated + withdrawn == deposited` across any history,
//! compensation is `min(max(0, promised - delivered), cover)`. Conformance vectors:
//! `contracts/test-vectors/conformance-money.json`.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bond {
    pub available: u128,
    pub locked: u128,
}

/// A quoted run is paid: move `cover` from available to locked. `None` if the bond can't cover it.
pub fn lock(b: Bond, cover: u128) -> Option<Bond> {
    Some(Bond { available: b.available.checked_sub(cover)?, locked: b.locked.checked_add(cover)? })
}

/// A run is refunded (fail, abort or timeout): the whole cover goes back to available.
pub fn release(b: Bond, covered: u128) -> Option<Bond> {
    Some(Bond { available: b.available.checked_add(covered)?, locked: b.locked.checked_sub(covered)? })
}

/// A run settles ok: the shortfall against the promise is paid from the cover, the rest goes back.
/// Returns the new bond and the compensation owed to the buyer.
pub fn settle(b: Bond, covered: u128, promised: u128, delivered: u128) -> Option<(Bond, u128)> {
    let compensation = promised.saturating_sub(delivered).min(covered);
    let locked = b.locked.checked_sub(covered)?;
    let available = b.available.checked_add(covered - compensation)?;
    Some((Bond { available, locked }, compensation))
}

/// The creator takes back unlocked bond.
pub fn withdraw(b: Bond, amount: u128) -> Option<Bond> {
    Some(Bond { available: b.available.checked_sub(amount)?, locked: b.locked })
}

/// The creator adds to the bond.
pub fn deposit(b: Bond, amount: u128) -> Option<Bond> {
    Some(Bond { available: b.available.checked_add(amount)?, locked: b.locked })
}
