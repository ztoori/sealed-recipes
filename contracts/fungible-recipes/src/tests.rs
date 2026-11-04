use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const CONTRACT: &str = "frs.testnet";
const USDC: &str = "usdc.testnet";
const INTERVAL: u64 = 12_000_000_000;
const OUT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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

const PARTS: [(&str, &str, u128); 5] = [
    ("wallet-scanner", "scanlabs.testnet", 20_000),
    ("spam-shield", "shieldai.testnet", 50_000),
    ("dust-filter", "dustco.testnet", 10_000),
    ("fresh-address", "freshkeys.testnet", 10_000),
    ("private-swap", "swapsmith.testnet", 50_000),
];

/// Contract with the demo recipe "CLNP" published by creator.testnet.
fn setup() -> Contract {
    ctx("owner.testnet", 0);
    let mut c = Contract::new(acct("owner.testnet"), acct(USDC), acct("protocol.testnet"), 200, U64(INTERVAL));
    c.add_runner(
        acct("runner.testnet"),
        runner_pk_string(),
        "ab".repeat(32),
        "sha256:compose".into(),
        U128(30_000),
    );
    for (id, author, fee) in PARTS {
        ctx(author, 0);
        c.register_part(id.into(), "1.0.0".into(), U128(fee), format!("sha256:{id}"));
    }
    ctx("creator.testnet", 0);
    c.publish_recipe(
        "CLNP".into(),
        "Clean up and protect".into(),
        "sha256:sealed".into(),
        acct("runner.testnet"),
        PARTS.iter().map(|b| b.0.to_string()).collect(),
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

fn sign(run_id: &str, recipe: &str, outcome: &str, out: &str, parts: &[String]) -> Base64VecU8 {
    let m = run_report_message(CONTRACT, run_id, recipe, outcome, out, 0, parts);
    Base64VecU8(signing_key().sign(m.as_bytes()).to_bytes().to_vec())
}

fn all_parts() -> Vec<String> {
    PARTS.iter().map(|b| b.0.to_string()).collect()
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
        let fees: Vec<u128> = i["part_fees"].as_array().unwrap().iter().map(p).collect();
        let s = settlement_split(
            p(&i["price"]),
            i["protocol_fee_bps"].as_u64().unwrap() as u16,
            p(&i["runner_fee"]),
            &fees,
            i["royalty_bps"].as_u64().unwrap() as u16,
            p(&i["total_shares"]),
            i.get("acc_before").map(p).unwrap_or(0),
        )
        .unwrap();
        let name = case["name"].as_str().unwrap();
        assert_eq!(s.protocol, p(&e["protocol"]), "{name} protocol");
        assert_eq!(s.runner, p(&e["runner"]), "{name} runner");
        assert_eq!(s.parts, e["parts"].as_array().unwrap().iter().map(p).collect::<Vec<_>>());
        assert_eq!(s.remainder, p(&e["remainder"]), "{name} remainder");
        assert_eq!(s.creator, p(&e["creator"]), "{name} creator");
        assert_eq!(s.pool, p(&e["pool"]), "{name} pool");
        assert_eq!(s.acc_increment, p(&e["acc_increment"]), "{name} inc");
        assert_eq!(s.distributed, p(&e["distributed"]), "{name} distributed");
        assert_eq!(s.dust_to_protocol, p(&e["dust_to_protocol"]), "{name} dust");
        assert_eq!(s.protocol_total(), p(&e["protocol_total"]), "{name} protocol_total");
        // conservation
        let total = s.protocol_total() + s.runner + s.parts.iter().sum::<u128>() + s.creator + s.distributed;
        assert_eq!(total, p(&i["price"]), "{name} conservation");
    }
}

#[test]
fn settlement_rejects_fees_above_price() {
    assert!(settlement_split(100, 0, 60, &[50], 0, 10, 0).is_none());
    assert!(settlement_split(100, 0, 0, &[], 0, 0, 0).is_none());
}

#[test]
fn dividends_vector_harvest_before_transfer() {
    let v: serde_json::Value =
        serde_json::from_str(include_str!("../../test-vectors/dividends.json")).unwrap();
    let r = &v["recipe"];
    let p = |x: &serde_json::Value| x.as_str().unwrap().parse::<u128>().unwrap();
    ctx("owner.testnet", 0);
    let mut c = Contract::new(acct("owner.testnet"), acct(USDC), acct("protocol.testnet"), r["protocol_fee_bps"].as_u64().unwrap() as u16, U64(INTERVAL));
    c.add_runner(acct("runner.testnet"), runner_pk_string(), "00".repeat(32), "x".into(), U128(p(&r["runner_fee"])));
    ctx("author", 0);
    c.register_part("noop".into(), "1".into(), U128(0), "h".into());
    ctx("creator", 0);
    c.publish_recipe("DIVS".into(), "d".into(), "h".into(), acct("runner.testnet"), vec!["noop".into()], U128(p(&r["price"])), r["royalty_bps"].as_u64().unwrap() as u16, U128(p(&r["total_shares"])));
    let mut n = 0;
    for step in v["steps"].as_array().unwrap() {
        match step["op"].as_str().unwrap() {
            "run" => {
                n += 1;
                let id = format!("run-{n}");
                ctx(USDC, 0);
                let _ = c.ft_on_transfer(acct("buyer"), U128(p(&r["price"])), json!({"action":"run","recipe_id":"DIVS","run_id":id,"inputs_hash":"aa".repeat(32)}).to_string());
                ctx("relayer", 0);
                c.report_run(id.clone(), "ok".into(), vec!["noop".into()], OUT.into(), U128(0), sign(&id, "DIVS", "ok", OUT, &["noop".to_string()]));
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
    // fees: protocol 2% + runner 30_000 + parts 140_000 => 170_000 > 150_000
    c.publish_recipe("CHEAP".into(), "x".into(), "h".into(), acct("runner.testnet"), all_parts(), U128(150_000), 0, U128(10));
}

#[test]
#[should_panic(expected = "recipe id must match")]
fn publish_rejects_bad_ticker() {
    let mut c = setup();
    ctx("creator.testnet", 0);
    c.publish_recipe("bad".into(), "x".into(), "h".into(), acct("runner.testnet"), vec![], U128(1_000_000), 0, U128(10));
}

#[test]
#[should_panic(expected = "unknown part")]
fn publish_rejects_unknown_part() {
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
    let _ = c.ft_on_transfer(acct("buyer.testnet"), U128(750_000), json!({"action":"run","recipe_id":"CLNP","run_id":"r1","inputs_hash":"aa".repeat(32)}).to_string());
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
    let parts = all_parts();
    let payouts = c.report_run("r1".into(), "ok".into(), parts.clone(), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(), U128(0), sign("r1", "CLNP", "ok", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", &parts));
    assert_eq!(payouts.len(), 2 + PARTS.len() + 1);
    assert_eq!(c.get_run("r1".into()).unwrap().status, RunStatus::Settled);

    assert_eq!(bal(&c, "protocol.testnet"), 15_000);
    assert_eq!(bal(&c, "runner.testnet"), 30_000);
    for (_, author, fee) in PARTS {
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
fn partial_part_usage_bills_only_used_parts() {
    let mut c = setup();
    pay_run(&mut c, "buyer.testnet", "r1", 750_000, 0);
    let used = vec!["wallet-scanner".to_string(), "dust-filter".to_string()];
    ctx("relayer.testnet", 1);
    c.report_run("r1".into(), "ok".into(), used.clone(), OUT.into(), U128(0), sign("r1", "CLNP", "ok", OUT, &used));
    assert_eq!(bal(&c, "shieldai.testnet"), 0);
    assert_eq!(bal(&c, "scanlabs.testnet"), 20_000);
}

#[test]
#[should_panic(expected = "invalid runner signature")]
fn report_with_bad_signature_rejected() {
    let mut c = setup();
    pay_run(&mut c, "buyer.testnet", "r1", 750_000, 0);
    let parts = all_parts();
    // signed for a different output hash
    let sig = sign("r1", "CLNP", "ok", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", &parts);
    ctx("relayer.testnet", 1);
    c.report_run("r1".into(), "ok".into(), parts, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(), U128(0), sig);
}

#[test]
#[should_panic(expected = "invalid runner signature")]
fn report_signed_by_other_key_rejected() {
    let mut c = setup();
    pay_run(&mut c, "buyer.testnet", "r1", 750_000, 0);
    let parts = all_parts();
    let m = run_report_message(CONTRACT, "r1", "CLNP", "ok", OUT, 0, &parts);
    let sig = Base64VecU8(SigningKey::from_bytes(&[9u8; 32]).sign(m.as_bytes()).to_bytes().to_vec());
    ctx("relayer.testnet", 1);
    c.report_run("r1".into(), "ok".into(), parts, OUT.into(), U128(0), sig);
}

#[test]
#[should_panic(expected = "parts_used not part of recipe")]
fn report_cannot_bill_extra_parts() {
    let mut c = setup();
    pay_run(&mut c, "buyer.testnet", "r1", 750_000, 0);
    let mut parts = all_parts();
    parts.push("spam-shield".into()); // billed twice but recipe has it once
    ctx("relayer.testnet", 1);
    c.report_run("r1".into(), "ok".into(), parts.clone(), OUT.into(), U128(0), sign("r1", "CLNP", "ok", OUT, &parts));
}

#[test]
#[should_panic(expected = "run not pending")]
fn report_cannot_settle_twice() {
    let mut c = setup();
    pay_run(&mut c, "buyer.testnet", "r1", 750_000, 0);
    let b = all_parts();
    ctx("relayer.testnet", 1);
    c.report_run("r1".into(), "ok".into(), b.clone(), OUT.into(), U128(0), sign("r1", "CLNP", "ok", OUT, &b));
    c.report_run("r1".into(), "ok".into(), b.clone(), OUT.into(), U128(0), sign("r1", "CLNP", "ok", OUT, &b));
}

#[test]
fn failed_run_refunds_buyer() {
    let mut c = setup();
    pay_run(&mut c, "buyer.testnet", "r1", 750_000, 0);
    ctx("relayer.testnet", 1);
    let payouts = c.report_run("r1".into(), "fail".into(), vec![], OUT.into(), U128(0), sign("r1", "CLNP", "fail", OUT, &[]));
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

fn ctx_callback(result: near_sdk::PromiseResult) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acct(CONTRACT)).predecessor_account_id(acct(CONTRACT));
    testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![result],
    );
}

fn last_event() -> serde_json::Value {
    let logs = near_sdk::test_utils::get_logs();
    let l = logs.iter().rev().find(|l| l.starts_with("EVENT_JSON:")).expect("no event");
    serde_json::from_str(&l["EVENT_JSON:".len()..]).unwrap()
}

#[test]
fn failed_withdraw_restores_balance() {
    let mut c = setup();
    ctx_callback(near_sdk::PromiseResult::Failed);
    let ok = c.on_withdraw(acct("buyer.testnet"), U128(123));
    assert!(!ok);
    assert_eq!(bal(&c, "buyer.testnet"), 123);
    assert_eq!(last_event()["event"], "withdraw_failed");
}

#[test]
fn successful_withdraw_callback_with_empty_result() {
    // ft_transfer returns no value: the callback must treat an empty successful result as success.
    let mut c = setup();
    ctx_callback(near_sdk::PromiseResult::Successful(vec![]));
    let ok = c.on_withdraw(acct("buyer.testnet"), U128(123));
    assert!(ok);
    assert_eq!(bal(&c, "buyer.testnet"), 0);
    let e = last_event();
    assert_eq!(e["event"], "withdrawn");
    assert_eq!(e["data"][0]["amount"], "123");
}

#[test]
fn run_snapshots_sealed_hash() {
    let mut c = setup();
    pay_run(&mut c, "buyer.testnet", "r1", 750_000, 0);
    ctx("creator.testnet", 0);
    c.update_sealed("CLNP".into(), "sha256:v2".into());
    pay_run(&mut c, "buyer.testnet", "r2", 750_000, 0);
    assert_eq!(c.get_run("r1".into()).unwrap().sealed_hash, "sha256:sealed");
    assert_eq!(c.get_run("r2".into()).unwrap().sealed_hash, "sha256:v2");
    let j = serde_json::to_value(c.get_run("r1".into()).unwrap()).unwrap();
    assert_eq!(j["sealed_hash"], "sha256:sealed");
}

fn intents_msg(extra: serde_json::Value) -> String {
    let mut m = json!({"action":"run","recipe_id":"CLNP","run_id":"r-x","inputs_hash":"ab".repeat(32),"on_behalf_of":"bob.testnet"});
    for (k, v) in extra.as_object().unwrap() {
        m[k] = v.clone();
    }
    m.to_string()
}

fn intents_reject_case(extra: serde_json::Value, amt: u128, reason: &str) {
    let mut c = setup();
    ctx(USDC, 0);
    let r = c.ft_on_transfer(acct("solver.testnet"), U128(amt), intents_msg(extra));
    assert!(matches!(r, PromiseOrValue::Value(U128(0))));
    assert_eq!(bal(&c, "bob.testnet"), amt, "{reason}");
    assert!(c.get_run("r-x".into()).is_none());
    let e = last_event();
    assert_eq!(e["event"], "transfer_rejected");
    assert!(e["data"][0]["reason"].as_str().unwrap().starts_with(reason), "{reason}");
    assert_eq!(e["data"][0]["sender_id"], "solver.testnet");
    assert_eq!(e["data"][0]["on_behalf_of"], "bob.testnet");
}

#[test]
fn intents_unknown_recipe_credits_buyer() { intents_reject_case(json!({"recipe_id":"NOPE"}), 800_000, "unknown recipe"); }
#[test]
fn intents_bad_inputs_hash_credits_buyer() { intents_reject_case(json!({"inputs_hash":"XYZ"}), 800_000, "inputs_hash must be 64 lowercase hex"); }
#[test]
fn intents_bad_run_id_credits_buyer() { intents_reject_case(json!({"run_id":"bad|id"}), 800_000, "run_id must match"); }
#[test]
fn intents_underpayment_credits_buyer() { intents_reject_case(json!({}), 749_999, "payment below price_per_run"); }

#[test]
fn intents_duplicate_run_id_credits_buyer() {
    let mut c = setup();
    ctx(USDC, 0);
    let _ = c.ft_on_transfer(acct("solver.testnet"), U128(750_000), intents_msg(json!({})));
    let _ = c.ft_on_transfer(acct("solver.testnet"), U128(750_000), intents_msg(json!({})));
    assert_eq!(bal(&c, "bob.testnet"), 750_000);
    assert_eq!(last_event()["data"][0]["reason"], "run exists");
}

#[test]
fn intents_bid_failure_credits_buyer() {
    let mut c = setup();
    ctx(USDC, 0);
    let msg = json!({"action":"bid","recipe_id":"CLNP","price":"0","qty":"10","on_behalf_of":"bob.testnet"}).to_string();
    let _ = c.ft_on_transfer(acct("solver.testnet"), U128(5_000), msg);
    assert_eq!(bal(&c, "bob.testnet"), 5_000);
    assert_eq!(last_event()["event"], "transfer_rejected");
}

#[test]
#[should_panic(expected = "unknown recipe")]
fn direct_transfer_failure_still_panics() {
    let mut c = setup();
    ctx(USDC, 0);
    let msg = json!({"action":"run","recipe_id":"NOPE","run_id":"r1","inputs_hash":"ab".repeat(32)}).to_string();
    let _ = c.ft_on_transfer(acct("bob.testnet"), U128(800_000), msg);
}

#[test]
#[should_panic(expected = "part id must match")]
fn part_id_cannot_contain_report_delimiters() {
    let mut c = setup();
    ctx("evil.testnet", 0);
    c.register_part("a,b".into(), "1".into(), U128(1), "h".into());
}

#[test]
#[should_panic(expected = "part id must match")]
fn part_id_cannot_contain_pipe() {
    let mut c = setup();
    ctx("evil.testnet", 0);
    c.register_part("a|b".into(), "1".into(), U128(1), "h".into());
}

#[test]
#[should_panic(expected = "recipe needs at least one part")]
fn publish_rejects_empty_parts() {
    let mut c = setup();
    ctx("creator.testnet", 0);
    c.publish_recipe("EMPTY".into(), "e".into(), "h".into(), acct("runner.testnet"), vec![], U128(100_000), 0, U128(10));
}

#[test]
#[should_panic(expected = "output_hash must be 64 lowercase hex")]
fn report_rejects_malformed_output_hash() {
    let mut c = setup();
    pay_run(&mut c, "buyer.testnet", "r1", 750_000, 0);
    let parts = all_parts();
    ctx("relayer.testnet", 0);
    c.report_run("r1".into(), "ok".into(), parts.clone(), "sha256:out".into(), U128(0), sign("r1", "CLNP", "ok", "sha256:out", &parts));
}

// ------------------------------------------------------ batch auctions

fn bid_at(c: &mut Contract, who: &str, price: u128, qty: u128, deposit: u128, ts: u64) {
    ctx(USDC, ts);
    let _ = c.ft_on_transfer(acct(who), U128(deposit), json!({"action":"bid","recipe_id":"CLNP","price":U128(price),"qty":U128(qty)}).to_string());
}

fn bid(c: &mut Contract, who: &str, price: u128, qty: u128, deposit: u128) {
    bid_at(c, who, price, qty, deposit, 0);
}

fn ask(c: &mut Contract, who: &str, price: u128, qty: u128, ts: u64) -> u64 {
    ctx(who, ts);
    c.place_ask("CLNP".into(), U128(price), U128(qty))
}

fn clear(c: &mut Contract, ts: u64) -> ClearSummary {
    ctx("keeper.testnet", ts);
    c.clear_batch("CLNP".into())
}

fn shares(c: &Contract, a: &str) -> (u128, u128) {
    let v = c.shares_of("CLNP".into(), acct(a));
    (v.shares.0, v.locked.0)
}

#[test]
fn auction_vectors_match_reference() {
    let v: serde_json::Value =
        serde_json::from_str(include_str!("../../test-vectors/batch-auction.json")).unwrap();
    let cases = v["cases"].as_array().unwrap();
    assert!(cases.len() >= 30);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let num = |x: &serde_json::Value| x.as_str().unwrap().parse::<u128>().unwrap();
        let orders: Vec<(AuctionOrder, String)> = case["orders"]
            .as_array()
            .unwrap()
            .iter()
            .map(|o| {
                (
                    AuctionOrder {
                        id: o["id"].as_u64().unwrap(),
                        side: if o["side"] == "Bid" { AuctionSide::Bid } else { AuctionSide::Ask },
                        price: num(&o["price"]),
                        qty: num(&o["qty"]),
                    },
                    o["owner"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        let plain: Vec<AuctionOrder> = orders.iter().map(|o| o.0.clone()).collect();
        let r = clear_auction(&plain);
        let e = &case["expected"];
        assert_eq!(r.price, e["price"].as_str().map(|p| p.parse::<u128>().unwrap()), "{name}: price");
        assert_eq!(r.volume, num(&e["volume"]), "{name}: volume");
        let fills: Vec<(u64, u128)> = r.fills.iter().map(|f| (f.order_id, f.qty)).collect();
        let want: Vec<(u64, u128)> = e["fills"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| (f["order_id"].as_u64().unwrap(), num(&f["qty"])))
            .collect();
        assert_eq!(fills, want, "{name}: fills");
        // per-owner credits and share deltas
        let owner_of = |id: u64| orders.iter().find(|o| o.0.id == id).unwrap().1.clone();
        let mut credits: std::collections::BTreeMap<String, u128> = Default::default();
        let mut deltas: std::collections::BTreeMap<String, i128> = Default::default();
        if let Some(p) = r.price {
            for f in &r.fills {
                let o = owner_of(f.order_id);
                match f.side {
                    AuctionSide::Bid => {
                        *credits.entry(o.clone()).or_default() += (f.limit - p) * f.qty;
                        *deltas.entry(o).or_default() += f.qty as i128;
                    }
                    AuctionSide::Ask => {
                        *credits.entry(o.clone()).or_default() += f.qty * p;
                        *deltas.entry(o).or_default() -= f.qty as i128;
                    }
                }
            }
        }
        credits.retain(|_, v| *v != 0);
        deltas.retain(|_, v| *v != 0);
        let want_c: std::collections::BTreeMap<String, u128> = e["credits"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), num(v)))
            .collect();
        let want_d: std::collections::BTreeMap<String, i128> = e["share_deltas"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap().parse::<i128>().unwrap()))
            .collect();
        assert_eq!(credits, want_c, "{name}: credits");
        assert_eq!(deltas, want_d, "{name}: share deltas");
    }
}

#[test]
fn orders_rest_until_the_batch_clears() {
    let mut c = setup();
    ask(&mut c, "creator.testnet", 100, 1_000, 0);
    bid(&mut c, "alice.testnet", 120, 1_000, 120_000);
    // nothing matched on placement
    assert_eq!(shares(&c, "alice.testnet"), (0, 0));
    assert_eq!(shares(&c, "creator.testnet"), (1_000_000, 1_000));
    let book = c.get_book("CLNP".into());
    assert_eq!((book.bids.len(), book.asks.len()), (1, 1));
    let ind = c.indicative_clearing("CLNP".into());
    assert_eq!((ind.price.map(|p| p.0), ind.volume.0), (Some(110), 1_000));
    let b = c.get_batch("CLNP".into()).unwrap();
    assert_eq!((b.id, b.opened_ns.0, b.closes_ns.0), (1, 0, INTERVAL));
}

#[test]
#[should_panic(expected = "batch still open")]
fn clear_before_interval_rejected() {
    let mut c = setup();
    clear(&mut c, INTERVAL - 1);
}

#[test]
fn opening_auction_clears_float_at_one_price_and_conserves_everything() {
    let mut c = setup();
    // creator offers a 20% float as a ladder; four bidders
    for k in 0..5u128 {
        ask(&mut c, "creator.testnet", 85_000 + k * 850, 40_000, 0);
    }
    bid(&mut c, "t1.testnet", 86_700, 3_000, 86_700 * 3_000);
    bid(&mut c, "t2.testnet", 86_700, 4_500, 86_700 * 4_500);
    bid(&mut c, "t3.testnet", 90_000, 6_000, 90_000 * 6_000);
    bid(&mut c, "t4.testnet", 84_000, 9_000, 84_000 * 9_000);
    let escrow_in: u128 = 86_700 * 7_500 + 90_000 * 6_000 + 84_000 * 9_000;
    let s = clear(&mut c, INTERVAL);
    let p = s.price.unwrap().0;
    assert_eq!(s.batch_id, 1);
    assert!((85_000..=86_700).contains(&p));
    let v = s.volume.0;
    assert_eq!(v, 13_500);
    assert_eq!(shares(&c, "t1.testnet").0 + shares(&c, "t2.testnet").0 + shares(&c, "t3.testnet").0, v);
    assert_eq!(shares(&c, "t4.testnet").0, 0, "bid below the clearing price does not fill");
    let (cs, cl) = shares(&c, "creator.testnet");
    assert_eq!(cs, 1_000_000 - v);
    assert_eq!(cl, 200_000 - v, "unfilled float stays locked");
    assert_eq!(bal(&c, "creator.testnet"), v * p);
    // tokens conserved: proceeds + refunds + escrow still resting == all deposits
    let resting: u128 = c.get_book("CLNP".into()).bids.iter().map(|o| o.price.0 * o.qty.0).sum();
    let paid_out = bal(&c, "creator.testnet") + bal(&c, "t1.testnet") + bal(&c, "t2.testnet") + bal(&c, "t3.testnet");
    assert_eq!(paid_out + resting, escrow_in);
    // the next batch opened at the clearing time
    let b = c.get_batch("CLNP".into()).unwrap();
    assert_eq!((b.id, b.opened_ns.0), (2, INTERVAL));
    assert_eq!(last_event()["event"], "batch_cleared");
}

#[test]
fn empty_batch_still_advances() {
    let mut c = setup();
    bid(&mut c, "alice.testnet", 50, 10, 500);
    let s = clear(&mut c, INTERVAL);
    assert!(s.price.is_none());
    assert_eq!(s.volume.0, 0);
    assert_eq!(c.get_batch("CLNP".into()).unwrap().id, 2);
    assert_eq!(c.get_book("CLNP".into()).bids.len(), 1, "unfilled orders rest into the next batch");
    let ev = last_event();
    assert_eq!(ev["event"], "batch_cleared");
    assert!(ev["data"][0]["price"].is_null());
}

#[test]
fn partial_fill_rests_and_clears_next_batch() {
    let mut c = setup();
    ask(&mut c, "creator.testnet", 100, 300, 0);
    let bid_id = c.next_order_id;
    bid(&mut c, "alice.testnet", 100, 500, 50_000);
    let s = clear(&mut c, INTERVAL);
    assert_eq!((s.price.unwrap().0, s.volume.0), (100, 300));
    let book = c.get_book("CLNP".into());
    assert_eq!(book.bids[0].id, bid_id, "partial keeps its id");
    assert_eq!(book.bids[0].qty.0, 200);
    ask(&mut c, "creator.testnet", 90, 200, INTERVAL + 1);
    let s2 = clear(&mut c, 2 * INTERVAL);
    assert_eq!(s2.batch_id, 2);
    assert_eq!(s2.volume.0, 200);
    assert_eq!(shares(&c, "alice.testnet").0, 500);
    assert!(c.get_book("CLNP".into()).bids.is_empty());
    assert!(c.order_index.get(&bid_id).is_none());
}

#[test]
fn cancel_returns_escrow() {
    let mut c = setup();
    bid(&mut c, "alice.testnet", 50, 100, 5_000);
    let bid_id = c.get_book("CLNP".into()).bids[0].id;
    ctx("alice.testnet", 0);
    c.cancel_order(bid_id);
    assert_eq!(bal(&c, "alice.testnet"), 5_000);

    let ask_id = ask(&mut c, "creator.testnet", 500, 10, 0);
    c.cancel_order(ask_id);
    assert_eq!(shares(&c, "creator.testnet").1, 0);
    let book = c.get_book("CLNP".into());
    assert!(book.bids.is_empty() && book.asks.is_empty());
    // cancelled orders take no part in the clearing
    let s = clear(&mut c, INTERVAL);
    assert!(s.price.is_none());
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
    ask(&mut c, "creator.testnet", 100, 1_000_000, 0);
    c.transfer_shares("CLNP".into(), acct("bob.testnet"), U128(1));
}

#[test]
fn book_full_rejects_orders() {
    let mut c = setup();
    for _ in 0..MAX_ORDERS_PER_BOOK {
        bid(&mut c, "spam.testnet", 1, 1, 1);
    }
    // direct transfer panics (token refunds sender) ...
    ctx(USDC, 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = c.ft_on_transfer(acct("alice.testnet"), U128(10), json!({"action":"bid","recipe_id":"CLNP","price":"10","qty":"1"}).to_string());
    }));
    assert!(r.is_err());
    // ... while an Intents delivery credits the buyer
    ctx(USDC, 0);
    let _ = c.ft_on_transfer(acct("solver.testnet"), U128(10), json!({"action":"bid","recipe_id":"CLNP","price":"10","qty":"1","on_behalf_of":"bob.testnet"}).to_string());
    assert_eq!(bal(&c, "bob.testnet"), 10);
    let ev = last_event();
    assert_eq!(ev["event"], "transfer_rejected");
    assert_eq!(ev["data"][0]["reason"], "order book full");
}

#[test]
#[should_panic(expected = "order book full")]
fn book_full_rejects_asks() {
    let mut c = setup();
    for _ in 0..MAX_ORDERS_PER_BOOK {
        bid(&mut c, "spam.testnet", 1, 1, 1);
    }
    ask(&mut c, "creator.testnet", 100, 1, 0);
}

#[test]
fn trading_shares_harvests_dividends_correctly() {
    let mut c = setup();
    let b = all_parts();
    // run 1: creator owns 100%
    pay_run(&mut c, "buyer.testnet", "r1", 750_000, 0);
    ctx("relayer.testnet", 0);
    c.report_run("r1".into(), "ok".into(), b.clone(), OUT.into(), U128(0), sign("r1", "CLNP", "ok", OUT, &b));

    // creator offers 25% in the batch; locked shares keep earning through run 2
    ask(&mut c, "creator.testnet", 1, 250_000, 0);
    bid(&mut c, "alice.testnet", 1, 250_000, 250_000);
    pay_run(&mut c, "buyer.testnet", "r2", 750_000, 0);
    ctx("relayer.testnet", 0);
    c.report_run("r2".into(), "ok".into(), b.clone(), OUT.into(), U128(0), sign("r2", "CLNP", "ok", OUT, &b));
    let s = clear(&mut c, INTERVAL);
    assert_eq!((s.price.unwrap().0, s.volume.0), (1, 250_000));

    // run 3: 75/25 split
    pay_run(&mut c, "buyer.testnet", "r3", 750_000, INTERVAL);
    ctx("relayer.testnet", INTERVAL);
    c.report_run("r3".into(), "ok".into(), b.clone(), OUT.into(), U128(0), sign("r3", "CLNP", "ok", OUT, &b));

    let pool = 508_500u128;
    let creator_div = bal(&c, "creator.testnet") - 3 * 56_500 - 250_000
        + c.pending_dividends("CLNP".into(), acct("creator.testnet")).0;
    assert_eq!(creator_div, 2 * pool + pool * 3 / 4);
    assert_eq!(c.pending_dividends("CLNP".into(), acct("alice.testnet")).0, pool / 4);
    assert_eq!(creator_div + pool / 4, 3 * pool);
}

#[test]
fn signed_message_format_is_stable() {
    let m = run_report_message("frs.testnet", "r-1", "CLNP", "ok", "sha256:ab", 28_024_900, &["a".into(), "b".into()]);
    assert_eq!(m, "frs-run-v3|frs.testnet|r-1|CLNP|ok|sha256:ab|28024900|a,b");
    let m = run_report_message("frs.testnet", "r-1", "CLNP", "abort", "sha256:ab", 0, &[]);
    assert_eq!(m, "frs-run-v3|frs.testnet|r-1|CLNP|abort|sha256:ab|0|");
    let q = quote_message(
        "frs.testnet",
        "CLNP",
        "sha256:sealed",
        &"ab".repeat(32),
        &"ff".repeat(32),
        "bob.testnet",
        28_000_000,
        27_500_000,
        25_000_000,
        1_000,
    );
    assert_eq!(
        q,
        format!(
            "frs-quote-v2|frs.testnet|CLNP|sha256:sealed|{}|{}|bob.testnet|28000000|27500000|25000000|1000",
            "ab".repeat(32),
            "ff".repeat(32)
        )
    );
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

// ------------------------------------------------------- v3: quotes & bonds

const JOB: &str = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
const SEALED: &str = "sha256:sealed";

/// Everything a quote binds; `Q::new` is a valid quote for bob's default inputs.
#[derive(Clone)]
struct Q {
    key: SigningKey,
    sealed_hash: String,
    job_hash: String,
    inputs_hash: String,
    buyer: String,
    expected: u128,
    promised: u128,
    cover: u128,
    expires_ns: u64,
}

impl Q {
    fn new(promised: u128, cover: u128) -> Self {
        Q {
            key: signing_key(),
            sealed_hash: SEALED.into(),
            job_hash: JOB.into(),
            inputs_hash: "ff".repeat(32),
            buyer: "bob.testnet".into(),
            expected: promised + promised / 10,
            promised,
            cover,
            expires_ns: 10_000,
        }
    }
    fn json(&self) -> serde_json::Value {
        let m = quote_message(
            CONTRACT,
            "CLNP",
            &self.sealed_hash,
            &self.job_hash,
            &self.inputs_hash,
            &self.buyer,
            self.expected,
            self.promised,
            self.cover,
            self.expires_ns,
        );
        let sig = near_sdk::base64::Engine::encode(
            &near_sdk::base64::engine::general_purpose::STANDARD,
            self.key.sign(m.as_bytes()).to_bytes(),
        );
        json!({
            "sealed_hash": self.sealed_hash,
            "job_hash": self.job_hash,
            "expected": U128(self.expected),
            "promised": U128(self.promised),
            "cover": U128(self.cover),
            "expires_ns": U64(self.expires_ns),
            "signature": sig,
        })
    }
}

fn post_bond(c: &mut Contract, from: &str, amount: u128) {
    if amount == 0 {
        return;
    }
    ctx(USDC, 0);
    let msg = json!({"action":"bond","recipe_id":"CLNP"}).to_string();
    let _ = c.ft_on_transfer(acct(from), U128(amount), msg);
}

/// Direct payment by `buyer` (a rejected quote panics).
fn pay_quoted(c: &mut Contract, buyer: &str, run_id: &str, q: &Q, ts: u64) {
    ctx(USDC, ts);
    let msg = json!({"action":"run","recipe_id":"CLNP","run_id":run_id,"inputs_hash":"ff".repeat(32),"quote":q.json()});
    let _ = c.ft_on_transfer(acct(buyer), U128(750_000), msg.to_string());
}

/// Payment by a solver on behalf of `buyer`; returns the rejection reason, if any.
fn solver_pays(c: &mut Contract, buyer: &str, run_id: &str, inputs_hash: &str, q: &Q, ts: u64) -> Option<String> {
    ctx(USDC, ts);
    let msg = json!({"action":"run","recipe_id":"CLNP","run_id":run_id,"inputs_hash":inputs_hash,"on_behalf_of":buyer,"quote":q.json()});
    let _ = c.ft_on_transfer(acct("solver.testnet"), U128(750_000), msg.to_string());
    let e = last_event();
    if e["event"] == "transfer_rejected" {
        Some(e["data"][0]["reason"].as_str().unwrap().to_string())
    } else {
        assert_eq!(e["event"], "run_requested");
        None
    }
}

fn report(c: &mut Contract, run_id: &str, outcome: &str, delivered: u128) {
    let parts = if outcome == "ok" { all_parts() } else { vec![] };
    let m = run_report_message(CONTRACT, run_id, "CLNP", outcome, OUT, delivered, &parts);
    let sig = Base64VecU8(signing_key().sign(m.as_bytes()).to_bytes().to_vec());
    ctx("relayer.testnet", 1);
    c.report_run(run_id.into(), outcome.into(), parts, OUT.into(), U128(delivered), sig);
}

#[test]
fn bond_vectors_end_to_end() {
    let v: serde_json::Value = serde_json::from_str(include_str!("../../test-vectors/bonds.json")).unwrap();
    let cases = v["cases"].as_array().unwrap().clone();
    assert_eq!(cases.len(), 7);
    for case in cases {
        // fresh mocked blockchain (thread-local storage) per case
        std::thread::spawn(move || bond_case(&case)).join().expect("bond case failed");
    }
}

fn bond_case(case: &serde_json::Value) {
    let p = |x: &serde_json::Value| x.as_str().unwrap().parse::<u128>().unwrap();
    let name = case["name"].as_str().unwrap();
    let i = &case["input"];
    let e = &case["expected"];
    let outcome = i["outcome"].as_str().unwrap();
    let mut c = setup();
    post_bond(&mut c, "creator.testnet", p(&i["bond_available"]));
    let q = Q::new(p(&i["promised"]), p(&i["cover"]));
    pay_quoted(&mut c, "bob.testnet", "r1", &q, 0);
    let run = c.get_run("r1".into()).unwrap();
    assert_eq!(run.covered.0, p(&e["covered"]), "{name}: covered");
    assert_eq!(run.promised.0, q.promised, "{name}: promised");
    assert_eq!(run.expected.0, q.expected, "{name}: expected");
    let r = c.get_recipe("CLNP".into()).unwrap();
    assert_eq!(r.bond_locked.0, p(&e["covered"]), "{name}: cover locked at payment");
    let before = bal(&c, "bob.testnet");
    report(&mut c, "r1", outcome, p(&i["delivered"]));
    let refund = if outcome == "ok" { 0 } else { 750_000 };
    assert_eq!(bal(&c, "bob.testnet") - before, p(&e["compensation"]) + refund, "{name}: buyer credit");
    let r = c.get_recipe("CLNP".into()).unwrap();
    assert_eq!(r.bond_available.0, p(&e["bond_available_after"]), "{name}: bond_available");
    assert_eq!(r.bond_locked.0, p(&e["bond_locked_after"]), "{name}: bond_locked");
    assert_eq!(r.compensated_total.0, p(&e["compensation"]), "{name}: compensated_total");
    let expect = |o: &str| u64::from(outcome == o);
    assert_eq!((r.runs, r.failed, r.aborted), (expect("ok"), expect("fail"), expect("abort")), "{name}: track record");
    if outcome != "ok" {
        let ev = last_event();
        assert_eq!(ev["event"], "run_refunded");
        let reason = if outcome == "fail" { "runner_reported_failure" } else { "runner_aborted" };
        assert_eq!(ev["data"][0]["reason"], reason, "{name}: refund reason");
    }
}

/// Each v3 rejection, triggered on its own with every earlier check passing.
#[test]
fn quote_rejection_reasons() {
    let ff = "ff".repeat(32);
    let ok = Q::new(1_000_000, 1_000_000);

    // 1. job_hash
    let mut c = setup();
    post_bond(&mut c, "creator.testnet", 5_000_000);
    let q = Q { job_hash: "XYZ".into(), ..ok.clone() };
    assert_eq!(solver_pays(&mut c, "bob.testnet", "r1", &ff, &q, 0).as_deref(), Some("job_hash must be 64 lowercase hex"));

    // 2. outdated recipe version: quote made before update_sealed
    ctx("creator.testnet", 0);
    c.update_sealed("CLNP".into(), "sha256:sealed-v2".into());
    assert_eq!(solver_pays(&mut c, "bob.testnet", "r1", &ff, &ok, 0).as_deref(), Some("quote for an outdated recipe version"));
    let fresh = Q { sealed_hash: "sha256:sealed-v2".into(), ..ok.clone() };
    assert_eq!(solver_pays(&mut c, "bob.testnet", "r1", &ff, &fresh, 0), None, "re-quoted for the new version");

    // 3. runner inactive
    let mut c = setup();
    post_bond(&mut c, "creator.testnet", 5_000_000);
    ctx("owner.testnet", 0);
    c.set_runner_active(acct("runner.testnet"), false);
    assert_eq!(solver_pays(&mut c, "bob.testnet", "r1", &ff, &ok, 0).as_deref(), Some("runner inactive"));

    // 4. wrong key
    let mut c = setup();
    post_bond(&mut c, "creator.testnet", 5_000_000);
    let q = Q { key: SigningKey::from_bytes(&[9u8; 32]), ..ok.clone() };
    assert_eq!(solver_pays(&mut c, "bob.testnet", "r1", &ff, &q, 0).as_deref(), Some("invalid quote signature"));

    // 5. expired
    let q = Q { expires_ns: 500, ..ok.clone() };
    assert_eq!(solver_pays(&mut c, "bob.testnet", "r1", &ff, &q, 501).as_deref(), Some("quote expired"));
    assert_eq!(solver_pays(&mut c, "bob.testnet", "r1", &ff, &q, 500), None, "valid up to and including expires_ns");

    // 6. reused (same quote, new run_id)
    assert_eq!(solver_pays(&mut c, "bob.testnet", "r2", &ff, &q, 0).as_deref(), Some("quote already used"));

    // 7. cover > promise
    let q = Q { promised: 1_000_000, cover: 1_000_001, ..ok.clone() };
    assert_eq!(solver_pays(&mut c, "bob.testnet", "r3", &ff, &q, 0).as_deref(), Some("cover exceeds promise"));

    // 8. bond below cover after the creator withdraws
    let mut c = setup();
    post_bond(&mut c, "creator.testnet", 5_000_000);
    ctx("creator.testnet", 0);
    c.withdraw_bond("CLNP".into(), U128(4_500_000));
    assert_eq!(solver_pays(&mut c, "bob.testnet", "r1", &ff, &ok, 0).as_deref(), Some("bond below quoted cover"));
    let q = Q { cover: 500_000, ..ok.clone() };
    assert_eq!(solver_pays(&mut c, "bob.testnet", "r1", &ff, &q, 0), None, "cover that fits the bond");

    // every rejection credited the buyer and left no run or locked bond behind
    assert_eq!(bal(&c, "bob.testnet"), 750_000);
    assert_eq!(c.get_recipe("CLNP".into()).unwrap().bond_locked.0, 500_000);
}

/// When several checks fail at once, the earliest in the spec order wins.
#[test]
fn quote_rejection_order() {
    let ff = "ff".repeat(32);
    let ok = Q::new(1_000_000, 1_000_000);
    let wrong_key = SigningKey::from_bytes(&[9u8; 32]);
    let mut c = setup();
    post_bond(&mut c, "creator.testnet", 1_500_000);
    // 1 before 2
    let q = Q { job_hash: "XYZ".into(), sealed_hash: "sha256:old".into(), ..ok.clone() };
    assert_eq!(solver_pays(&mut c, "bob.testnet", "r1", &ff, &q, 0).as_deref(), Some("job_hash must be 64 lowercase hex"));
    // 2 before 3
    ctx("owner.testnet", 0);
    c.set_runner_active(acct("runner.testnet"), false);
    let q = Q { sealed_hash: "sha256:old".into(), ..ok.clone() };
    assert_eq!(solver_pays(&mut c, "bob.testnet", "r1", &ff, &q, 0).as_deref(), Some("quote for an outdated recipe version"));
    // 3 before 4
    let q = Q { key: wrong_key.clone(), ..ok.clone() };
    assert_eq!(solver_pays(&mut c, "bob.testnet", "r1", &ff, &q, 0).as_deref(), Some("runner inactive"));
    ctx("owner.testnet", 0);
    c.set_runner_active(acct("runner.testnet"), true);
    // 4 before 5
    let q = Q { key: wrong_key, expires_ns: 1, ..ok.clone() };
    assert_eq!(solver_pays(&mut c, "bob.testnet", "r1", &ff, &q, 2).as_deref(), Some("invalid quote signature"));
    // use a quote, then: 5 before 6
    assert_eq!(solver_pays(&mut c, "bob.testnet", "r1", &ff, &ok, 0), None);
    assert_eq!(solver_pays(&mut c, "bob.testnet", "r2", &ff, &ok, 10_001).as_deref(), Some("quote expired"));
    // 6 before 8 (bond is now 500_000 < cover)
    assert_eq!(solver_pays(&mut c, "bob.testnet", "r2", &ff, &ok, 0).as_deref(), Some("quote already used"));
    // 7 before 8
    let q = Q { promised: 600_000, cover: 700_000, ..ok.clone() };
    assert_eq!(solver_pays(&mut c, "bob.testnet", "r2", &ff, &q, 0).as_deref(), Some("cover exceeds promise"));
}

#[test]
#[should_panic(expected = "quote expired")]
fn expired_quote_panics_on_direct_payment() {
    let mut c = setup();
    post_bond(&mut c, "creator.testnet", 5_000_000);
    pay_quoted(&mut c, "bob.testnet", "r1", &Q { expires_ns: 500, ..Q::new(1, 1) }, 501);
}

#[test]
#[should_panic(expected = "invalid msg")]
fn malformed_quote_object_panics_at_parse() {
    let mut c = setup();
    ctx(USDC, 0);
    let mut quote = Q::new(1, 1).json();
    quote["cover"] = json!(1); // numbers must be decimal strings
    let msg = json!({"action":"run","recipe_id":"CLNP","run_id":"r1","inputs_hash":"ff".repeat(32),"on_behalf_of":"bob.testnet","quote":quote});
    let _ = c.ft_on_transfer(acct("solver.testnet"), U128(750_000), msg.to_string());
}

#[test]
fn quote_is_bound_to_buyer() {
    let ff = "ff".repeat(32);
    let mut c = setup();
    post_bond(&mut c, "creator.testnet", 5_000_000);
    let q = Q::new(1_000_000, 1_000_000); // signed for bob
    // a solver paying the same quote on behalf of carol
    assert_eq!(solver_pays(&mut c, "carol.testnet", "r1", &ff, &q, 0).as_deref(), Some("invalid quote signature"));
    assert_eq!(bal(&c, "carol.testnet"), 750_000);
    // carol paying directly with bob's quote
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| pay_quoted(&mut c, "carol.testnet", "r2", &q, 0))).is_err());
    // bob can still use it (rejections don't consume the quote)
    assert_eq!(solver_pays(&mut c, "bob.testnet", "r3", &ff, &q, 0), None);
}

#[test]
fn quote_is_bound_to_inputs_hash() {
    let mut c = setup();
    post_bond(&mut c, "creator.testnet", 5_000_000);
    let q = Q::new(1_000_000, 1_000_000); // signed for inputs "ff…"
    let other_inputs = "ee".repeat(32);
    assert_eq!(solver_pays(&mut c, "bob.testnet", "r1", &other_inputs, &q, 0).as_deref(), Some("invalid quote signature"));
    let q2 = Q { inputs_hash: other_inputs.clone(), ..q };
    assert_eq!(solver_pays(&mut c, "bob.testnet", "r1", &other_inputs, &q2, 0), None);
}

#[test]
fn abort_does_not_count_as_failure() {
    let mut c = setup();
    post_bond(&mut c, "creator.testnet", 5_000_000);
    pay_quoted(&mut c, "bob.testnet", "r1", &Q::new(2_000_000, 2_000_000), 0);
    report(&mut c, "r1", "abort", 0);
    let r = c.get_recipe("CLNP".into()).unwrap();
    assert_eq!((r.runs, r.failed, r.aborted), (0, 0, 1));
    assert_eq!((r.bond_available.0, r.bond_locked.0), (5_000_000, 0));
    assert_eq!(bal(&c, "bob.testnet"), 750_000);
    assert_eq!(c.get_run("r1".into()).unwrap().status, RunStatus::Refunded);
    // unquoted runs can be aborted too
    pay_run(&mut c, "bob.testnet", "r2", 750_000, 0);
    report(&mut c, "r2", "abort", 0);
    assert_eq!(c.get_recipe("CLNP".into()).unwrap().aborted, 2);
}

#[test]
#[should_panic(expected = "invalid outcome")]
fn unknown_outcome_rejected() {
    let mut c = setup();
    pay_run(&mut c, "bob.testnet", "r1", 750_000, 0);
    let m = run_report_message(CONTRACT, "r1", "CLNP", "success", OUT, 0, &[]);
    let sig = Base64VecU8(signing_key().sign(m.as_bytes()).to_bytes().to_vec());
    ctx("relayer.testnet", 1);
    c.report_run("r1".into(), "success".into(), vec![], OUT.into(), U128(0), sig);
}

#[test]
#[should_panic(expected = "invalid runner signature")]
fn report_outcome_is_signed() {
    let mut c = setup();
    pay_run(&mut c, "bob.testnet", "r1", 750_000, 0);
    // signed as a failure, submitted as an abort
    let m = run_report_message(CONTRACT, "r1", "CLNP", "fail", OUT, 0, &[]);
    let sig = Base64VecU8(signing_key().sign(m.as_bytes()).to_bytes().to_vec());
    ctx("relayer.testnet", 1);
    c.report_run("r1".into(), "abort".into(), vec![], OUT.into(), U128(0), sig);
}

#[test]
fn bond_from_unknown_recipe_with_on_behalf_of_credited() {
    let mut c = setup();
    ctx(USDC, 0);
    let msg = json!({"action":"bond","recipe_id":"NOPE","on_behalf_of":"creator.testnet"}).to_string();
    let _ = c.ft_on_transfer(acct("solver.testnet"), U128(5), msg);
    assert_eq!(bal(&c, "creator.testnet"), 5);
}

#[test]
fn withdraw_bond_limits() {
    let mut c = setup();
    post_bond(&mut c, "creator.testnet", 10_000_000);
    pay_quoted(&mut c, "bob.testnet", "r1", &Q::new(6_000_000, 6_000_000), 0);
    let r = c.get_recipe("CLNP".into()).unwrap();
    assert_eq!((r.bond_available.0, r.bond_locked.0), (4_000_000, 6_000_000));
    // non-creator
    ctx("bob.testnet", 0);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.withdraw_bond("CLNP".into(), U128(1)))).is_err());
    // locked part not withdrawable
    ctx("creator.testnet", 0);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.withdraw_bond("CLNP".into(), U128(4_000_001)))).is_err());
    ctx("creator.testnet", 0);
    c.withdraw_bond("CLNP".into(), U128(4_000_000));
    assert_eq!(bal(&c, "creator.testnet"), 4_000_000);
    assert_eq!(c.get_recipe("CLNP".into()).unwrap().bond_available.0, 0);
}

