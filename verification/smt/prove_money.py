"""
Machine-checked proofs (Z3) for the contract's money logic: settlement, bonds and dividends.

Every theorem is "for all inputs satisfying the hypotheses, the claim holds", checked by asking Z3 for a
counterexample and getting `unsat`. Inputs range over all u128 values unless a hypothesis narrows them, and
every hypothesis is either a check the contract enforces (named in the statement) or stated as a precondition.

Two theorems are expected to produce counterexamples: they run the *previous* rules, which this verification
pass found to be unsound, and they stay here as regression evidence.
"""
from __future__ import annotations

import z3

from common import BPS, E, U128, Ctx, Report, Theorem, u128
from models import (bond_lock, bond_release, bond_settle, harvest, harvest_v1, rebase, rebase_v1, settlement,
                    settlement_v1)

# Lifetime bound under which no checked multiplication can overflow (proved below): total revenue a single
# recipe ever settles must stay at or below this many payment-token units (USDC: ~3.4e14 dollars).
LIFETIME = (U128 - 1) // E


def settlement_inputs(n_parts: int, cs: list):
    price = u128("price", cs)
    bps = z3.Int("bps"); cs += [bps >= 0, bps <= 1000]          # MAX_PROTOCOL_FEE_BPS, enforced in new()
    roy = z3.Int("roy"); cs += [roy >= 0, roy <= 5000]          # MAX_ROYALTY_BPS, enforced in publish_recipe
    runner = u128("runner", cs)
    fees = [u128(f"fee{i}", cs) for i in range(n_parts)]
    ts = u128("ts", cs); cs += [ts > 0]                          # publish_recipe requires total_shares > 0
    acc0 = u128("acc0", cs)
    return price, bps, roy, runner, fees, ts, acc0


def prove_settlement(R: Report):
    for n in range(0, 9):
        cs: list = []
        price, bps, roy, runner, fees, ts, acc0 = settlement_inputs(n, cs)
        c = Ctx(True)
        s = settlement(c, price, bps, runner, fees, roy, ts, acc0)
        hyp = cs + s["conds"]
        m = f"settlement[{n}p]"
        R.check(Theorem(m, "conservation", "protocol+dust + runner + parts + creator + shareholders == price"),
                hyp, s["protocol_total"] + runner + sum(fees, 0) + s["creator"] + s["distributed"] == price, ctx=c)
        R.check(Theorem(m, "no-negative-payout", "every payout >= 0 and shareholders' share <= pool"),
                hyp, z3.And(s["protocol"] >= 0, s["creator"] >= 0, s["distributed"] >= 0, s["dust"] >= 0,
                            s["distributed"] <= s["pool"]), ctx=c)
        R.check(Theorem(m, "fee-caps", "protocol fee <= 10% of price, royalty <= 50% of remainder"),
                hyp, z3.And(s["protocol"] * 10 <= price, s["creator"] * 2 <= s["remainder"]), ctx=c)
        R.check(Theorem(m, "rounding-bound", "rounding withheld from shareholders <= 1 + total_shares/1e18 units"),
                hyp, s["dust"] * E <= ts + E, ctx=c)
        if n in (0, 3, 8):
            # no spurious failure: if the fees fit and the recipe is under the lifetime bound, settlement succeeds
            P = u128("lifetime_pool_before", cs)
            inv = [acc0 * ts <= P * E, P + price <= LIFETIME]
            c2 = Ctx(True)
            s2 = settlement(c2, price, bps, runner, fees, roy, ts, acc0)
            rem_ok = price - c2.div(price * bps, BPS) - runner - sum(fees, 0) >= 0
            R.check(Theorem(m, "never-fails-when-fees-fit",
                            "fees <= price and lifetime revenue <= 3.4e20 units => no overflow, Some(split)"),
                    cs + inv + [rem_ok], z3.And(*s2["conds"]), ctx=c2)
            R.check(Theorem(m, "lifetime-invariant-step",
                            "acc*TS <= lifetime_pool*E is preserved by a settlement"),
                    cs + inv + s2["conds"], s2["acc_after"] * ts <= (P + s2["pool"]) * E, ctx=c2)


