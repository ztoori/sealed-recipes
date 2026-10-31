use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const CONTRACT: &str = "frs.testnet";
const USDC: &str = "usdc.testnet";

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn signing_key() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32])
}

fn runner_pk_string() -> String {
    let vk = signing_key().verifying_key().to_bytes();
    let pk = PublicKey::from_parts(CurveType::ED25519, vk.to_vec()).unwrap();
    String::from(&pk)
}

fn ctx(predecessor: &str, ts: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acct(CONTRACT))
        .predecessor_account_id(acct(predecessor))
        .signer_account_id(acct(predecessor))
        .block_timestamp(ts);
    testing_env!(b.build());
}

fn ctx_yocto(predecessor: &str) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acct(CONTRACT))
        .predecessor_account_id(acct(predecessor))
        .attached_deposit(NearToken::from_yoctonear(1));
    testing_env!(b.build());
}

const BLOCKS: [(&str, &str, u128); 5] = [
    ("wallet-scanner", "scanlabs.testnet", 20_000),
    ("spam-shield", "shieldai.testnet", 50_000),
    ("dust-filter", "dustco.testnet", 10_000),
    ("fresh-address", "freshkeys.testnet", 10_000),
    ("private-swap", "swapsmith.testnet", 50_000),
];

/// Contract with the demo recipe "CLNP" published by creator.testnet.
fn setup() -> Contract {
    ctx("owner.testnet", 0);
    let mut c = Contract::new(acct("owner.testnet"), acct(USDC), acct("protocol.testnet"), 200);
    c.add_runner(
        acct("runner.testnet"),
        runner_pk_string(),
        "ab".repeat(32),
        "sha256:compose".into(),
        U128(30_000),
    );
    for (id, author, fee) in BLOCKS {
        ctx(author, 0);
        c.register_block(id.into(), "1.0.0".into(), U128(fee), format!("sha256:{id}"));
    }
    ctx("creator.testnet", 0);
    c.publish_recipe(
        "CLNP".into(),
        "Clean up and protect".into(),
        "sha256:sealed".into(),
        acct("runner.testnet"),
        BLOCKS.iter().map(|b| b.0.to_string()).collect(),
        U128(750_000),
        1000,
        U128(1_000_000),
    );
    c
}

fn pay_run(c: &mut Contract, buyer: &str, run_id: &str, amount: u128, ts: u64) {
    ctx(USDC, ts);
    let msg = json!({"action":"run","recipe_id":"CLNP","run_id":run_id,"inputs_hash":"ff".repeat(32)}).to_string();
    let _ = c.ft_on_transfer(acct(buyer), U128(amount), msg);
}

fn sign(run_id: &str, recipe: &str, ok: bool, out: &str, blocks: &[String]) -> Base64VecU8 {
    let m = run_report_message(CONTRACT, run_id, recipe, ok, out, blocks);
    Base64VecU8(signing_key().sign(m.as_bytes()).to_bytes().to_vec())
}

fn all_blocks() -> Vec<String> {
    BLOCKS.iter().map(|b| b.0.to_string()).collect()
}

fn bal(c: &Contract, a: &str) -> u128 {
    c.balance_of(acct(a)).0
}

// ---------------------------------------------------------------- vectors