#[test]
fn reclaim_releases_cover_and_counts_failure() {
    let mut c = setup();
    post_bond(&mut c, "creator.testnet", 10_000_000);
    pay_quoted(&mut c, "bob.testnet", "r1", &Q { expires_ns: u64::MAX, ..Q::new(6_000_000, 6_000_000) }, 0);
    ctx("bob.testnet", RUN_TIMEOUT_NS);
    c.reclaim_run("r1".into());
    let r = c.get_recipe("CLNP".into()).unwrap();
    assert_eq!((r.bond_available.0, r.bond_locked.0, r.failed, r.aborted), (10_000_000, 0, 1, 0));
    assert_eq!(last_event()["data"][0]["reason"], "timeout");
}

#[test]
fn track_record_counts_only_successful_quoted_runs() {
    let mut c = setup();
    post_bond(&mut c, "creator.testnet", 25_000_000);
    pay_quoted(&mut c, "bob.testnet", "r1", &Q { job_hash: "c1".repeat(32), ..Q::new(27_500_000, 25_000_000) }, 0);
    report(&mut c, "r1", "ok", 28_000_000);
    pay_quoted(&mut c, "bob.testnet", "r2", &Q { job_hash: "c2".repeat(32), ..Q::new(10_000_000, 10_000_000) }, 0);
    report(&mut c, "r2", "ok", 7_000_000);
    pay_quoted(&mut c, "bob.testnet", "r3", &Q { job_hash: "c3".repeat(32), ..Q::new(5_000_000, 5_000_000) }, 0);
    report(&mut c, "r3", "fail", 0);
    pay_quoted(&mut c, "bob.testnet", "r4", &Q { job_hash: "c4".repeat(32), ..Q::new(5_000_000, 5_000_000) }, 0);
    report(&mut c, "r4", "abort", 0);
    pay_run(&mut c, "bob.testnet", "r5", 750_000, 0);
    report(&mut c, "r5", "ok", 99_000_000); // unquoted: excluded from promise stats
    let r = c.get_recipe("CLNP".into()).unwrap();
    assert_eq!((r.runs, r.failed, r.aborted), (3, 1, 1));
    assert_eq!(r.promised_total.0, 37_500_000);
    assert_eq!(r.delivered_total.0, 35_000_000);
    assert_eq!(r.compensated_total.0, 3_000_000);
    assert_eq!(r.bond_available.0, 22_000_000);
    assert_eq!(r.bond_locked.0, 0);
}

