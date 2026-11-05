"""
Machine-checked proofs (Z3) for the contract's money logic (contract v5): settlement and guarantee deposits (bonds).

Every theorem is "for all inputs satisfying the hypotheses, the claim holds", checked by asking Z3 for a
counterexample and getting `unsat`. Inputs range over all u128 values unless a hypothesis narrows them, and
every hypothesis is either a check the contract enforces (named in the statement) or stated as a precondition.

v5 removed revenue shares, dividends and share trading (no investment features). The dividend and auction
proofs, and the two insolvency bugs they found in the earlier rules, are archived with that design in
archive/revenue-shares-2026-11-04/ (git tag archive/revenue-shares).
"""
from __future__ import annotations

import z3

from common import BPS, U128, Ctx, Report, Theorem, u128
from models import MAX_PRICE, MAX_TARGET_RUNS, bond_deposit, bond_lock, bond_release, bond_settle, next_price, settlement


def settlement_inputs(n_parts: int, cs: list):
    price = u128("price", cs)
    bps = z3.Int("bps"); cs += [bps >= 0, bps <= 1000]          # MAX_PROTOCOL_FEE_BPS, enforced in new()
    rbps = z3.Int("rbps"); cs += [rbps >= 0, rbps <= BPS]       # publish_recipe: reserve_bps <= 10000
    runner = u128("runner", cs)
    fees = [u128(f"fee{i}", cs) for i in range(n_parts)]
    return price, bps, rbps, runner, fees


def prove_settlement(R: Report):
    for n in range(0, 9):
        cs: list = []
        price, bps, rbps, runner, fees = settlement_inputs(n, cs)
        c = Ctx(True)
        s = settlement(c, price, bps, runner, fees, rbps)
        hyp = cs + s["conds"]
        m = f"settlement[{n}p]"
        R.check(Theorem(m, "conservation", "protocol + runner + parts + creator + reserve == price, to the unit"),
                hyp, s["protocol"] + runner + sum(fees, 0) + s["creator"] + s["reserve"] == price, ctx=c)
        R.check(Theorem(m, "no-negative-payout", "every payout and the reserve are >= 0"),
                hyp, z3.And(s["protocol"] >= 0, s["creator"] >= 0, s["reserve"] >= 0, s["remainder"] >= 0), ctx=c)
        R.check(Theorem(m, "creator-keeps-remainder", "creator + reserve == remainder: the reserve is the creator's money, nobody else's"),
                hyp, s["creator"] + s["reserve"] == s["remainder"], ctx=c)
        R.check(Theorem(m, "caps", "protocol fee <= 10% of price; reserve <= remainder, and reserve == 0 when reserve_bps == 0"),
                hyp, z3.And(s["protocol"] * 10 <= price, s["reserve"] <= s["remainder"], z3.Implies(rbps == 0, s["reserve"] == 0)), ctx=c)
        if n in (0, 3, 8):
            # no spurious failure: if the fees fit and the price is below 2^128/10^4, settlement returns Some
            c2 = Ctx(True)
            s2 = settlement(c2, price, bps, runner, fees, rbps)
            rem_ok = price - c2.div(price * bps, BPS) - runner - sum(fees, 0) >= 0
            R.check(Theorem(m, "never-fails-when-fees-fit",
                            "fees <= price (publish minimum) and price < 2^128/10^4 => no overflow, Some(split)"),
                    cs + [rem_ok, price * BPS < U128, sum(fees, 0) < U128], z3.And(*s2["conds"]), ctx=c2)


def prove_partial_billing(R: Report):
    """Durable runs in checkpoint mode (contract v4+): parts are paid at checkpoints, the final receipt pays the rest."""
    for n in (1, 3, 5):
        cs: list = []
        price, bps, rbps, runner, fees = settlement_inputs(n, cs)
        flags = [z3.Bool(f"billed{i}") for i in range(n)]
        c = Ctx(True)
        s = settlement(c, price, bps, runner, fees, rbps)
        billed = sum((z3.If(b, f, 0) for b, f in zip(flags, fees)), z3.IntVal(0))
        final_parts = sum((z3.If(b, 0, f) for b, f in zip(flags, fees)), z3.IntVal(0))
        m = f"billing[{n}p]"
        R.check(Theorem(m, "conservation-with-checkpoints", "billed at checkpoints + final payouts + reserve == price"),
                cs + s["conds"], billed + s["protocol"] + runner + final_parts + s["creator"] + s["reserve"] == price, ctx=c)
        # publish guarantees price >= protocol + runner + all part fees, so a refund after billing is never negative
        c2 = Ctx(True)
        prot = c2.div(price * bps, BPS)
        R.check(Theorem(m, "refund-never-negative", "a failed/timed-out run refunds price - billed >= 0 (publish minimum price)"),
                cs + [price - prot - runner - sum(fees, 0) >= 0], price - billed >= 0, ctx=c2)