#[test]
fn settlement_vectors_match_spec() {
    let v: serde_json::Value =
        serde_json::from_str(include_str!("../../test-vectors/settlement.json")).unwrap();
    let p = |x: &serde_json::Value| x.as_str().unwrap().parse::<u128>().unwrap();
    let cases = v["cases"].as_array().unwrap();
    assert!(cases.len() >= 5);
    for case in cases {
        let i = &case["input"];
        let e = &case["expected"];
        let fees: Vec<u128> = i["block_fees"].as_array().unwrap().iter().map(p).collect();
        let s = settlement_split(
            p(&i["price"]),
            i["protocol_fee_bps"].as_u64().unwrap() as u16,
            p(&i["runner_fee"]),
            &fees,
            i["royalty_bps"].as_u64().unwrap() as u16,
            p(&i["total_shares"]),
        )
        .unwrap();
        let name = case["name"].as_str().unwrap();
        assert_eq!(s.protocol, p(&e["protocol"]), "{name} protocol");
        assert_eq!(s.runner, p(&e["runner"]), "{name} runner");
        assert_eq!(s.blocks, e["blocks"].as_array().unwrap().iter().map(p).collect::<Vec<_>>());
        assert_eq!(s.remainder, p(&e["remainder"]), "{name} remainder");
        assert_eq!(s.creator, p(&e["creator"]), "{name} creator");
        assert_eq!(s.pool, p(&e["pool"]), "{name} pool");
        assert_eq!(s.acc_increment, p(&e["acc_increment"]), "{name} inc");
        assert_eq!(s.distributed, p(&e["distributed"]), "{name} distributed");
        assert_eq!(s.dust_to_protocol, p(&e["dust_to_protocol"]), "{name} dust");
        assert_eq!(s.protocol_total(), p(&e["protocol_total"]), "{name} protocol_total");
        // conservation
        let total = s.protocol_total() + s.runner + s.blocks.iter().sum::<u128>() + s.creator + s.distributed;
        assert_eq!(total, p(&i["price"]), "{name} conservation");
    }
}

#[test]
fn settlement_rejects_fees_above_price() {
    assert!(settlement_split(100, 0, 60, &[50], 0, 10).is_none());
    assert!(settlement_split(100, 0, 0, &[], 0, 0).is_none());
}

#[test]
fn dividends_vector_harvest_before_transfer() {
    let v: serde_json::Value =
        serde_json::from_str(include_str!("../../test-vectors/dividends.json")).unwrap();
    let r = &v["recipe"];
    let p = |x: &serde_json::Value| x.as_str().unwrap().parse::<u128>().unwrap();
    ctx("owner.testnet", 0);
    let mut c = Contract::new(acct("owner.testnet"), acct(USDC), acct("protocol.testnet"), r["protocol_fee_bps"].as_u64().unwrap() as u16);
    c.add_runner(acct("runner.testnet"), runner_pk_string(), "00".repeat(32), "x".into(), U128(p(&r["runner_fee"])));
    ctx("creator", 0);
    c.publish_recipe("DIVS".into(), "d".into(), "h".into(), acct("runner.testnet"), vec![], U128(p(&r["price"])), r["royalty_bps"].as_u64().unwrap() as u16, U128(p(&r["total_shares"])));
    let mut n = 0;
    for step in v["steps"].as_array().unwrap() {
        match step["op"].as_str().unwrap() {
            "run" => {
                n += 1;
                let id = format!("run-{n}");
                ctx(USDC, 0);
                let _ = c.ft_on_transfer(acct("buyer"), U128(p(&r["price"])), json!({"action":"run","recipe_id":"DIVS","run_id":id,"inputs_hash":"aa"}).to_string());
                ctx("relayer", 0);
                c.report_run(id.clone(), true, vec![], "out".into(), sign(&id, "DIVS", true, "out", &[]));
            }
            "transfer_shares" => {
                ctx(step["from"].as_str().unwrap(), 0);
                c.transfer_shares("DIVS".into(), acct(step["to"].as_str().unwrap()), U128(p(&step["qty"])));
            }
            _ => unreachable!(),
        }
    }
    for (who, expected) in v["expected_pending"].as_object().unwrap() {
        let total = bal(&c, who) + c.pending_dividends("DIVS".into(), acct(who)).0;
        assert_eq!(total, p(expected), "{who}");
    }
}

// --------------------------------------------------------------- publish

#[test]
#[should_panic(expected = "price_per_run below minimum viable price")]
fn publish_rejects_price_below_fees() {
    let mut c = setup();
    ctx("creator.testnet", 0);
    // fees: protocol 2% + runner 30_000 + blocks 140_000 => 170_000 > 150_000
    c.publish_recipe("CHEAP".into(), "x".into(), "h".into(), acct("runner.testnet"), all_blocks(), U128(150_000), 0, U128(10));
}