#[test]
fn payout_roles_name_parts() {
    let mut c = setup();
    pay_run(&mut c, "bob.testnet", "r1", 750_000, 0);
    let parts = all_parts();
    let m = run_report_message(CONTRACT, "r1", "CLNP", "ok", OUT, 0, &parts);
    let sig = Base64VecU8(signing_key().sign(m.as_bytes()).to_bytes().to_vec());
    ctx("relayer.testnet", 1);
    let payouts = c.report_run("r1".into(), "ok".into(), parts, OUT.into(), U128(0), sig);
    let roles: Vec<String> = payouts.iter().map(|p| p.role.clone()).collect();
    assert_eq!(roles[0], "protocol");
    assert_eq!(roles[1], "runner");
    assert_eq!(roles[2], "part:wallet-scanner");
    assert_eq!(roles.last().unwrap(), "creator_royalty");
}

#[test]
#[should_panic(expected = "invalid runner signature")]
fn report_signed_with_wrong_delivered_rejected() {
    let mut c = setup();
    pay_run(&mut c, "bob.testnet", "r1", 750_000, 0);
    let parts = all_parts();
    let m = run_report_message(CONTRACT, "r1", "CLNP", "ok", OUT, 1, &parts);
    let sig = Base64VecU8(signing_key().sign(m.as_bytes()).to_bytes().to_vec());
    ctx("relayer.testnet", 1);
    c.report_run("r1".into(), "ok".into(), parts, OUT.into(), U128(2), sig);
}