def prove_settlement_regression(R: Report):
    """Previous rule: shareholders' share computed per run as floor(inc*TS/E). Total set aside could fall below
    what holders can claim (floor(TS*acc/E)), so the contract could owe more than it holds."""
    cs: list = []
    ts = u128("ts", cs); cs += [ts > 0]
    p1, p2 = u128("pool1", cs), u128("pool2", cs)
    c = Ctx(True)
    a = settlement_v1(c, p1, 0, 0, [], 0, ts)
    b = settlement_v1(c, p2, 0, 0, [], 0, ts)
    acc = a["acc_increment"] + b["acc_increment"]
    claim_all = c.div(ts * acc, E)  # one holder owning every share
    R.check(Theorem("settlement", "v1-two-runs-solvent", "OLD rule: holders' claims <= amount set aside",
                    expect="counterexample"),
            cs + [p1 <= 10**6, p2 <= 10**6, ts <= 10**6], claim_all <= a["distributed"] + b["distributed"],
            show=[ts, p1, p2], ctx=c)
    c = Ctx(True)
    s1 = settlement(c, p1, 0, 0, [], 0, ts, 0)
    s2 = settlement(c, p2, 0, 0, [], 0, ts, s1["acc_after"])
    claim_all = c.div(ts * s2["acc_after"], E)
    R.check(Theorem("settlement", "telescoping-two-runs-solvent", "NEW rule: holders' claims == amount set aside"),
            cs + s1["conds"] + s2["conds"], claim_all == s1["distributed"] + s2["distributed"], ctx=c)


def prove_partial_billing(R: Report):
    """Durable runs in checkpoint mode (contract v4): parts are paid at checkpoints, the final receipt pays the rest."""
    for n in (1, 3, 5):
        cs: list = []
        price, bps, roy, runner, fees, ts, acc0 = settlement_inputs(n, cs)
        flags = [z3.Bool(f"billed{i}") for i in range(n)]
        c = Ctx(True)
        s = settlement(c, price, bps, runner, fees, roy, ts, acc0)
        billed = sum((z3.If(b, f, 0) for b, f in zip(flags, fees)), z3.IntVal(0))
        final_parts = sum((z3.If(b, 0, f) for b, f in zip(flags, fees)), z3.IntVal(0))
        m = f"billing[{n}p]"
        R.check(Theorem(m, "conservation-with-checkpoints", "billed at checkpoints + final payouts + shareholders == price"),
                cs + s["conds"], billed + s["protocol_total"] + runner + final_parts + s["creator"] + s["distributed"] == price, ctx=c)
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
    for name, (pre, n) in steps.items():
        post = z3.And(n["lk"] == n["c1"] + c2 + c3 + crest, n["dep"] == n["av"] + n["lk"] + n["wd"] + n["comp"],
                      n["av"] >= 0, n["lk"] >= 0)
        R.check(Theorem("bonds", f"invariant-preserved: {name}",
                        "locked == sum(pending covers) and deposited == available+locked+withdrawn+compensated"),
                cs + inv + pre, post, ctx=c)