#[test]
#[should_panic(expected = "recipe id must match")]
fn publish_rejects_bad_ticker() {
    let mut c = setup();
    ctx("creator.testnet", 0);
    c.publish_recipe("bad".into(), "x".into(), "h".into(), acct("runner.testnet"), vec![], U128(1_000_000), 0, U128(10));
}

#[test]
#[should_panic(expected = "unknown block")]
fn publish_rejects_unknown_block() {
    let mut c = setup();
    ctx("creator.testnet", 0);
    c.publish_recipe("NOPE".into(), "x".into(), "h".into(), acct("runner.testnet"), vec!["ghost".into()], U128(1_000_000), 0, U128(10));
}

#[test]
fn publish_mints_all_shares_to_creator() {
    let c = setup();
    assert_eq!(c.shares_of("CLNP".into(), acct("creator.testnet")).shares.0, 1_000_000);
    assert_eq!(c.quote_settlement("CLNP".into(), None).pool.0, 508_500);
}

// --------------------------------------------------------- pay-per-run

#[test]
#[should_panic(expected = "only the payment token is accepted")]
fn ft_on_transfer_rejects_wrong_token() {
    let mut c = setup();
    ctx("evil-token.testnet", 0);
    let _ = c.ft_on_transfer(acct("buyer.testnet"), U128(750_000), json!({"action":"run","recipe_id":"CLNP","run_id":"r1","inputs_hash":"aa"}).to_string());
}

#[test]
#[should_panic(expected = "payment below price_per_run")]
fn ft_on_transfer_rejects_underpayment() {
    let mut c = setup();
    pay_run(&mut c, "buyer.testnet", "r1", 749_999, 0);
}

#[test]
#[should_panic(expected = "invalid msg")]
fn ft_on_transfer_rejects_garbage_msg() {
    let mut c = setup();
    ctx(USDC, 0);
    let _ = c.ft_on_transfer(acct("buyer.testnet"), U128(1), "hello".into());
}

#[test]
fn run_and_signed_report_pays_every_party_in_one_settlement() {
    let mut c = setup();
    pay_run(&mut c, "buyer.testnet", "r1", 800_000, 0);
    // overpayment credited back
    assert_eq!(bal(&c, "buyer.testnet"), 50_000);
    assert_eq!(c.get_run("r1".into()).unwrap().status, RunStatus::Pending);

    ctx("anyone-relayer.testnet", 1);
    let blocks = all_blocks();
    let payouts = c.report_run("r1".into(), true, blocks.clone(), "sha256:out".into(), sign("r1", "CLNP", true, "sha256:out", &blocks));
    assert_eq!(payouts.len(), 2 + BLOCKS.len() + 1);
    assert_eq!(c.get_run("r1".into()).unwrap().status, RunStatus::Settled);

    assert_eq!(bal(&c, "protocol.testnet"), 15_000);
    assert_eq!(bal(&c, "runner.testnet"), 30_000);
    for (_, author, fee) in BLOCKS {
        assert_eq!(bal(&c, author), fee);
    }
    assert_eq!(bal(&c, "creator.testnet"), 56_500);
    assert_eq!(c.pending_dividends("CLNP".into(), acct("creator.testnet")).0, 508_500);

    let r = c.get_recipe("CLNP".into()).unwrap();
    assert_eq!(r.runs, 1);
    assert_eq!(r.revenue.0, 750_000);

    ctx("creator.testnet", 2);
    assert_eq!(c.claim_dividends("CLNP".into()).0, 508_500);
    assert_eq!(bal(&c, "creator.testnet"), 565_000);
}

#[test]
fn partial_block_usage_bills_only_used_blocks() {
    let mut c = setup();
    pay_run(&mut c, "buyer.testnet", "r1", 750_000, 0);
    let used = vec!["wallet-scanner".to_string(), "dust-filter".to_string()];
    ctx("relayer.testnet", 1);
    c.report_run("r1".into(), true, used.clone(), "o".into(), sign("r1", "CLNP", true, "o", &used));
    assert_eq!(bal(&c, "shieldai.testnet"), 0);
    assert_eq!(bal(&c, "scanlabs.testnet"), 20_000);
}