#[test]
fn recipe_published_event_includes_aborted() {
    let _c = setup();
    let ev = last_event();
    assert_eq!(ev["event"], "recipe_published");
    assert_eq!(ev["data"][0]["aborted"], 0);
    assert_eq!(ev["data"][0]["failed"], 0);
}

#[test]
fn run_requested_event_includes_expected() {
    let mut c = setup();
    post_bond(&mut c, "creator.testnet", 5_000_000);
    let q = Q::new(1_000_000, 1_000_000);
    pay_quoted(&mut c, "bob.testnet", "r1", &q, 0);
    let ev = last_event();
    assert_eq!(ev["event"], "run_requested");
    let d = &ev["data"][0];
    assert_eq!(d["expected"], q.expected.to_string());
    assert_eq!(d["promised"], "1000000");
    assert_eq!(d["covered"], "1000000");
}

// ------------------------------------------------- conformance with the proved models (verification/smt)

fn n(x: &serde_json::Value) -> u128 {
    x.as_str().unwrap().parse::<u128>().unwrap()
}

#[test]
fn conformance_settlement_matches_proved_model() {
    let v: serde_json::Value =
        serde_json::from_str(include_str!("../../test-vectors/conformance-money.json")).unwrap();
    let cases = v["settlement"].as_array().unwrap();
    assert!(cases.len() >= 300);
    for (k, case) in cases.iter().enumerate() {
        let i = &case["input"];
        let fees: Vec<u128> = i["part_fees"].as_array().unwrap().iter().map(n).collect();
        let s = settlement_split(
            n(&i["price"]),
            i["protocol_fee_bps"].as_u64().unwrap() as u16,
            n(&i["runner_fee"]),
            &fees,
            i["royalty_bps"].as_u64().unwrap() as u16,
            n(&i["total_shares"]),
            n(&i["acc_before"]),
        );
        let e = &case["expected"];
        match s {
            None => assert!(e.is_null(), "case {k}: Rust returned None, model returned a split"),
            Some(s) => {
                assert!(!e.is_null(), "case {k}: Rust returned a split, model returned None");
                assert_eq!(s.protocol, n(&e["protocol"]), "case {k} protocol");
                assert_eq!(s.remainder, n(&e["remainder"]), "case {k} remainder");
                assert_eq!(s.creator, n(&e["creator"]), "case {k} creator");
                assert_eq!(s.pool, n(&e["pool"]), "case {k} pool");
                assert_eq!(s.acc_increment, n(&e["acc_increment"]), "case {k} acc_increment");
                assert_eq!(s.distributed, n(&e["distributed"]), "case {k} distributed");
                assert_eq!(s.dust_to_protocol, n(&e["dust"]), "case {k} dust");
            }
        }
    }
}

