"""
Reference models of the contract's money logic, written once and run two ways:
symbolically (Z3, for proofs) and on Python integers (to generate conformance vectors that the Rust contract
and the TypeScript mirror must reproduce exactly).

Each function mirrors a Rust function line by line; the Rust source is named in each docstring.
"""
from __future__ import annotations

from common import BPS, U128, Ctx


def settlement(c: Ctx, price, bps, runner, fees, rbps):
    """contracts/fungible-recipes/src/settlement.rs :: settlement_split (contract v5)

    Returns the split and `ok`, the condition under which Rust returns Some: both bps values are at most 10000,
    the fixed fees fit in the price, and every checked operation stays below 2^128.
    The reserve is the creator's own money, added to the recipe's guarantee deposit (bond_available).
    """
    protocol = c.div(price * bps, BPS)
    part_sum = sum(fees) if fees else 0
    rem = price - protocol - runner - part_sum
    reserve = c.div(rem * rbps, BPS)
    creator = rem - reserve
    conds = [bps <= BPS, rbps <= BPS, price * bps < U128, part_sum < U128, rem >= 0, rem * rbps < U128]
    return dict(protocol=protocol, runner=runner, parts=list(fees), remainder=rem, reserve=reserve, creator=creator,
                conds=conds)


# ---- bonds (contracts/fungible-recipes/src/bond.rs) ----

def bond_lock(c: Ctx, available, locked, cover):
    """bond::lock — Some iff available >= cover."""
    return dict(ok=available >= cover, available=available - cover, locked=locked + cover)


def bond_release(c: Ctx, available, locked, covered):
    """bond::release — run refunded (fail, abort, timeout): the whole cover goes back."""
    return dict(ok=locked >= covered, available=available + covered, locked=locked - covered)


def bond_settle(c: Ctx, available, locked, covered, promised, delivered):
    """bond::settle — run settled ok: shortfall paid from the cover, the rest goes back."""
    shortfall = c.max(promised - delivered, 0)
    compensation = c.min(shortfall, covered)
    return dict(ok=locked >= covered, compensation=compensation, available=available + covered - compensation,
                locked=locked - covered)


def bond_withdraw(c: Ctx, available, locked, amount):
    """bond::withdraw — creator takes back unlocked bond."""
    return dict(ok=(amount > 0) if not c.symbolic else amount > 0, ok2=amount <= available,
                available=available - amount, locked=locked)


def bond_deposit(c: Ctx, available, locked, amount):
    """bond::deposit — a top-up (ft_transfer_call {"action":"bond"}) or a settlement's reserve."""
    return dict(ok=available + amount < U128, available=available + amount, locked=locked)


# ---- market-driven pricing (contracts/fungible-recipes/src/pricing.rs, contract v6) ----

MAX_PRICE = 10**30
MAX_TARGET_RUNS = 1_000_000


def next_price(c: Ctx, price, runs, target, floor, ceiling):
    """pricing::next_price — one period of the EIP-1559-style rule, clamped to [floor, ceiling].

    `ok` is the condition under which Rust returns Some: the band and target are in range and no checked
    operation overflows. `used = min(runs, 2*target)`.
    """
    used = c.min(runs, 2 * target)
    if c.symbolic:
        import z3
        # both branches are built symbolically, so each numerator is clamped at 0: a division whose
        # numerator could be negative would make the hypotheses unsatisfiable outside its own branch
        up = c.div(price * c.max(used - target, 0), 8 * target)
        down = c.div(price * c.max(target - used, 0), 8 * target)
        raw = z3.If(used >= target, price + up, price - down)
        p = z3.If(raw < floor, floor, z3.If(raw > ceiling, ceiling, raw))
        conds = [target >= 1, target <= MAX_TARGET_RUNS, floor <= ceiling, ceiling <= MAX_PRICE, price <= MAX_PRICE,
                 z3.If(used >= target, price * (used - target), price * (target - used)) < U128,
                 z3.If(used >= target, price + up, 0) < U128]
        return dict(price=p, raw=raw, used=used, conds=conds)
    ok = 1 <= target <= MAX_TARGET_RUNS and floor <= ceiling <= MAX_PRICE and price <= MAX_PRICE
    if not ok:
        return dict(price=None, conds=[False])
    if used >= target:
        prod = price * (used - target)
        raw = price + prod // (8 * target)
    else:
        prod = price * (target - used)
        raw = price - prod // (8 * target)
    if prod >= U128 or raw >= U128:
        return dict(price=None, conds=[False])
    return dict(price=min(max(raw, floor), ceiling), conds=[True])
