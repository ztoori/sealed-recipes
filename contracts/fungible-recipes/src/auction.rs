//! Uniform-price batch auction (pure). Spec: `docs/CONTRACT_SPEC.md`,
//! section "Share trading: frequent batch auctions". Vectors:
//! `contracts/test-vectors/batch-auction.json`.

/// Order side as seen by the auction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuctionSide {
    Bid,
    Ask,
}

/// Minimal order view needed to clear an auction.
#[derive(Clone, Debug)]
pub struct AuctionOrder {
    pub id: u64,
    pub side: AuctionSide,
    pub price: u128,
    pub qty: u128,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuctionFill {
    pub order_id: u64,
    pub side: AuctionSide,
    /// The order's own limit price (needed for bid price-improvement refunds).
    pub limit: u128,
    pub qty: u128,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuctionResult {
    /// Uniform clearing price, `None` when nothing crosses.
    pub price: Option<u128>,
    pub volume: u128,
    /// D(P) and S(P) at the clearing price (0/0 when `price` is None).
    pub demand: u128,
    pub supply: u128,
    /// Bids first (price desc, id asc), then asks (price asc, id asc).
    pub fills: Vec<AuctionFill>,
}

fn demand(orders: &[AuctionOrder], p: u128) -> u128 {
    orders
        .iter()
        .filter(|o| o.side == AuctionSide::Bid && o.price >= p)
        .map(|o| o.qty)
        .sum()
}

fn supply(orders: &[AuctionOrder], p: u128) -> u128 {
    orders
        .iter()
        .filter(|o| o.side == AuctionSide::Ask && o.price <= p)
        .map(|o| o.qty)
        .sum()
}

/// Clears one batch:
/// 1. candidates = distinct order prices; keep max volume V = min(D, S) (0 → no clearing);
/// 2. among those keep min |D - S|;
/// 3. P = floor((min + max) / 2) of the remaining candidates (V(P) is still the max: D is
///    non-increasing, S non-decreasing).
///
/// Then fill eligible bids (price desc, id asc) and asks (price asc, id asc) greedily up to V.
pub fn clear_auction(orders: &[AuctionOrder]) -> AuctionResult {
    let mut cands: Vec<u128> = orders.iter().map(|o| o.price).collect();
    cands.sort_unstable();
    cands.dedup();
    let vol = |p: u128| demand(orders, p).min(supply(orders, p));
    let best = cands.iter().map(|&p| vol(p)).max().unwrap_or(0);
    if best == 0 {
        return AuctionResult { price: None, volume: 0, demand: 0, supply: 0, fills: vec![] };
    }
    let imb = |p: u128| demand(orders, p).abs_diff(supply(orders, p));
    let tied: Vec<u128> = cands.iter().copied().filter(|&p| vol(p) == best).collect();
    let min_imb = tied.iter().map(|&p| imb(p)).min().unwrap();
    let tied: Vec<u128> = tied.into_iter().filter(|&p| imb(p) == min_imb).collect();
    let (lo, hi) = (tied[0], *tied.last().unwrap());
    let price = lo + (hi - lo) / 2; // floor midpoint, overflow-safe

    let mut bids: Vec<&AuctionOrder> = orders
        .iter()
        .filter(|o| o.side == AuctionSide::Bid && o.price >= price)
        .collect();
    bids.sort_by(|a, b| b.price.cmp(&a.price).then(a.id.cmp(&b.id)));
    let mut asks: Vec<&AuctionOrder> = orders
        .iter()
        .filter(|o| o.side == AuctionSide::Ask && o.price <= price)
        .collect();
    asks.sort_by(|a, b| a.price.cmp(&b.price).then(a.id.cmp(&b.id)));

    let mut fills = Vec::new();
    for side in [bids, asks] {
        let mut left = best;
        for o in side {
            if left == 0 {
                break;
            }
            let q = o.qty.min(left);
            left -= q;
            fills.push(AuctionFill { order_id: o.id, side: o.side, limit: o.price, qty: q });
        }
    }
    AuctionResult {
        price: Some(price),
        volume: best,
        demand: demand(orders, price),
        supply: supply(orders, price),
        fills,
    }
}
