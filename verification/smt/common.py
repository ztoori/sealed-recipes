"""
Shared helpers for the SMT proofs (Z3).

Every value the contract stores as u128 is modelled as a mathematical integer constrained to [0, 2^128).
Integer division is modelled by its definition (q*b <= a < (q+1)*b), which is exactly Rust's `/` on
unsigned integers. Overflow is never silently wrapped: each theorem that depends on "no overflow" states the
product bounds explicitly, and separate theorems prove those bounds hold under the stated preconditions.

The same model functions run on plain Python integers, so they double as the executable reference that
`gen_conformance.py` uses to produce test vectors for the real Rust and TypeScript code.
"""
from __future__ import annotations

import json
import sys
import time
from dataclasses import dataclass, field
from typing import Callable

import z3

U128 = 2**128
E = 10**18  # ACC_SCALE
BPS = 10_000


_fresh = 0


def fresh(prefix: str) -> str:
    """Globally unique Z3 names: two contexts must never share a division variable."""
    global _fresh
    _fresh += 1
    return f"{prefix}!{_fresh}"


class Ctx:
    """Collects side constraints (division definitions) when the model runs symbolically."""

    def __init__(self, symbolic: bool):
        self.symbolic = symbolic
        self.cs: list = []

    def div(self, a, b):
        if not self.symbolic:
            return a // b
        q = z3.Int(fresh("div"))
        self.cs += [q >= 0, q * b <= a, a < (q + 1) * b]
        return q

    def ceil_div(self, a, b):
        if not self.symbolic:
            return -((-a) // b)
        q = z3.Int(fresh("ceil"))
        self.cs += [q >= 0, (q - 1) * b < a, a <= q * b]
        return q

    def min(self, a, b):
        return min(a, b) if not self.symbolic else z3.If(a <= b, a, b)

    def max(self, a, b):
        return max(a, b) if not self.symbolic else z3.If(a >= b, a, b)


def u128(name: str, cs: list):
    v = z3.Int(name)
    cs += [v >= 0, v < U128]
    return v


@dataclass
class Theorem:
    module: str
    name: str
    statement: str
    expect: str = "proved"  # or "counterexample" for a property the old code violates (kept as a regression)


@dataclass
class Report:
    results: list = field(default_factory=list)

    def check(self, th: Theorem, hyps: list, claim, ctx: "Ctx | None" = None, timeout_ms: int = 120_000, show: list | None = None):
        """Proves `hyps => claim` by asking Z3 for a counterexample to it.

        A proof only counts if the hypotheses are satisfiable on their own; otherwise the claim would hold
        vacuously, so that case is reported as "vacuous" and fails the run.
        `ctx` division constraints are read here, after `claim` was built, so none can be missed."""
        hyps = list(hyps) + (ctx.cs if ctx is not None else [])
        v = z3.Solver()
        v.set("timeout", timeout_ms)
        v.add(*hyps)
        if v.check() == z3.unsat:
            self.results.append({"module": th.module, "theorem": th.name, "statement": th.statement, "outcome": "vacuous",
                                 "expected": th.expect, "ok": False, "seconds": 0, "detail": "hypotheses are contradictory"})
            print(f"  \u2718 {th.module:<11} {th.name:<44} VACUOUS (hypotheses contradictory)")
            return "vacuous"
        s = z3.Solver()
        s.set("timeout", timeout_ms)
        s.add(*hyps)
        s.add(z3.Not(claim))
        t0 = time.time()
        r = s.check()
        dt = time.time() - t0
        if r == z3.unsat:
            outcome = "proved"
            detail = ""
        elif r == z3.sat:
            outcome = "counterexample"
            m = s.model()
            detail = ", ".join(f"{v}={m.eval(v, model_completion=True)}" for v in (show or []))
        else:
            outcome = "unknown"
            detail = s.reason_unknown()
        ok = outcome == th.expect
        self.results.append({"module": th.module, "theorem": th.name, "statement": th.statement,
                             "outcome": outcome, "expected": th.expect, "ok": ok, "seconds": round(dt, 3), "detail": detail})
        mark = "✔" if ok else "✘"
        extra = f"  [{detail}]" if detail else ""
        print(f"  {mark} {th.module:<11} {th.name:<44} {outcome}{extra} ({dt:.2f}s)")
        return outcome

    def finish(self, path: str | None = None) -> int:
        bad = [r for r in self.results if not r["ok"]]
        print(f"\n{len(self.results) - len(bad)}/{len(self.results)} theorems as expected")
        if path:
            with open(path, "w") as f:
                json.dump({"tool": f"z3 {z3.get_version_string()}", "theorems": self.results}, f, indent=1)
                f.write("\n")
        return 1 if bad else 0


def implies_all(*claims):
    return z3.And(*claims)


def die(msg: str):
    print(msg, file=sys.stderr)
    sys.exit(2)