def prove_dividends(R: Report):
    """Solvency of the dividend accumulator across arbitrary histories, by induction.

    K:  paid*E + sum_h max(0, shares_h*acc - debt_h*E)  <=  TS*acc
    K implies paid + sum_h pending_h <= floor(TS*acc/E) == total ever set aside (telescoping settlement).
    Two holders are explicit; all others are aggregated in `rest` (shares and their K-terms)."""
    for rules in ("new", "v1"):
        hv, rb = (harvest, rebase) if rules == "new" else (harvest_v1, rebase_v1)
        cs: list = []
        acc, paid = u128("acc", cs), u128("paid", cs)
        s1, s2, rs = u128("s1", cs), u128("s2", cs), u128("rest_shares", cs)
        d1, d2 = u128("debt1", cs), u128("debt2", cs)
        rt = z3.Int("rest_term"); cs += [rt >= 0, rt <= rs * acc]
        TS = s1 + s2 + rs
        cs += [TS > 0]
        term = lambda s, d, a: z3.If(s * a - d * E > 0, s * a - d * E, 0)
        K = lambda a, p, s1_, d1_, s2_, d2_, rt_: p * E + term(s1_, d1_, a) + term(s2_, d2_, a) + rt_ <= TS * a
        # reachable-state facts for the old rules (debts are floors) and the new rules (debts never exceed ceilings)
        c = Ctx(True)
        if rules == "new":
            cs += [d1 * E <= s1 * acc + E - 1, d2 * E <= s2 * acc + E - 1]  # debts never exceed the ceiling
        else:
            cs += [d1 * E <= s1 * acc, d2 * E <= s2 * acc]  # old rules: debts are floors
        inc, q, a2 = u128("inc", cs), u128("q", cs), u128("acc2", cs)  # declared before `hyp` copies cs
        hyp = cs + [K(acc, paid, s1, d1, s2, d2, rt)]
        label = "dividends" if rules == "new" else "dividends-v1"
        exp = "proved" if rules == "new" else "counterexample"
        # run: acc grows by inc; every other holder's term grows by at most shares*inc
        rt2 = z3.Int("rest_term2")
        R.check(Theorem(label, "K preserved by a paid run", "solvency invariant survives acc += inc"),
                hyp + [rt2 >= 0, rt2 <= rt + rs * inc], K(acc + inc, paid, s1, d1, s2, d2, rt2), ctx=c)
        # harvest holder 1
        h = hv(c, s1, d1, acc)
        R.check(Theorem(label, "K preserved by harvest", "solvency invariant survives a dividend claim"),
                hyp, K(acc, paid + h["pending"], s1, h["debt"], s2, d2, rt), ctx=c)
        # move q shares 1 -> 2 at the current acc: harvest both, then re-baseline both debts
        c = Ctx(True)
        h1, h2 = hv(c, s1, d1, acc), hv(c, s2, d2, acc)
        n1, n2 = s1 - q, s2 + q
        R.check(Theorem(label, "K preserved by share transfer/auction fill", "solvency invariant survives moving shares",
                        expect=exp),
                hyp + [q <= s1], K(acc, paid + h1["pending"] + h2["pending"], n1, rb(c, n1, acc), n2, rb(c, n2, acc), rt),
                show=[acc, s1, s2, d1, d2, q], ctx=c)
        if rules == "new":
            c = Ctx(True)
            p1, p2 = hv(c, s1, d1, acc)["pending"], hv(c, s2, d2, acc)["pending"]
            rp = z3.Int("rest_pending");
            R.check(Theorem(label, "K implies solvency", "paid + everything claimable <= floor(TS*acc/E) (amount set aside)"),
                    hyp + [rp >= 0, rp * E <= rt], paid + p1 + p2 + rp <= c.div(TS * acc, E), ctx=c)
            R.check(Theorem(label, "K holds at publish", "creator holds all shares, acc = 0, nothing paid"),
                    [s1 > 0], K(0, 0, s1, 0, 0, 0, 0), ctx=c)
            c = Ctx(True)
            R.check(Theorem(label, "claims never negative", "pending >= 0 whatever the debt (saturating)"),
                    cs, hv(c, s1, d1, a2)["pending"] >= 0, ctx=c)


def main():
    R = Report()
    print("settlement"); prove_settlement(R); prove_settlement_regression(R)
    print("partial billing"); prove_partial_billing(R)
    print("bonds"); prove_bonds(R)
    print("dividends"); prove_dividends(R)
    return R


if __name__ == "__main__":
    import sys
    sys.exit(main().finish())