#[test]
fn conformance_bonds_and_dividends_match_proved_model() {
    let v: serde_json::Value =
        serde_json::from_str(include_str!("../../test-vectors/conformance-money.json")).unwrap();
    for (k, c) in v["bonds"].as_array().unwrap().iter().enumerate() {
        let b = bond::Bond { available: n(&c["available"]), locked: n(&c["locked"]) };
        let x = n(&c["amount"]);
        let e = &c["expected"];
        let got: Option<(bond::Bond, Option<u128>)> = match c["op"].as_str().unwrap() {
            "lock" => bond::lock(b, x).map(|b| (b, None)),
            "release" => bond::release(b, x).map(|b| (b, None)),
            _ => bond::settle(b, x, n(&c["promised"]), n(&c["delivered"])).map(|(b, comp)| (b, Some(comp))),
        };
        match got {
            None => assert!(e.is_null(), "bond case {k}: Rust None, model Some"),
            Some((b, comp)) => {
                assert!(!e.is_null(), "bond case {k}: Rust Some, model None");
                assert_eq!(b.available, n(&e["available"]), "bond case {k} available");
                assert_eq!(b.locked, n(&e["locked"]), "bond case {k} locked");
                if let Some(comp) = comp {
                    assert_eq!(comp, n(&e["compensation"]), "bond case {k} compensation");
                }
            }
        }
    }
    for (k, c) in v["dividends"].as_array().unwrap().iter().enumerate() {
        let (s, a, d) = (n(&c["shares"]), n(&c["acc"]), n(&c["debt"]));
        let e = &c["expected"];
        assert_eq!(dividends::pending(s, d, a), n(&e["pending"]), "div case {k} pending");
        assert_eq!(dividends::harvest(s, d, a), (n(&e["harvest_paid"]), n(&e["harvest_debt"])), "div case {k} harvest");
        assert_eq!(dividends::rebase(s, a), n(&e["rebase"]), "div case {k} rebase");
    }
}

