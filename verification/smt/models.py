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
