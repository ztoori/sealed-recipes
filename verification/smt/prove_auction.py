"""
Machine-checked proofs (Z3) for the uniform-price batch auction (contracts/fungible-recipes/src/auction.rs).

The book is N symbolic orders (each side, price and quantity unconstrained within u128, quantity > 0 as the
contract requires). The clearing rule and the greedy price-time fill are encoded exactly as `clear_auction`
computes them; the theorems are the market properties a trader relies on. N = 4 covers every interleaving of
two bids and two asks and every three-against-one book; `gen_conformance.py` checks the encoding against the
Rust function on larger random books.
"""
from __future__ import annotations

import z3

from common import Ctx, Report, Theorem, u128


def book(n: int, cs: list):
    orders = []
    for i in range(n):
        bid = z3.Bool(f"bid{i}")
        p = u128(f"price{i}", cs)
        q = u128(f"qty{i}", cs)
        cs += [q > 0]  # place_ask / bid reject qty 0
        orders.append((i, bid, p, q))
    return orders


def ssum(xs):
    return z3.Sum(*xs) if xs else z3.IntVal(0)


def clear(c: Ctx, orders, cs: list):
    D = lambda p: ssum([z3.If(z3.And(b, pr >= p), q, 0) for _, b, pr, q in orders])
    S = lambda p: ssum([z3.If(z3.And(z3.Not(b), pr <= p), q, 0) for _, b, pr, q in orders])
    vol = lambda p: z3.If(D(p) <= S(p), D(p), S(p))
    imb = lambda p: z3.If(D(p) >= S(p), D(p) - S(p), S(p) - D(p))
    V, M = z3.Int("V"), z3.Int("min_imbalance")
    prices = [pr for _, _, pr, _ in orders]
    cs += [z3.And(*[vol(p) <= V for p in prices]), z3.Or(*[vol(p) == V for p in prices])]
    cs += [z3.And(*[z3.Implies(vol(p) == V, imb(p) >= M) for p in prices]), z3.Or(*[z3.And(vol(p) == V, imb(p) == M) for p in prices])]
    tied = [z3.And(vol(p) == V, imb(p) == M) for p in prices]
    lo, hi = z3.Int("lo"), z3.Int("hi")
    cs += [z3.And(*[z3.Implies(t, z3.And(lo <= p, p <= hi)) for t, p in zip(tied, prices)]),
           z3.Or(*[z3.And(t, lo == p) for t, p in zip(tied, prices)]), z3.Or(*[z3.And(t, hi == p) for t, p in zip(tied, prices)])]
    P = lo + c.div(hi - lo, 2)
    fills = []
    for i, b, p, q in orders:
        elig = z3.If(b, p >= P, p <= P)
        ahead = ssum([z3.If(z3.And(bj == b, z3.If(b, pj >= P, pj <= P),
                                   z3.If(b, z3.Or(pj > p, z3.And(pj == p, j < i)), z3.Or(pj < p, z3.And(pj == p, j < i)))), qj, 0)
                      for j, bj, pj, qj in orders if j != i])
        left = z3.If(V - ahead > 0, V - ahead, 0)
        fills.append(z3.If(z3.And(V > 0, elig), z3.If(q <= left, q, left), 0))
    return dict(V=V, P=P, D=D, S=S, vol=vol, fills=fills, lo=lo, hi=hi)


def prove(R: Report, n: int = 4):
    cs: list = []
    orders = book(n, cs)
    c = Ctx(True)
    r = clear(c, orders, cs)
    V, P, f = r["V"], r["P"], r["fills"]
    m = f"auction[{n}]"
    bidf = ssum([z3.If(b, fi, 0) for (_, b, _, _), fi in zip(orders, f)])
    askf = ssum([z3.If(b, 0, fi) for (_, b, _, _), fi in zip(orders, f)])
    R.check(Theorem(m, "balanced", "shares bought == shares sold == clearing volume"),
            cs, z3.Implies(V > 0, z3.And(bidf == V, askf == V)), ctx=c)
    R.check(Theorem(m, "price-attains-max-volume", "the chosen price itself trades the maximum volume"),
            cs, z3.Implies(V > 0, r["vol"](P) == V), ctx=c)
    R.check(Theorem(m, "volume-is-maximal", "no price at all (not only order prices) would trade more"),
            cs + [z3.Int("x") >= 0], r["vol"](z3.Int("x")) <= V, ctx=c)
    R.check(Theorem(m, "limits-respected", "every filled bid has limit >= P, every filled ask limit <= P, fill <= qty"),
            cs, z3.And(*[z3.And(fi >= 0, fi <= q, z3.Implies(fi > 0, z3.If(b, p >= P, p <= P))) for (_, b, p, q), fi in zip(orders, f)]), ctx=c)
    # j ranks behind i on the same side: worse price, or same price and later id
    behind = lambda bi, pi, i, pj, j: z3.If(bi, z3.Or(pj < pi, z3.And(pj == pi, j > i)), z3.Or(pj > pi, z3.And(pj == pi, j > i)))
    R.check(Theorem(m, "price-time-priority", "if an order is not completely filled, every order ranked behind it gets nothing"),
            cs, z3.And(*[z3.Implies(z3.And(bi == bj, fi < qi, behind(bi, pi, i, pj, j)), fj == 0)
                         for (i, bi, pi, qi), fi in zip(orders, f) for (j, bj, pj, qj), fj in zip(orders, f) if i != j]), ctx=c)
    R.check(Theorem(m, "no-residual-cross", "after clearing, no remaining bid is priced at or above a remaining ask"),
            cs, z3.And(*[z3.Implies(z3.And(bi, z3.Not(bj), fi < qi, fj < qj), pi < pj)
                         for (i, bi, pi, qi), fi in zip(orders, f) for (j, bj, pj, qj), fj in zip(orders, f) if i != j]), ctx=c)
    R.check(Theorem(m, "no-trade-means-no-cross", "if nothing clears, every bid is below every ask"),
            cs, z3.Implies(V == 0, z3.And(*[z3.Implies(z3.And(bi, z3.Not(bj)), pi < pj)
                                             for (i, bi, pi, _) in orders for (j, bj, pj, _) in orders if i != j])), ctx=c)
    R.check(Theorem(m, "uniform-price-fair", "buyers pay <= their limit (escrow covers it), sellers get >= their limit"),
            cs, z3.And(*[z3.Implies(fi > 0, z3.If(b, P * fi <= p * fi, P * fi >= p * fi)) for (_, b, p, _), fi in zip(orders, f)]), ctx=c)
    R.check(Theorem(m, "price-within-book", "the clearing price lies between the tied candidate prices"),
            cs, z3.Implies(V > 0, z3.And(r["lo"] <= P, P <= r["hi"])), ctx=c)


def main():
    R = Report()
    print("auction")
    for n in (2, 3, 4):
        prove(R, n)
    return R


if __name__ == "__main__":
    import sys
    sys.exit(main().finish())