#[test]
fn conformance_auction_matches_proved_encoding() {
    let v: serde_json::Value =
        serde_json::from_str(include_str!("../../test-vectors/conformance-auction.json")).unwrap();
    for (k, c) in v["cases"].as_array().unwrap().iter().enumerate() {
        let orders: Vec<AuctionOrder> = c["orders"]
            .as_array()
            .unwrap()
            .iter()
            .map(|o| AuctionOrder {
                id: o["id"].as_u64().unwrap(),
                side: if o["side"] == "bid" { AuctionSide::Bid } else { AuctionSide::Ask },
                price: n(&o["price"]),
                qty: n(&o["qty"]),
            })
            .collect();
        let r = clear_auction(&orders);
        let e = &c["expected"];
        assert_eq!(r.price, e["price"].as_str().map(|p| p.parse::<u128>().unwrap()), "auction {k} price");
        assert_eq!(r.volume, n(&e["volume"]), "auction {k} volume");
        let mut got: Vec<(String, u128)> = r.fills.iter().map(|f| (f.order_id.to_string(), f.qty)).collect();
        got.sort();
        let mut want: Vec<(String, u128)> =
            e["fills"].as_object().unwrap().iter().map(|(id, q)| (id.clone(), n(q))).collect();
        want.sort();
        assert_eq!(got, want, "auction {k} fills");
    }
}