def prove_bonds(R: Report):
    cs: list = []
    av, lk, cover, covered = u128("available", cs), u128("locked", cs), u128("cover", cs), u128("covered", cs)
    promised, delivered = u128("promised", cs), u128("delivered", cs)
    c = Ctx(True)
    L = bond_lock(c, av, lk, cover)
    R.check(Theorem("bonds", "lock-conserves", "lock moves exactly `cover` from available to locked, never below 0"),
            cs + [L["ok"]], z3.And(L["available"] >= 0, L["available"] + L["locked"] == av + lk, L["locked"] == lk + cover), ctx=c)
    S = bond_settle(c, av, lk, covered, promised, delivered)
    hyp = cs + [S["ok"], covered <= promised]  # contract: `cover exceeds promise` is rejected
    R.check(Theorem("bonds", "settle-conserves", "available + locked + compensation is unchanged by settlement"),
            hyp, S["available"] + S["locked"] + S["compensation"] == av + lk, ctx=c)
    R.check(Theorem("bonds", "compensation-capped", "compensation <= cover and <= max(0, promised - delivered)"),
            hyp, z3.And(S["compensation"] >= 0, S["compensation"] <= covered,
                        z3.Or(delivered >= promised, S["compensation"] <= promised - delivered),
                        z3.Implies(delivered >= promised, S["compensation"] == 0)), ctx=c)
    R.check(Theorem("bonds", "compensation-exact", "compensation == min(shortfall, cover): a covered shortfall is paid in full"),
            hyp, z3.Implies(promised - delivered <= covered, S["compensation"] == z3.If(promised > delivered, promised - delivered, 0)), ctx=c)
    R.check(Theorem("bonds", "settle-no-underflow", "settlement never underflows available or locked"),
            hyp, z3.And(S["available"] >= 0, S["locked"] >= 0, S["available"] < 2 * U128), ctx=c)
    D = bond_deposit(c, av, lk, cover)
    R.check(Theorem("bonds", "deposit-adds", "a top-up or a settlement reserve only adds to available; locked cover is untouched"),
            cs + [D["ok"]], z3.And(D["available"] == av + cover, D["locked"] == lk, D["available"] < U128), ctx=c)
    Rl = bond_release(c, av, lk, covered)
    R.check(Theorem("bonds", "refund-returns-cover", "fail/abort/timeout returns the whole cover; the buyer gets nothing from the bond"),
            cs + [Rl["ok"]], z3.And(Rl["available"] + Rl["locked"] == av + lk, Rl["locked"] >= 0, Rl["available"] == av + covered), ctx=c)

    # Inductive ledger invariant over unbounded histories, with three pending runs tracked explicitly and all
    # other pending runs aggregated: locked == sum of pending covers, and every token deposited is accounted for.
    cs = []
    av, lk, dep, wd, comp = (u128(n, cs) for n in ("available", "locked", "deposited", "withdrawn", "compensated"))
    c1, c2, c3, crest = (u128(n, cs) for n in ("cover1", "cover2", "cover3", "cover_rest"))
    inv = [lk == c1 + c2 + c3 + crest, dep == av + lk + wd + comp]
    x = u128("x", cs)
    pr, dl = u128("promised", cs), u128("delivered", cs)
    c = Ctx(True)
    steps = {
        "deposit": ([], dict(av=av + x, lk=lk, dep=dep + x, wd=wd, comp=comp, c1=c1)),
        "withdraw": ([x <= av], dict(av=av - x, lk=lk, dep=dep, wd=wd + x, comp=comp, c1=c1)),
        "lock(new run)": ([x <= av, c1 == 0], dict(av=av - x, lk=lk + x, dep=dep, wd=wd, comp=comp, c1=x)),
        "refund(run1)": ([], dict(av=av + c1, lk=lk - c1, dep=dep, wd=wd, comp=comp, c1=0)),
    }
    S = bond_settle(c, av, lk, c1, pr, dl)
    steps["settle(run1)"] = ([c1 <= pr], dict(av=S["available"], lk=S["locked"], dep=dep, wd=wd, comp=comp + S["compensation"], c1=0))
    # v5: the same settlement also adds the creator's reserve to the deposit (counted as deposited)
    rs = u128("reserve", cs)
    D = bond_deposit(c, S["available"], S["locked"], rs)
    steps["settle(run1)+reserve"] = ([c1 <= pr], dict(av=D["available"], lk=D["locked"], dep=dep + rs, wd=wd, comp=comp + S["compensation"], c1=0))
    for name, (pre, n) in steps.items():
        post = z3.And(n["lk"] == n["c1"] + c2 + c3 + crest, n["dep"] == n["av"] + n["lk"] + n["wd"] + n["comp"],
                      n["av"] >= 0, n["lk"] >= 0)
        R.check(Theorem("bonds", f"invariant-preserved: {name}",
                        "locked == sum(pending covers) and deposited == available+locked+withdrawn+compensated"),
                cs + inv + pre, post, ctx=c)


