"""
Ties the proved models to the real code.

Writes test vectors computed *by the models the proofs are about* (verification/smt/models.py). The Rust contract
tests and the TypeScript mirror tests must reproduce every vector exactly, so a proof can't silently drift away
from the code it describes.

  contracts/test-vectors/conformance-money.json    settlement v5 (incl. overflow and bad bps -> None), bonds

Deterministic (fixed seed): re-running it must leave the file unchanged (`npm run verify` checks this).
The v4 auction, dividend and solvency vectors are archived in archive/revenue-shares-2026-11-04/.
"""
from __future__ import annotations

import json
import random
import sys
from pathlib import Path

from common import BPS, U128, Ctx
from models import bond_deposit, bond_lock, bond_release, bond_settle, settlement

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "contracts" / "test-vectors"
rnd = random.Random(20261104)
C = Ctx(False)


def pick(scale: str) -> int:
    return {
        "small": rnd.randint(0, 2_000_000),
        "mid": rnd.randint(0, 10**15),
        "big": rnd.randint(0, U128 - 1),
        "edge": rnd.choice([0, 1, 2, 9_999, 10_000, 10_001, U128 // 10_000, U128 // 10_000 + 1, U128 - 1]),
    }[scale]


def money_vectors():
    st = []
    for k in range(400):
        scale = rnd.choice(["small", "small", "mid", "big", "edge"])
        price = pick(scale)
        n = rnd.randint(0, 5)
        fees = [rnd.randint(0, max(1, price // 8)) for _ in range(n)]
        runner = rnd.randint(0, max(1, price // 6))
        bps = rnd.choice([rnd.randint(0, 1000), 0, 200])
        rbps = rnd.choice([0, 1000, 10_000, rnd.randint(0, 10_000), 10_001])  # 10_001: Rust returns None
        s = settlement(C, price, bps, runner, fees, rbps)
        ok = all(s["conds"])
        exp = None if not ok else {k2: str(s[k2]) for k2 in ("protocol", "remainder", "reserve", "creator")}
        st.append({"input": {"price": str(price), "protocol_fee_bps": bps, "runner_fee": str(runner),
                             "part_fees": [str(f) for f in fees], "reserve_bps": rbps}, "expected": exp})
    bonds = []
    for k in range(200):
        av, lk = pick(rnd.choice(["small", "mid", "edge"])), pick(rnd.choice(["small", "mid", "edge"]))
        op = rnd.choice(["lock", "release", "settle", "deposit"])
        x = rnd.choice([0, rnd.randint(0, av + lk + 5), lk, av])
        if op == "lock":
            r = bond_lock(C, av, lk, x); exp = {"available": str(r["available"]), "locked": str(r["locked"])} if r["ok"] and r["locked"] < U128 else None
            bonds.append({"op": op, "available": str(av), "locked": str(lk), "amount": str(x), "expected": exp})
        elif op == "deposit":
            x = rnd.choice([x, U128 - 1 - av, U128 - av])
            r = bond_deposit(C, av, lk, x); exp = {"available": str(r["available"]), "locked": str(r["locked"])} if r["ok"] else None
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
    return {"source": "verification/smt/models.py (the models proved in prove_money.py)", "settlement": st, "bonds": bonds}


def main():
    files = {"conformance-money.json": money_vectors()}
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