/// The two insolvency scenarios the proofs found in the previous rules, replayed through the real contract
/// (one test each: the mocked chain keeps storage per test thread).
#[test]
fn solvency_two_runs_rounding() {
    solvency_case("two-runs-rounding");
}

#[test]
fn solvency_transfer_rebase_rounding() {
    solvency_case("transfer-rebase-rounding");
}

fn solvency_case(want: &str) {
    let v: serde_json::Value = serde_json::from_str(include_str!("../../test-vectors/solvency.json")).unwrap();
    for case in v["cases"].as_array().unwrap().iter().filter(|c| c["name"] == want) {
        let name = case["name"].as_str().unwrap();
        let r = &case["recipe"];
        ctx("owner.testnet", 0);
        let mut c = Contract::new(acct("owner.testnet"), acct(USDC), acct("protocol.testnet"), 0, U64(INTERVAL));
        c.add_runner(acct("runner.testnet"), runner_pk_string(), "00".repeat(32), "x".into(), U128(0));
        ctx("author", 0);
        c.register_part("noop".into(), "1".into(), U128(0), "h".into());
        ctx("creator", 0);
        c.publish_recipe("SOLV".into(), "s".into(), "h".into(), acct("runner.testnet"), vec!["noop".into()], U128(n(&r["price"])), 0, U128(n(&r["total_shares"])));
        let mut k = 0;
        for step in case["steps"].as_array().unwrap() {
            if step["op"] == "run" {
                k += 1;
                let id = format!("run-{k}");
                ctx(USDC, 0);
                let _ = c.ft_on_transfer(acct("buyer"), U128(n(&r["price"])), json!({"action":"run","recipe_id":"SOLV","run_id":id,"inputs_hash":"aa".repeat(32)}).to_string());
                ctx("relayer", 0);
                c.report_run(id.clone(), "ok".into(), vec!["noop".into()], OUT.into(), U128(0), sign(&id, "SOLV", "ok", OUT, &["noop".to_string()]));
            } else {
                ctx(step["from"].as_str().unwrap(), 0);
                c.transfer_shares("SOLV".into(), acct(step["to"].as_str().unwrap()), U128(n(&step["qty"])));
            }
        }
        let mut owed = bal(&c, "protocol.testnet");
        assert_eq!(owed, n(&case["expected_protocol"]), "{name}: protocol");
        for (who, want) in case["expected_holders"].as_object().unwrap() {
            let got = bal(&c, who) + c.pending_dividends("SOLV".into(), acct(who)).0;
            assert_eq!(got, n(want), "{name}: {who}");
            owed += got;
        }
        assert!(owed <= n(&case["paid_in"]), "{name}: contract owes {owed} but received {}", n(&case["paid_in"]));
    }
}
