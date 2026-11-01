#!/usr/bin/env python3
"""Independent reference implementation of the uniform-price batch auction (docs/CONTRACT_SPEC.md).
Writes contracts/test-vectors/batch-auction.json, used by the Rust contract tests and the TS mirror tests."""
import json, random, os

def clear(orders):
    bids = [o for o in orders if o["side"] == "Bid"]
    asks = [o for o in orders if o["side"] == "Ask"]
    D = lambda p: sum(o["qty"] for o in bids if o["price"] >= p)
    S = lambda p: sum(o["qty"] for o in asks if o["price"] <= p)
    cands = sorted({o["price"] for o in orders})
    best = max((min(D(p), S(p)) for p in cands), default=0)
    if best == 0:
        return {"price": None, "volume": 0, "fills": [], "credits": {}, "share_deltas": {}}
    tied = [p for p in cands if min(D(p), S(p)) == best]
    imb = min(abs(D(p) - S(p)) for p in tied)
    tied = [p for p in tied if abs(D(p) - S(p)) == imb]
    P = (min(tied) + max(tied)) // 2
    assert min(D(P), S(P)) == best, "midpoint must keep max volume"
    fills, credits, deltas = [], {}, {}
    add = lambda d, k, v: d.__setitem__(k, d.get(k, 0) + v)
    left = best
    for o in sorted([b for b in bids if b["price"] >= P], key=lambda o: (-o["price"], o["id"])):
        if left == 0: break
        q = min(o["qty"], left); left -= q
        fills.append({"order_id": o["id"], "qty": q})
        add(deltas, o["owner"], q); add(credits, o["owner"], (o["price"] - P) * q)
    left = best
    for o in sorted([a for a in asks if a["price"] <= P], key=lambda o: (o["price"], o["id"])):
        if left == 0: break
        q = min(o["qty"], left); left -= q
        fills.append({"order_id": o["id"], "qty": q})
        add(deltas, o["owner"], -q); add(credits, o["owner"], q * P)
    credits = {k: v for k, v in credits.items() if v}
    deltas = {k: v for k, v in deltas.items() if v}
    return {"price": P, "volume": best, "fills": fills, "credits": credits, "share_deltas": deltas}

def case(name, orders):
    for i, o in enumerate(orders, 1): o["id"] = i
    r = clear(orders)
    s = {k: str(v) for k, v in r["credits"].items()}
    return {"name": name, "orders": [{**o, "price": str(o["price"]), "qty": str(o["qty"])} for o in orders],
            "expected": {"price": None if r["price"] is None else str(r["price"]), "volume": str(r["volume"]),
                         "fills": [{"order_id": f["order_id"], "qty": str(f["qty"])} for f in r["fills"]],
                         "credits": s, "share_deltas": {k: str(v) for k, v in r["share_deltas"].items()}}}

B = lambda owner, price, qty: {"side": "Bid", "owner": owner, "price": price, "qty": qty}
A = lambda owner, price, qty: {"side": "Ask", "owner": owner, "price": price, "qty": qty}
cases = [
    case("no-cross", [B("b1", 90, 10), A("s1", 100, 10)]),
    case("simple-cross-midpoint", [B("b1", 110, 10), A("s1", 90, 10)]),
    case("opening-auction-float", [A("creator", 85000, 40000), A("creator", 85850, 40000), B("t1", 86700, 3000), B("t2", 86700, 4500), B("t3", 90000, 6000), B("t4", 84000, 9000)]),
    case("partial-marginal-bid-time-priority", [A("s1", 100, 15), B("b1", 120, 10), B("b2", 110, 10), B("b3", 110, 10)]),
    case("imbalance-tiebreak", [B("b1", 105, 5), B("b2", 100, 10), A("s1", 95, 8), A("s2", 100, 4)]),
    case("only-bids", [B("b1", 100, 5)]),
    case("self-match", [B("x", 100, 5), A("x", 100, 5)]),
    case("deep-book", [B("b%d" % i, 1000 - i * 7, 10 + i) for i in range(12)] + [A("s%d" % i, 920 + i * 5, 7 + i) for i in range(12)]),
]
rng = random.Random(20261101)
for k in range(24):
    n = rng.randint(2, 30)
    os_ = []
    for _ in range(n):
        side = rng.choice(["Bid", "Ask"])
        os_.append({"side": side, "owner": "a%d" % rng.randint(1, 6), "price": rng.randint(80, 120) * 1000, "qty": rng.randint(1, 5000)})
    cases.append(case("random-%02d" % k, os_))
out = os.path.join(os.path.dirname(__file__), "..", "contracts", "test-vectors", "batch-auction.json")
json.dump({"spec": "docs/CONTRACT_SPEC.md#share-trading-frequent-batch-auctions-per-recipe-shares-vs-payment-token",
           "note": "orders are listed in id order; fills list bids first (price desc, id asc) then asks (price asc, id asc); credits include price improvement for bids and proceeds for asks",
           "midpoint_proof": "D is non-increasing and S non-decreasing in p. If V(lo)=V(hi)=v is the max, then D(hi)>=v and S(lo)>=v, so for lo<=P<=hi: D(P)>=D(hi)>=v and S(P)>=S(lo)>=v, hence V(P)>=v, and v is the max.",
           "cases": cases}, open(out, "w"), indent=1)
print(len(cases), "cases ->", os.path.normpath(out))