#[test]
#[should_panic(expected = "invalid runner signature")]
fn report_with_bad_signature_rejected() {
    let mut c = setup();
    pay_run(&mut c, "buyer.testnet", "r1", 750_000, 0);
    let blocks = all_blocks();
    // signed for a different output hash
    let sig = sign("r1", "CLNP", true, "sha256:other", &blocks);
    ctx("relayer.testnet", 1);
    c.report_run("r1".into(), true, blocks, "sha256:out".into(), sig);
}

#[test]
#[should_panic(expected = "invalid runner signature")]
fn report_signed_by_other_key_rejected() {
    let mut c = setup();
    pay_run(&mut c, "buyer.testnet", "r1", 750_000, 0);
    let blocks = all_blocks();
    let m = run_report_message(CONTRACT, "r1", "CLNP", true, "o", &blocks);
    let sig = Base64VecU8(SigningKey::from_bytes(&[9u8; 32]).sign(m.as_bytes()).to_bytes().to_vec());
    ctx("relayer.testnet", 1);
    c.report_run("r1".into(), true, blocks, "o".into(), sig);
}

#[test]
#[should_panic(expected = "blocks_used not part of recipe")]
fn report_cannot_bill_extra_blocks() {
    let mut c = setup();
    pay_run(&mut c, "buyer.testnet", "r1", 750_000, 0);
    let mut blocks = all_blocks();
    blocks.push("spam-shield".into()); // billed twice but recipe has it once
    ctx("relayer.testnet", 1);
    c.report_run("r1".into(), true, blocks.clone(), "o".into(), sign("r1", "CLNP", true, "o", &blocks));
}

#[test]
#[should_panic(expected = "run not pending")]
fn report_cannot_settle_twice() {
    let mut c = setup();
    pay_run(&mut c, "buyer.testnet", "r1", 750_000, 0);
    let b = all_blocks();
    ctx("relayer.testnet", 1);
    c.report_run("r1".into(), true, b.clone(), "o".into(), sign("r1", "CLNP", true, "o", &b));
    c.report_run("r1".into(), true, b.clone(), "o".into(), sign("r1", "CLNP", true, "o", &b));
}

#[test]
fn failed_run_refunds_buyer() {
    let mut c = setup();
    pay_run(&mut c, "buyer.testnet", "r1", 750_000, 0);
    ctx("relayer.testnet", 1);
    let payouts = c.report_run("r1".into(), false, vec![], "err".into(), sign("r1", "CLNP", false, "err", &[]));
    assert!(payouts.is_empty());
    assert_eq!(bal(&c, "buyer.testnet"), 750_000);
    assert_eq!(bal(&c, "creator.testnet"), 0);
    assert_eq!(c.get_run("r1".into()).unwrap().status, RunStatus::Refunded);
}

#[test]
fn reclaim_after_timeout() {
    let mut c = setup();
    pay_run(&mut c, "buyer.testnet", "r1", 750_000, 1_000);
    ctx("buyer.testnet", 1_000 + RUN_TIMEOUT_NS);
    c.reclaim_run("r1".into());
    assert_eq!(bal(&c, "buyer.testnet"), 750_000);
    assert_eq!(c.get_run("r1".into()).unwrap().status, RunStatus::Refunded);
}

#[test]
#[should_panic(expected = "run not timed out")]
fn reclaim_before_timeout_rejected() {
    let mut c = setup();
    pay_run(&mut c, "buyer.testnet", "r1", 750_000, 1_000);
    ctx("buyer.testnet", 1_000 + RUN_TIMEOUT_NS - 1);
    c.reclaim_run("r1".into());
}

#[test]
#[should_panic(expected = "run exists")]
fn duplicate_run_id_rejected() {
    let mut c = setup();
    pay_run(&mut c, "buyer.testnet", "r1", 750_000, 0);
    pay_run(&mut c, "buyer.testnet", "r1", 750_000, 0);
}

