"""
Reference models of the contract's money logic, written once and run two ways:
symbolically (Z3, for proofs) and on Python integers (to generate conformance vectors that the Rust contract
and the TypeScript mirror must reproduce exactly).

Each function mirrors a Rust function line by line; the Rust source is named in each docstring.
"""
from __future__ import annotations

from common import BPS, E, U128, Ctx


def settlement(c: Ctx, price, bps, runner, fees, roy, ts, acc_before):
    """contracts/fungible-recipes/src/settlement.rs :: settlement_split

    Returns the split and `ok`, the condition under which Rust returns Some: the fixed fees fit in the price,
    `total_shares > 0`, and every checked multiplication stays below 2^128.
    The shareholders' share is `distributed = floor(acc_after*TS/E) - floor(acc_before*TS/E)`, so the total
    ever set aside telescopes to floor(acc*TS/E): exactly what holders can claim in total (see dividends).
    """
    protocol = c.div(price * bps, BPS)
    part_sum = sum(fees) if fees else 0
    rem = price - protocol - runner - part_sum
    creator = c.div(rem * roy, BPS)
    pool = rem - creator
    inc = c.div(pool * E, ts)
    acc_after = acc_before + inc
    distributed = c.div(acc_after * ts, E) - c.div(acc_before * ts, E)
    dust = pool - distributed
    conds = [ts > 0, rem >= 0, price * bps < U128, rem * roy < U128, pool * E < U128, acc_before * ts < U128, acc_after * ts < U128,
             part_sum < U128]
    return dict(protocol=protocol, protocol_total=protocol + dust, runner=runner, parts=list(fees), remainder=rem,
                creator=creator, pool=pool, acc_increment=inc, acc_after=acc_after, distributed=distributed,
                dust=dust, conds=conds)


def settlement_v1(c: Ctx, price, bps, runner, fees, roy, ts):
    """The previous settlement_split (before this verification pass): distributed = floor(inc*TS/E)."""
    protocol = c.div(price * bps, BPS)
    rem = price - protocol - runner - (sum(fees) if fees else 0)
    creator = c.div(rem * roy, BPS)
    pool = rem - creator
    inc = c.div(pool * E, ts)
    distributed = c.div(inc * ts, E)
    return dict(pool=pool, acc_increment=inc, distributed=distributed, dust=pool - distributed)


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


# ---- dividends (lib.rs :: harvest / move_shares / rebase, via src/dividends.rs) ----

def accrued(c: Ctx, shares, acc):
    return c.div(shares * acc, E)


def harvest(c: Ctx, shares, debt, acc):
    """dividends::harvest — pays what has accrued above the debt (never negative), raises the debt to it."""
    a = accrued(c, shares, acc)
    pending = c.max(a - debt, 0)
    return dict(pending=pending, debt=c.max(debt, a))


def rebase(c: Ctx, shares, acc):
    """dividends::rebase — debt after a share-count change, rounded UP so rounding never favours holders."""
    return c.ceil_div(shares * acc, E)


def harvest_v1(c: Ctx, shares, debt, acc):
    a = accrued(c, shares, acc)
    return dict(pending=a - debt, debt=a)


def rebase_v1(c: Ctx, shares, acc):
    return c.div(shares * acc, E)


def pending_of(c: Ctx, shares, debt, acc):
    """dividends::pending — the view: claimable now, never negative."""
    return c.max(accrued(c, shares, acc) - debt, 0)