def prove_pricing(R: Report):
    """Market-driven list prices (contract v6): the demand rule stays in the band, moves at most 12.5% a period,
    moves the right way, never overflows, and every price in the band settles (the floor is viable)."""
    def inputs(cs):
        price, floor, ceiling = u128("price", cs), u128("floor", cs), u128("ceiling", cs)
        runs = z3.Int("runs"); cs += [runs >= 0, runs < 2**64]
        t = z3.Int("target"); cs += [t >= 1, t <= MAX_TARGET_RUNS]
        cs += [floor <= ceiling, ceiling <= MAX_PRICE]
        return price, runs, t, floor, ceiling
    m = "pricing"
    cs: list = []
    price, runs, t, floor, ceiling = inputs(cs)
    c = Ctx(True)
    s = next_price(c, price, runs, t, floor, ceiling)
    band = [floor <= price, price <= ceiling]
    R.check(Theorem(m, "never-overflows", "with ceiling <= 1e30 and target <= 1e6 every checked operation fits in u128"),
            cs + [price <= MAX_PRICE], z3.And(*s["conds"]), ctx=c)
    R.check(Theorem(m, "stays-in-band", "floor <= next price <= ceiling, from any starting price"),
            cs + s["conds"], z3.And(floor <= s["price"], s["price"] <= ceiling), ctx=c)
    R.check(Theorem(m, "step-at-most-12.5%", "from a price in the band, one period moves it by at most 1/8 either way"),
            cs + s["conds"] + band, z3.And(8 * s["price"] <= 9 * price, 8 * s["price"] >= 7 * price), ctx=c)
    # both branches must be reachable under the hypotheses, or the claims above would hold only at runs == target
    R.check(Theorem(m, "branch-reachable: rising", "witness exists with runs > target (expected counterexample to 'runs <= target')",
                    expect="counterexample"), cs + s["conds"] + band, runs <= t, ctx=c)
    R.check(Theorem(m, "branch-reachable: falling", "witness exists with runs < target (expected counterexample to 'runs >= target')",
                    expect="counterexample"), cs + s["conds"] + band, runs >= t, ctx=c)
    R.check(Theorem(m, "demand-direction", "runs >= target never lowers the price; runs <= target never raises it"),
            cs + s["conds"] + band, z3.And(z3.Implies(runs >= t, s["price"] >= price), z3.Implies(runs <= t, s["price"] <= price)), ctx=c)
    cs2: list = []
    price, runs, t, floor, ceiling = inputs(cs2)
    runs2 = z3.Int("runs2"); cs2 += [runs2 >= runs, runs2 < 2**64]
    c = Ctx(True)
    a = next_price(c, price, runs, t, floor, ceiling)
    b = next_price(c, price, runs2, t, floor, ceiling)
    R.check(Theorem(m, "monotone-in-demand", "more paid runs in a period never give a lower next price"),
            cs2 + a["conds"] + b["conds"], a["price"] <= b["price"], ctx=c)
    # viability: publish/set_pricing require floor >= protocol(floor) + fees; then every price >= floor settles
    cs3: list = []
    P, fl, fees = u128("P", cs3), u128("floor", cs3), u128("fees", cs3)
    bps = z3.Int("bps"); cs3 += [bps >= 0, bps <= 1000]
    c = Ctx(True)
    hyp = cs3 + [fl - c.div(fl * bps, BPS) - fees >= 0, P >= fl, P * bps < U128, fl * bps < U128]
    R.check(Theorem(m, "every-band-price-is-viable", "floor covers its fees => any price >= floor covers protocol + runner + parts"),
            hyp, P - c.div(P * bps, BPS) - fees >= 0, ctx=c)


def main():
    R = Report()
    print("settlement"); prove_settlement(R)
    print("partial billing"); prove_partial_billing(R)
    print("bonds"); prove_bonds(R)
    print("pricing"); prove_pricing(R)
    return R


if __name__ == "__main__":
    import sys
    sys.exit(main().finish())