#[test]
fn withdraw_debits_balance() {
    let mut c = setup();
    pay_run(&mut c, "buyer.testnet", "r1", 800_000, 0);
    ctx_yocto("buyer.testnet");
    let _ = c.withdraw(None);
    assert_eq!(bal(&c, "buyer.testnet"), 0);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn withdraw_requires_one_yocto() {
    let mut c = setup();
    pay_run(&mut c, "buyer.testnet", "r1", 800_000, 0);
    ctx("buyer.testnet", 0);
    let _ = c.withdraw(None);
}

#[test]
fn failed_withdraw_restores_balance() {
    let mut c = setup();
    ctx(CONTRACT, 0);
    let ok = c.on_withdraw(acct("buyer.testnet"), U128(123), Err(PromiseError::Failed));
    assert!(!ok);
    assert_eq!(bal(&c, "buyer.testnet"), 123);
}

// ------------------------------------------------------------ order book

fn bid(c: &mut Contract, who: &str, price: u128, qty: u128, deposit: u128) {
    ctx(USDC, 0);
    let _ = c.ft_on_transfer(acct(who), U128(deposit), json!({"action":"bid","recipe_id":"CLNP","price":U128(price),"qty":U128(qty)}).to_string());
}

#[test]
fn crossing_bid_trades_at_maker_price_and_refunds_improvement() {
    let mut c = setup();
    ctx("creator.testnet", 0);
    let ask_id = c.place_ask("CLNP".into(), U128(100), U128(1_000));
    assert_eq!(c.shares_of("CLNP".into(), acct("creator.testnet")).locked.0, 1_000);

    bid(&mut c, "alice.testnet", 120, 1_000, 120_000);
    assert_eq!(c.shares_of("CLNP".into(), acct("alice.testnet")).shares.0, 1_000);
    let creator = c.shares_of("CLNP".into(), acct("creator.testnet"));
    assert_eq!((creator.shares.0, creator.locked.0), (999_000, 0));
    assert_eq!(bal(&c, "creator.testnet"), 100_000); // 1000 * 100 maker price
    assert_eq!(bal(&c, "alice.testnet"), 20_000); // price improvement
    let book = c.get_book("CLNP".into());
    assert!(book.asks.is_empty() && book.bids.is_empty());
    assert!(c.order_index.get(&ask_id).is_none());
}

#[test]
fn partial_fill_rests_remainder_and_price_time_priority() {
    let mut c = setup();
    ctx("creator.testnet", 0);
    c.transfer_shares("CLNP".into(), acct("bob.testnet"), U128(500));
    c.place_ask("CLNP".into(), U128(110), U128(300));
    ctx("bob.testnet", 0);
    c.place_ask("CLNP".into(), U128(100), U128(200)); // better price, later time
    ctx("creator.testnet", 0);
    c.place_ask("CLNP".into(), U128(100), U128(50)); // same price as bob, later

    // Buy 400 @ up to 110: bob 200@100, creator 50@100, creator 150@110
    bid(&mut c, "alice.testnet", 110, 400, 44_000);
    assert_eq!(c.shares_of("CLNP".into(), acct("alice.testnet")).shares.0, 400);
    assert_eq!(bal(&c, "bob.testnet"), 20_000);
    assert_eq!(bal(&c, "creator.testnet"), 5_000 + 16_500);
    assert_eq!(bal(&c, "alice.testnet"), 2_500); // (110-100)*250
    let book = c.get_book("CLNP".into());
    assert_eq!(book.asks.len(), 1);
    assert_eq!(book.asks[0].qty.0, 150);
    assert_eq!(book.asks[0].price.0, 110);

    // A resting bid below the ask, then an ask that crosses it partially
    bid(&mut c, "carol.testnet", 90, 100, 9_000);
    ctx("bob.testnet", 0);
    c.place_ask("CLNP".into(), U128(80), U128(40));
    assert_eq!(bal(&c, "bob.testnet"), 20_000 + 40 * 90); // maker (bid) price
    let book = c.get_book("CLNP".into());
    assert_eq!(book.bids[0].qty.0, 60);
}

#[test]
fn cancel_returns_escrow() {
    let mut c = setup();
    bid(&mut c, "alice.testnet", 50, 100, 5_000);
    let bid_id = c.get_book("CLNP".into()).bids[0].id;
    ctx("alice.testnet", 0);
    c.cancel_order(bid_id);
    assert_eq!(bal(&c, "alice.testnet"), 5_000);

    ctx("creator.testnet", 0);
    let ask_id = c.place_ask("CLNP".into(), U128(500), U128(10));
    c.cancel_order(ask_id);
    assert_eq!(c.shares_of("CLNP".into(), acct("creator.testnet")).locked.0, 0);
    let book = c.get_book("CLNP".into());
    assert!(book.bids.is_empty() && book.asks.is_empty());
}

#[test]
#[should_panic(expected = "order owner only")]
fn cannot_cancel_others_order() {
    let mut c = setup();
    bid(&mut c, "alice.testnet", 50, 100, 5_000);
    let id = c.get_book("CLNP".into()).bids[0].id;
    ctx("mallory.testnet", 0);
    c.cancel_order(id);
}

#[test]
#[should_panic(expected = "insufficient shares")]
fn locked_shares_cannot_be_transferred() {
    let mut c = setup();
    ctx("creator.testnet", 0);
    c.place_ask("CLNP".into(), U128(100), U128(1_000_000));
    c.transfer_shares("CLNP".into(), acct("bob.testnet"), U128(1));
}

#[test]
fn trading_shares_harvests_dividends_correctly() {
    let mut c = setup();
    let b = all_blocks();
    // run 1: creator owns 100%
    pay_run(&mut c, "buyer.testnet", "r1", 750_000, 0);
    ctx("relayer.testnet", 0);
    c.report_run("r1".into(), true, b.clone(), "o".into(), sign("r1", "CLNP", true, "o", &b));

    // creator sells 25% to alice via the book; escrowed shares earn until filled
    ctx("creator.testnet", 0);
    c.place_ask("CLNP".into(), U128(1), U128(250_000));
    pay_run(&mut c, "buyer.testnet", "r2", 750_000, 0);
    ctx("relayer.testnet", 0);
    c.report_run("r2".into(), true, b.clone(), "o".into(), sign("r2", "CLNP", true, "o", &b));
    bid(&mut c, "alice.testnet", 1, 250_000, 250_000);

    // run 3: 75/25 split
    pay_run(&mut c, "buyer.testnet", "r3", 750_000, 0);
    ctx("relayer.testnet", 0);
    c.report_run("r3".into(), true, b.clone(), "o".into(), sign("r3", "CLNP", true, "o", &b));

    let pool = 508_500u128;
    let creator_div = bal(&c, "creator.testnet") - 3 * 56_500 - 250_000
        + c.pending_dividends("CLNP".into(), acct("creator.testnet")).0;
    assert_eq!(creator_div, 2 * pool + pool * 3 / 4);
    assert_eq!(
        c.pending_dividends("CLNP".into(), acct("alice.testnet")).0,
        pool / 4
    );
    // conservation: all dividends accounted for
    assert_eq!(creator_div + pool / 4, 3 * pool);
}

#[test]
fn signed_message_format_is_stable() {
    let m = run_report_message("frs.testnet", "r-1", "CLNP", true, "sha256:ab", &["a".into(), "b".into()]);
    assert_eq!(m, "frs-run-v1|frs.testnet|r-1|CLNP|ok|sha256:ab|a,b");
}

#[test]
fn intents_solver_pays_on_behalf_of_buyer() {
    let mut c = setup();
    ctx(USDC, 0);
    let msg = json!({"action":"run","recipe_id":"CLNP","run_id":"r-solver","inputs_hash":"ab".repeat(32),"on_behalf_of":"bob.testnet"}).to_string();
    let _ = c.ft_on_transfer(acct("solver.testnet"), U128(800_000), msg);
    let run = c.get_run("r-solver".into()).unwrap();
    assert_eq!(run.buyer.as_str(), "bob.testnet");
    assert_eq!(bal(&c, "bob.testnet"), 50_000);
    assert_eq!(bal(&c, "solver.testnet"), 0);
}
