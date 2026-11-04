"""
Ties the proved models to the real code.

Writes test vectors computed *by the models the proofs are about* (verification/smt/models.py for money,
the Z3 encoding in prove_auction.py for the auction). The Rust contract tests and the TypeScript mirror tests
must reproduce every vector exactly, so a proof can't silently drift away from the code it describes.

  contracts/test-vectors/conformance-money.json    settlement (incl. overflow -> None), bonds, dividends
  contracts/test-vectors/conformance-auction.json  random books, cleared by solving the Z3 encoding
  contracts/test-vectors/solvency.json             the two insolvency scenarios the proofs found, with the
                                                   balances the fixed rules must produce

Deterministic (fixed seed): re-running it must leave the files unchanged (`npm run verify` checks this).
"""
from __future__ import annotations

import json
import random
import sys
from pathlib import Path

import z3

from common import E, U128, Ctx
from models import bond_lock, bond_release, bond_settle, harvest, pending_of, rebase, settlement
from prove_auction import book, clear

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "contracts" / "test-vectors"
rnd = random.Random(20261104)
C = Ctx(False)


def pick(scale: str) -> int:
    return {
        "small": rnd.randint(0, 2_000_000),
        "mid": rnd.randint(0, 10**15),
        "big": rnd.randint(0, U128 - 1),
        "edge": rnd.choice([0, 1, 2, E - 1, E, E + 1, U128 // E, U128 // 10_000, U128 - 1]),
    }[scale]


def money_vectors():
    st = []
    for k in range(400):
        scale = rnd.choice(["small", "small", "mid", "big", "edge"])
        price = pick(scale)
        n = rnd.randint(0, 5)
        fees = [rnd.randint(0, max(1, price // 8)) for _ in range(n)]
        runner = rnd.randint(0, max(1, price // 6))
        bps, roy = rnd.randint(0, 1000), rnd.randint(0, 5000)
        ts = rnd.choice([1, 3, 7, 1000, 1_000_000, 10**18, rnd.randint(1, 10**24), U128 - 1])
        acc0 = rnd.choice([0, 0, rnd.randint(0, 10**30), rnd.randint(0, U128 - 1)])
        s = settlement(C, price, bps, runner, fees, roy, ts, acc0)
        ok = all(s["conds"])
        exp = None if not ok else {k2: str(s[k2]) for k2 in ("protocol", "remainder", "creator", "pool", "acc_increment",
                                                              "distributed", "dust")}
        st.append({"input": {"price": str(price), "protocol_fee_bps": bps, "runner_fee": str(runner),
                             "part_fees": [str(f) for f in fees], "royalty_bps": roy, "total_shares": str(ts),
                             "acc_before": str(acc0)}, "expected": exp})
    bonds = []
    for k in range(200):
        av, lk = pick(rnd.choice(["small", "mid", "edge"])), pick(rnd.choice(["small", "mid", "edge"]))
        op = rnd.choice(["lock", "release", "settle"])
        x = rnd.choice([0, rnd.randint(0, av + lk + 5), lk, av])
        if op == "lock":
            r = bond_lock(C, av, lk, x); exp = {"available": str(r["available"]), "locked": str(r["locked"])} if r["ok"] and r["locked"] < U128 else None
            bonds.append({"op": op, "available": str(av), "locked": str(lk), "amount": str(x), "expected": exp})
        elif op == "release":
            r = bond_release(C, av, lk, x); exp = {"available": str(r["available"]), "locked": str(r["locked"])} if r["ok"] and r["available"] < U128 else None
            bonds.append({"op": op, "available": str(av), "locked": str(lk), "amount": str(x), "expected": exp})
        else:
            pr = pick(rnd.choice(["small", "mid"])); dl = rnd.choice([0, pr, rnd.randint(0, 2 * pr + 1)])
            r = bond_settle(C, av, lk, x, pr, dl)
            exp = ({"available": str(r["available"]), "locked": str(r["locked"]), "compensation": str(r["compensation"])}
                   if r["ok"] and r["available"] < U128 else None)
            bonds.append({"op": op, "available": str(av), "locked": str(lk), "amount": str(x), "promised": str(pr),
                          "delivered": str(dl), "expected": exp})
    divs = []
    for k in range(200):
        shares = rnd.choice([0, 1, 3, 250, 10**6, rnd.randint(0, 10**12)])
        acc = rnd.choice([0, E - 1, E, rnd.randint(0, 10**24), rnd.randint(0, 10**30)])
        if shares * acc >= U128:
            continue  # unreachable: shares*acc <= TS*acc <= lifetime_pool*E < 2^128 (lifetime-invariant-step)
        debt = rnd.choice([0, rnd.randint(0, 10**12), shares * acc // E, shares * acc // E + 1])
        h = harvest(C, shares, debt, acc)
        divs.append({"shares": str(shares), "acc": str(acc), "debt": str(debt), "expected": {
            "pending": str(pending_of(C, shares, debt, acc)), "harvest_paid": str(h["pending"]), "harvest_debt": str(h["debt"]),
            "rebase": str(rebase(C, shares, acc))}})
    return {"source": "verification/smt/models.py (the models proved in prove_money.py)", "settlement": st, "bonds": bonds,
            "dividends": divs}


def auction_vectors():
    cases = []
    for k in range(60):
        n = rnd.randint(2, 7)
        cs: list = []
        c = Ctx(True)
        orders = book(n, cs)
        r = clear(c, orders, cs)
        s = z3.Solver()
        s.add(cs + c.cs)
        concrete = []
        mid = rnd.randint(95, 105)
        for i, b, p, q in orders:
            side = rnd.random() < 0.5
            price = rnd.randint(mid - 6, mid + 6) * 1000
            qty = rnd.choice([1, 2, 5, 10, rnd.randint(1, 40)])
            s.add(b == side, p == price, q == qty)
            concrete.append({"id": i + 1, "side": "bid" if side else "ask", "price": str(price), "qty": str(qty)})
        assert s.check() == z3.sat, "the auction encoding must have a solution for every concrete book"
        m = s.model()
        V = m.eval(r["V"]).as_long()
        fills = [m.eval(f, model_completion=True).as_long() for f in r["fills"]]
        # the encoding determines the result uniquely: no other solution may exist
        s.add(z3.Or(r["V"] != V, *[f != v for f, v in zip(r["fills"], fills)], r["P"] != m.eval(r["P"])))
        assert s.check() == z3.unsat, "the auction encoding must determine a unique clearing"
        cases.append({"orders": concrete, "expected": {
            "price": None if V == 0 else str(m.eval(r["P"]).as_long()), "volume": str(V),
            "fills": {str(o["id"]): str(f) for o, f in zip(concrete, fills) if f > 0}}})
    return {"source": "verification/smt/prove_auction.py :: clear (solved by Z3 for each concrete book)", "cases": cases}


def solvency_vectors():
    """Concrete scenarios derived from the counterexamples Z3 produced for the previous rules."""
    def sim(ts, price, steps):
        acc, prot, paid_in = 0, 0, 0
        H = {"creator": [ts, 0, 0]}  # shares, debt, balance
        for st in steps:
            if st["op"] == "run":
                s = settlement(C, price, 0, 0, [], 0, ts, acc)
                acc = s["acc_after"]; prot += s["dust"]; paid_in += price
            else:
                a, b, q = st["from"], st["to"], int(st["qty"])
                H.setdefault(b, [0, 0, 0])
                for who in (a, b):
                    h = harvest(C, H[who][0], H[who][1], acc); H[who][2] += h["pending"]; H[who][1] = h["debt"]
                H[a][0] -= q; H[b][0] += q
                for who in (a, b):
                    H[who][1] = rebase(C, H[who][0], acc)
        holders = {w: str(v[2] + pending_of(C, v[0], v[1], acc)) for w, v in H.items()}
        total = sum(int(x) for x in holders.values()) + prot
        assert total <= paid_in, "fixed rules must be solvent"
        return {"expected_holders": holders, "expected_protocol": str(prot), "paid_in": str(paid_in)}

    cases = []
    for name, ts, price, steps, why in [
        ("two-runs-rounding", 3, 1, [{"op": "run"}, {"op": "run"}],
         "Z3 counterexample (ts=3): per-run rounding sent 2 units to the protocol while the holder could claim 1, from 2 paid in"),
        ("transfer-rebase-rounding", 2, 1, [{"op": "run"}, {"op": "transfer_shares", "from": "creator", "to": "alice", "qty": "1"}, {"op": "run"}],
         "rounding the debt down on a transfer let two holders claim 3 units from 2 paid in"),
    ]:
        cases.append({"name": name, "why": why, "recipe": {"total_shares": str(ts), "price": str(price)}, "steps": steps, **sim(ts, price, steps)})
    return {"source": "verification/smt (counterexamples to the previous rules)", "cases": cases}


def main():
    files = {"conformance-money.json": money_vectors(), "conformance-auction.json": auction_vectors(), "solvency.json": solvency_vectors()}
    check = "--check" in sys.argv
    stale = []
    for name, data in files.items():
        text = json.dumps(data, indent=1) + "\n"
        p = OUT / name
        if check:
            if not p.exists() or p.read_text() != text:
                stale.append(name)
        else:
            p.write_text(text)
            print(f"wrote {p.relative_to(ROOT)}")
    if stale:
        print("stale vectors (re-run gen_conformance.py): " + ", ".join(stale)); return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
