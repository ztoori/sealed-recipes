use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const CONTRACT: &str = "srs.testnet";
const USDC: &str = "usdc.testnet";
const DELAY: u64 = 60_000_000_000;
/// Pricing period in the tests (1 hour), so DELAY-scale timestamps stay inside the first period.
const PERIOD: u64 = 3_600_000_000_000;
const V2: &str = "2222222222222222222222222222222222222222222222222222222222222222";
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

/// Context for `register_part` / `publish_recipe`, which charge the caller for storage.
fn ctx_storage(predecessor: &str, ts: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acct(CONTRACT))
        .predecessor_account_id(acct(predecessor))
        .signer_account_id(acct(predecessor))
        .block_timestamp(ts)
        .attached_deposit(NearToken::from_millinear(100));
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
    // Fresh storage: `register_part` / `publish_recipe` flush to storage (to measure the bytes they
    // charge for), so a second `setup()` in the same test must not see the first one's entries.
    ctx("owner.testnet", 0);
    near_sdk::mock::with_mocked_blockchain(|b| {
        b.take_storage();
    });
    let mut c = Contract::new(acct("owner.testnet"), acct(USDC), acct("protocol.testnet"), 200, U64(DELAY), U64(PERIOD));
    c.add_runner(
        acct("runner.testnet"),
        runner_pk_string(),
        "ab".repeat(32),
        "sha256:compose".into(),
        U128(30_000),
    );
    for (id, author, fee) in PARTS {
        ctx_storage(author, 0);
        c.register_part(id.into(), "1.0.0".into(), U128(fee), format!("sha256:{id}"));
    }
    ctx_storage("creator.testnet", 0);
    c.publish_recipe(
        "CLNP".into(),
        "Clean up and protect".into(),
        "sha256:sealed".into(),
        acct("runner.testnet"),
        PARTS.iter().map(|b| b.0.to_string()).collect(),
        U128(750_000),
        0,
        None,
        None,
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
    assert!((6..=8).contains(&cases.len()));
    for case in cases {
        let i = &case["input"];
        let e = &case["expected"];
        let name = case["name"].as_str().unwrap();
        let fees: Vec<u128> = i["part_fees"].as_array().unwrap().iter().map(p).collect();
        let s = settlement_split(
            p(&i["price"]),
            i["protocol_fee_bps"].as_u64().unwrap() as u16,
            p(&i["runner_fee"]),
            &fees,
            i["reserve_bps"].as_u64().unwrap() as u16,
        )
        .unwrap_or_else(|| panic!("{name}: split failed"));
        assert_eq!(s.protocol, p(&e["protocol"]), "{name} protocol");
        assert_eq!(s.runner, p(&e["runner"]), "{name} runner");
        assert_eq!(s.parts, e["parts"].as_array().unwrap().iter().map(p).collect::<Vec<_>>(), "{name} parts");
        assert_eq!(s.remainder, p(&e["remainder"]), "{name} remainder");
        assert_eq!(s.reserve, p(&e["reserve"]), "{name} reserve");
        assert_eq!(s.creator, p(&e["creator"]), "{name} creator");
        // conservation: every unit of the price goes to exactly one party or the reserve
        let total = s.protocol + s.runner + s.parts.iter().sum::<u128>() + s.reserve + s.creator;
        assert_eq!(total, p(&i["price"]), "{name} conservation");
        assert_eq!(s.reserve + s.creator, s.remainder, "{name} remainder split");
    }
}

#[test]
fn settlement_rejects_bad_inputs() {
    assert!(settlement_split(100, 0, 60, &[50], 0).is_none(), "fees above price");
    assert!(settlement_split(100, 0, 0, &[], 10_001).is_none(), "reserve_bps above 10000");
    assert!(settlement_split(100, 10_001, 0, &[], 0).is_none(), "protocol_fee_bps above 10000");
    assert!(settlement_split(u128::MAX, 200, 0, &[], 0).is_none(), "protocol fee overflow");
    assert!(settlement_split(u128::MAX, 0, 0, &[u128::MAX, 1], 0).is_none(), "part sum overflow");
    assert!(settlement_split(u128::MAX, 0, 0, &[], 2).is_none(), "reserve overflow");
    assert_eq!(settlement_split(100, 0, 0, &[], 10_000).unwrap().reserve, 100);
}

#[test]
#[should_panic(expected = "price_floor below minimum viable price")]
fn publish_rejects_price_below_fees() {
    let mut c = setup();
    ctx_storage("creator.testnet", 0);
    // fees: protocol 2% + runner 30_000 + parts 140_000 => 170_000 > 150_000
    c.publish_recipe("CHEAP".into(), "x".into(), "h".into(), acct("runner.testnet"), all_parts(), U128(150_000), 0, None, None);
}

#[test]
#[should_panic(expected = "recipe id must match")]
fn publish_rejects_bad_ticker() {
    let mut c = setup();
    ctx_storage("creator.testnet", 0);
    c.publish_recipe("bad".into(), "x".into(), "h".into(), acct("runner.testnet"), vec![], U128(1_000_000), 0, None, None);
}

#[test]
#[should_panic(expected = "unknown part")]
fn publish_rejects_unknown_part() {
    let mut c = setup();
    ctx_storage("creator.testnet", 0);
    c.publish_recipe("NOPE".into(), "x".into(), "h".into(), acct("runner.testnet"), vec!["ghost".into()], U128(1_000_000), 0, None, None);
}

#[test]
#[should_panic(expected = "reserve_bps must be <= 10000")]
fn publish_rejects_reserve_above_10000() {
    let mut c = setup();
    ctx_storage("creator.testnet", 0);
    c.publish_recipe("RSV".into(), "r".into(), "h".into(), acct("runner.testnet"), all_parts(), U128(750_000), 10_001, None, None);
}

#[test]
fn publish_accepts_full_reserve_and_quotes_it() {
    let mut c = setup();
    ctx_storage("creator.testnet", 0);
    c.publish_recipe("RSV".into(), "r".into(), "h".into(), acct("runner.testnet"), all_parts(), U128(750_000), 10_000, None, None);
    let q = c.quote_settlement("RSV".into(), None);
    assert_eq!((q.remainder.0, q.reserve.0, q.creator.0), (565_000, 565_000, 0));
    let ev = last_event();
    assert_eq!(ev["event"], "recipe_published");
    assert_eq!(ev["data"][0]["reserve_bps"], 10_000);
    let q = c.quote_settlement("CLNP".into(), None);
    assert_eq!((q.price.0, q.protocol.0, q.runner.0, q.remainder.0, q.reserve.0, q.creator.0), (750_000, 15_000, 30_000, 565_000, 0, 565_000));
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
#[should_panic(expected = "payment below price")]
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
    assert_eq!(bal(&c, "creator.testnet"), 565_000);

    let r = c.get_recipe("CLNP".into()).unwrap();
    assert_eq!(r.runs, 1);
    assert_eq!(r.revenue.0, 750_000);
    assert_eq!(r.bond_available.0, 0, "reserve_bps 0: nothing set aside");
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
    c.update_sealed("CLNP".into(), V2.into());
    // announced, not yet active: runs paid during the notice period keep the current version
    pay_run(&mut c, "buyer.testnet", "r2", 750_000, DELAY - 1);
    pay_run(&mut c, "buyer.testnet", "r3", 750_000, DELAY);
    assert_eq!(c.get_run("r1".into()).unwrap().sealed_hash, "sha256:sealed");
    assert_eq!(c.get_run("r2".into()).unwrap().sealed_hash, "sha256:sealed");
    assert_eq!(c.get_run("r3".into()).unwrap().sealed_hash, V2);
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
fn intents_underpayment_credits_buyer() { intents_reject_case(json!({}), 749_999, "payment below price"); }

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
#[should_panic(expected = "invalid msg")]
fn bid_action_no_longer_exists() {
    let mut c = setup();
    ctx(USDC, 0);
    let msg = json!({"action":"bid","recipe_id":"CLNP","price":"0","qty":"10","on_behalf_of":"bob.testnet"}).to_string();
    let _ = c.ft_on_transfer(acct("solver.testnet"), U128(5_000), msg);
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
    ctx_storage("evil.testnet", 0);
    c.register_part("a,b".into(), "1".into(), U128(1), "h".into());
}

#[test]
#[should_panic(expected = "part id must match")]
fn part_id_cannot_contain_pipe() {
    let mut c = setup();
    ctx_storage("evil.testnet", 0);
    c.register_part("a|b".into(), "1".into(), U128(1), "h".into());
}

#[test]
#[should_panic(expected = "recipe needs at least one part")]
fn publish_rejects_empty_parts() {
    let mut c = setup();
    ctx_storage("creator.testnet", 0);
    c.publish_recipe("EMPTY".into(), "e".into(), "h".into(), acct("runner.testnet"), vec![], U128(100_000), 0, None, None);
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

#[test]
fn signed_message_format_is_stable() {
    let m = run_report_message("srs.testnet", "r-1", "CLNP", "ok", "sha256:ab", 28_024_900, &["a".into(), "b".into()]);
    assert_eq!(m, "srs-run-v3|srs.testnet|r-1|CLNP|ok|sha256:ab|28024900|a,b");
    let m = run_report_message("srs.testnet", "r-1", "CLNP", "abort", "sha256:ab", 0, &[]);
    assert_eq!(m, "srs-run-v3|srs.testnet|r-1|CLNP|abort|sha256:ab|0|");
    let q = quote_message(
        "srs.testnet",
        "CLNP",
        "sha256:sealed",
        &"ab".repeat(32),
        &"ff".repeat(32),
        "bob.testnet",
        750_000,
        28_000_000,
        27_500_000,
        25_000_000,
        1_000,
    );
    assert_eq!(
        q,
        format!(
            "srs-quote-v3|srs.testnet|CLNP|sha256:sealed|{}|{}|bob.testnet|750000|28000000|27500000|25000000|1000",
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
    price: u128,
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
            price: 750_000,
            expected: promised + promised / 10,
            promised,
            cover,
            expires_ns: 10_000,
        }
    }
    fn json(&self) -> serde_json::Value {
        self.json_for("CLNP")
    }
    fn json_for(&self, recipe: &str) -> serde_json::Value {
        let m = quote_message(
            CONTRACT,
            recipe,
            &self.sealed_hash,
            &self.job_hash,
            &self.inputs_hash,
            &self.buyer,
            self.price,
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
            "price": U128(self.price),
            "expected": U128(self.expected),
            "promised": U128(self.promised),
            "cover": U128(self.cover),
            "expires_ns": U64(self.expires_ns),
            "signature": sig,
        })
    }
}

fn post_bond_to(c: &mut Contract, recipe: &str, amount: u128) {
    ctx(USDC, 0);
    let msg = json!({"action":"bond","recipe_id":recipe}).to_string();
    let _ = c.ft_on_transfer(acct("creator.testnet"), U128(amount), msg);
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
    // (after the notice period the payment itself activates the new version)
    ctx("creator.testnet", 0);
    c.update_sealed("CLNP".into(), V2.into());
    let long = Q { expires_ns: u64::MAX / 2, ..ok.clone() };
    assert_eq!(solver_pays(&mut c, "bob.testnet", "r1", &ff, &long, DELAY).as_deref(), Some("quote for an outdated recipe version"));
    let fresh = Q { sealed_hash: V2.into(), ..long.clone() };
    assert_eq!(solver_pays(&mut c, "bob.testnet", "r1", &ff, &fresh, DELAY), None, "re-quoted for the new version");

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
    assert_eq!(roles.last().unwrap(), "creator");
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
fn conformance_bonds_match_proved_model() {
    let v: serde_json::Value =
        serde_json::from_str(include_str!("../../test-vectors/conformance-money.json")).unwrap();
    for (k, c) in v["bonds"].as_array().unwrap().iter().enumerate() {
        let b = bond::Bond { available: n(&c["available"]), locked: n(&c["locked"]) };
        let x = n(&c["amount"]);
        let e = &c["expected"];
        let got: Option<(bond::Bond, Option<u128>)> = match c["op"].as_str().unwrap() {
            "lock" => bond::lock(b, x).map(|b| (b, None)),
            "release" => bond::release(b, x).map(|b| (b, None)),
            "deposit" => bond::deposit(b, x).map(|b| (b, None)),
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
}

#[test]
fn conformance_settlement_matches_proved_model() {
    let v: serde_json::Value =
        serde_json::from_str(include_str!("../../test-vectors/conformance-money.json")).unwrap();
    let cases = v["settlement"].as_array().unwrap();
    assert!(cases.len() >= 300);
    for (k, c) in cases.iter().enumerate() {
        let i = &c["input"];
        let fees: Vec<u128> = i["part_fees"].as_array().unwrap().iter().map(n).collect();
        let got = settlement::settlement_split(
            n(&i["price"]),
            i["protocol_fee_bps"].as_u64().unwrap() as u16,
            n(&i["runner_fee"]),
            &fees,
            i["reserve_bps"].as_u64().unwrap() as u16,
        );
        let e = &c["expected"];
        match got {
            None => assert!(e.is_null(), "settlement case {k}: Rust None, model Some"),
            Some(s) => {
                assert!(!e.is_null(), "settlement case {k}: Rust Some, model None");
                assert_eq!(
                    (s.protocol, s.remainder, s.reserve, s.creator),
                    (n(&e["protocol"]), n(&e["remainder"]), n(&e["reserve"]), n(&e["creator"])),
                    "settlement case {k}"
                );
            }
        }
    }
}

// ------------------------------------------------------------- v4: versioned recipes with notice

const V3: &str = "3333333333333333333333333333333333333333333333333333333333333333";
const STATE: &str = "5555555555555555555555555555555555555555555555555555555555555555";

#[test]
fn update_is_announced_then_activated_after_the_notice_period() {
    let mut c = setup();
    ctx("creator.testnet", 0);
    c.update_sealed("CLNP".into(), V2.into());
    let e = last_event();
    assert_eq!(e["event"], "recipe_update_scheduled");
    assert_eq!(e["data"][0], json!({"recipe_id": "CLNP", "sealed_hash": V2, "version": 2, "effective_ns": DELAY.to_string()}));
    let r = c.get_recipe("CLNP".into()).unwrap();
    assert_eq!((r.sealed_hash.as_str(), r.version, r.pending_sealed_hash.as_str(), r.update_effective_ns.0), ("sha256:sealed", 1, V2, DELAY));
    ctx("anyone.testnet", DELAY);
    c.apply_update("CLNP".into());
    let e = last_event();
    assert_eq!(e["event"], "recipe_updated");
    assert_eq!(e["data"][0], json!({"recipe_id": "CLNP", "sealed_hash": V2, "version": 2}));
    let r = c.get_recipe("CLNP".into()).unwrap();
    assert_eq!((r.sealed_hash.as_str(), r.version, r.pending_sealed_hash.as_str(), r.update_effective_ns.0), (V2, 2, "", 0));
    // a second update counts on, and a newer announcement replaces a pending one
    ctx("creator.testnet", DELAY);
    c.update_sealed("CLNP".into(), V3.into());
    c.update_sealed("CLNP".into(), "4444444444444444444444444444444444444444444444444444444444444444".into());
    pay_run(&mut c, "buyer.testnet", "r1", 750_000, 2 * DELAY);
    let r = c.get_recipe("CLNP".into()).unwrap();
    assert_eq!((r.version, r.sealed_hash.chars().next()), (3, Some('4')), "payment activated the due update");
    assert_eq!(c.get_run("r1".into()).unwrap().sealed_hash, r.sealed_hash);
}

#[test]
fn update_activates_lazily_inside_update_sealed() {
    let mut c = setup();
    ctx("creator.testnet", 0);
    c.update_sealed("CLNP".into(), V2.into());
    ctx("creator.testnet", DELAY);
    c.update_sealed("CLNP".into(), V3.into());
    let r = c.get_recipe("CLNP".into()).unwrap();
    assert_eq!((r.sealed_hash.as_str(), r.version, r.pending_sealed_hash.as_str()), (V2, 2, V3));
}

#[test]
fn cancel_update_keeps_the_current_version() {
    let mut c = setup();
    ctx("creator.testnet", 0);
    c.update_sealed("CLNP".into(), V2.into());
    c.cancel_update("CLNP".into());
    let e = last_event();
    assert_eq!(e["event"], "recipe_update_cancelled");
    assert_eq!(e["data"][0], json!({"recipe_id": "CLNP", "sealed_hash": V2}));
    pay_run(&mut c, "buyer.testnet", "r1", 750_000, DELAY);
    let r = c.get_recipe("CLNP".into()).unwrap();
    assert_eq!((r.sealed_hash.as_str(), r.version, r.pending_sealed_hash.as_str(), r.update_effective_ns.0), ("sha256:sealed", 1, "", 0));
}

#[test]
#[should_panic(expected = "creator only")]
fn update_sealed_creator_only() {
    let mut c = setup();
    ctx("mallory.testnet", 0);
    c.update_sealed("CLNP".into(), V2.into());
}

#[test]
#[should_panic(expected = "sealed_hash must be 64 lowercase hex")]
fn update_sealed_rejects_bad_hash() {
    let mut c = setup();
    ctx("creator.testnet", 0);
    c.update_sealed("CLNP".into(), "sha256:v2".into());
}

#[test]
#[should_panic(expected = "same as current version")]
fn update_sealed_rejects_current_version() {
    let mut c = setup();
    ctx("creator.testnet", 0);
    c.update_sealed("CLNP".into(), V2.into());
    ctx("creator.testnet", DELAY);
    c.update_sealed("CLNP".into(), V2.into());
}

#[test]
#[should_panic(expected = "no pending update")]
fn cancel_update_needs_a_pending_update() {
    let mut c = setup();
    ctx("creator.testnet", 0);
    c.cancel_update("CLNP".into());
}

#[test]
#[should_panic(expected = "creator only")]
fn cancel_update_creator_only() {
    let mut c = setup();
    ctx("creator.testnet", 0);
    c.update_sealed("CLNP".into(), V2.into());
    ctx("mallory.testnet", 0);
    c.cancel_update("CLNP".into());
}

#[test]
#[should_panic(expected = "update not due")]
fn apply_update_before_effective_time() {
    let mut c = setup();
    ctx("creator.testnet", 0);
    c.update_sealed("CLNP".into(), V2.into());
    ctx("anyone.testnet", DELAY - 1);
    c.apply_update("CLNP".into());
}

#[test]
#[should_panic(expected = "update not due")]
fn apply_update_without_pending() {
    let mut c = setup();
    ctx("anyone.testnet", DELAY);
    c.apply_update("CLNP".into());
}

#[test]
#[should_panic(expected = r#"settle_mode must be "final" or "checkpoint""#)]
fn publish_rejects_unknown_settle_mode() {
    let mut c = setup();
    ctx_storage("creator.testnet", 0);
    c.publish_recipe("ODD".into(), "o".into(), "h".into(), acct("runner.testnet"), all_parts(), U128(750_000), 0, Some("weekly".into()), None);
}

#[test]
fn config_and_new_fields_serialize() {
    let mut c = setup();
    assert_eq!(c.get_config().update_delay_ns.0, DELAY);
    let r = serde_json::to_value(c.get_recipe("CLNP".into()).unwrap()).unwrap();
    assert_eq!((r["settle_mode"].clone(), r["version"].clone(), r["pending_sealed_hash"].clone(), r["update_effective_ns"].clone()), (json!("final"), json!(1), json!(""), json!("0")));
    pay_run(&mut c, "buyer.testnet", "r1", 750_000, 7);
    let run = serde_json::to_value(c.get_run("r1".into()).unwrap()).unwrap();
    assert_eq!(run["checkpoint_seq"], 0);
    assert_eq!(run["state_hash"], "");
    assert_eq!(run["parts_billed"], json!([]));
    assert_eq!(run["billed"], "0");
    assert_eq!(run["last_progress_ns"], "7");
}

// ------------------------------------------------------------- v4: durable runs and partial billing

fn ckpt_sig(run_id: &str, recipe: &str, seq: u32, state: &str, parts: &[String]) -> Base64VecU8 {
    let m = checkpoint_message(CONTRACT, run_id, recipe, seq, state, parts);
    Base64VecU8(signing_key().sign(m.as_bytes()).to_bytes().to_vec())
}

fn checkpoint(c: &mut Contract, run_id: &str, recipe: &str, seq: u32, parts: &[&str], ts: u64) -> Vec<Payout> {
    let parts: Vec<String> = parts.iter().map(|p| p.to_string()).collect();
    let sig = ckpt_sig(run_id, recipe, seq, STATE, &parts);
    ctx("relayer.testnet", ts);
    c.checkpoint_run(run_id.into(), seq, STATE.into(), parts, sig)
}

/// CLNP plus "DURA": the same five parts in checkpoint mode.
fn setup_checkpoint_mode() -> Contract {
    let mut c = setup();
    ctx_storage("creator.testnet", 0);
    c.publish_recipe("DURA".into(), "Durable".into(), "h".into(), acct("runner.testnet"), all_parts(), U128(750_000), 1000, Some("checkpoint".into()), None);
    ctx(USDC, 0);
    let msg = json!({"action":"run","recipe_id":"DURA","run_id":"d1","inputs_hash":"ff".repeat(32)}).to_string();
    let _ = c.ft_on_transfer(acct("buyer.testnet"), U128(750_000), msg);
    c
}

#[test]
fn checkpoint_message_format() {
    assert_eq!(
        checkpoint_message("srs.testnet", "r1", "CLNP", 2, "ab", &["a".into(), "b".into()]),
        "srs-ckpt-v1|srs.testnet|r1|CLNP|2|ab|a,b"
    );
}

#[test]
fn heartbeat_checkpoints_extend_the_timeout() {
    let mut c = setup();
    pay_run(&mut c, "buyer.testnet", "r1", 750_000, 0);
    let t1 = RUN_TIMEOUT_NS - 1;
    assert!(checkpoint(&mut c, "r1", "CLNP", 1, &[], t1).is_empty());
    let e = last_event();
    assert_eq!(e["event"], "run_checkpoint");
    assert_eq!(e["data"][0], json!({"run_id": "r1", "seq": 1, "state_hash": STATE, "parts_done": [], "billed": "0", "payouts": []}));
    let run = c.get_run("r1".into()).unwrap();
    assert_eq!((run.checkpoint_seq, run.state_hash.as_str(), run.last_progress_ns.0), (1, STATE, t1));
    checkpoint(&mut c, "r1", "CLNP", 2, &[], t1 + 5);
    ctx("buyer.testnet", t1 + 5 + RUN_TIMEOUT_NS);
    c.reclaim_run("r1".into());
    assert_eq!(bal(&c, "buyer.testnet"), 750_000);
}

#[test]
#[should_panic(expected = "run not timed out")]
fn reclaim_counts_from_last_progress() {
    let mut c = setup();
    pay_run(&mut c, "buyer.testnet", "r1", 750_000, 0);
    checkpoint(&mut c, "r1", "CLNP", 1, &[], RUN_TIMEOUT_NS - 1);
    ctx("buyer.testnet", RUN_TIMEOUT_NS);
    c.reclaim_run("r1".into());
}

#[test]
fn partial_billing_pays_parts_at_checkpoints_and_never_twice() {
    let mut c = setup_checkpoint_mode();
    let paid = checkpoint(&mut c, "d1", "DURA", 1, &["wallet-scanner", "spam-shield"], 10);
    assert_eq!(paid.len(), 2);
    assert_eq!(bal(&c, "scanlabs.testnet"), 20_000);
    assert_eq!(bal(&c, "shieldai.testnet"), 50_000);
    let e = last_event();
    assert_eq!(e["data"][0]["billed"], "70000");
    assert_eq!(e["data"][0]["payouts"][1], json!({"account_id": "shieldai.testnet", "role": "part:spam-shield", "amount": "50000"}));
    checkpoint(&mut c, "d1", "DURA", 2, &["dust-filter"], 20);
    let run = c.get_run("d1".into()).unwrap();
    assert_eq!((run.billed.0, run.parts_billed.len()), (80_000, 3));
    // final settlement: billed parts are not paid again
    let parts = all_parts();
    let m = run_report_message(CONTRACT, "d1", "DURA", "ok", OUT, 0, &parts);
    ctx("relayer.testnet", 30);
    let payouts = c.report_run("d1".into(), "ok".into(), parts, OUT.into(), U128(0), Base64VecU8(signing_key().sign(m.as_bytes()).to_bytes().to_vec()));
    let roles: Vec<&str> = payouts.iter().map(|p| p.role.as_str()).collect();
    assert_eq!(roles, ["protocol", "runner", "part:fresh-address", "part:private-swap", "creator"]);
    assert_eq!(bal(&c, "scanlabs.testnet"), 20_000, "scanner paid once");
    assert_eq!(bal(&c, "dustco.testnet"), 10_000, "dust filter paid once");
    let e = last_event();
    let reserve: u128 = e["data"][0]["reserve"].as_str().unwrap().parse().unwrap();
    assert_eq!(reserve, 56_500, "DURA reserve_bps 1000 of 565000");
    let sum: u128 = payouts.iter().map(|p| p.amount.0).sum();
    assert_eq!(80_000 + sum + reserve, 750_000, "billed + payouts + reserve == price");
    assert_eq!(c.get_recipe("DURA".into()).unwrap().bond_available.0, 56_500);
    assert_eq!(bal(&c, "creator.testnet"), 508_500);
}

#[test]
fn failure_after_billing_refunds_the_unbilled_rest() {
    let mut c = setup_checkpoint_mode();
    checkpoint(&mut c, "d1", "DURA", 1, &["wallet-scanner"], 10);
    let m = run_report_message(CONTRACT, "d1", "DURA", "fail", OUT, 0, &[]);
    ctx("relayer.testnet", 20);
    c.report_run("d1".into(), "fail".into(), vec![], OUT.into(), U128(0), Base64VecU8(signing_key().sign(m.as_bytes()).to_bytes().to_vec()));
    assert_eq!(bal(&c, "buyer.testnet"), 730_000);
    assert_eq!(bal(&c, "scanlabs.testnet"), 20_000);
    let e = last_event();
    assert_eq!(e["event"], "run_refunded");
    assert_eq!(e["data"][0]["amount"], "730000");
}

#[test]
fn timeout_after_billing_refunds_the_unbilled_rest() {
    let mut c = setup_checkpoint_mode();
    checkpoint(&mut c, "d1", "DURA", 1, &["wallet-scanner", "spam-shield"], 10);
    ctx("buyer.testnet", 10 + RUN_TIMEOUT_NS);
    c.reclaim_run("d1".into());
    assert_eq!(bal(&c, "buyer.testnet"), 680_000);
}

#[test]
#[should_panic(expected = "parts_used must include billed parts")]
fn final_report_must_include_billed_parts() {
    let mut c = setup_checkpoint_mode();
    checkpoint(&mut c, "d1", "DURA", 1, &["wallet-scanner"], 10);
    let parts: Vec<String> = vec!["spam-shield".into()];
    let m = run_report_message(CONTRACT, "d1", "DURA", "ok", OUT, 0, &parts);
    ctx("relayer.testnet", 20);
    c.report_run("d1".into(), "ok".into(), parts, OUT.into(), U128(0), Base64VecU8(signing_key().sign(m.as_bytes()).to_bytes().to_vec()));
}

#[test]
#[should_panic(expected = "parts_done not part of recipe")]
fn checkpoint_cannot_bill_a_part_twice() {
    let mut c = setup_checkpoint_mode();
    checkpoint(&mut c, "d1", "DURA", 1, &["wallet-scanner"], 10);
    checkpoint(&mut c, "d1", "DURA", 2, &["wallet-scanner"], 20);
}

#[test]
#[should_panic(expected = "parts_done not part of recipe")]
fn checkpoint_cannot_bill_a_foreign_part() {
    let mut c = setup_checkpoint_mode();
    checkpoint(&mut c, "d1", "DURA", 1, &["ghost"], 10);
}

#[test]
#[should_panic(expected = "parts can only be billed at checkpoints in checkpoint mode")]
fn final_mode_does_not_bill_at_checkpoints() {
    let mut c = setup();
    pay_run(&mut c, "buyer.testnet", "r1", 750_000, 0);
    checkpoint(&mut c, "r1", "CLNP", 1, &["wallet-scanner"], 10);
}

#[test]
#[should_panic(expected = "seq must be checkpoint_seq + 1")]
fn checkpoint_seq_must_advance_by_one() {
    let mut c = setup();
    pay_run(&mut c, "buyer.testnet", "r1", 750_000, 0);
    checkpoint(&mut c, "r1", "CLNP", 2, &[], 10);
}

#[test]
#[should_panic(expected = "seq must be checkpoint_seq + 1")]
fn checkpoint_cannot_be_replayed() {
    let mut c = setup();
    pay_run(&mut c, "buyer.testnet", "r1", 750_000, 0);
    checkpoint(&mut c, "r1", "CLNP", 1, &[], 10);
    checkpoint(&mut c, "r1", "CLNP", 1, &[], 20);
}

#[test]
#[should_panic(expected = "state_hash must be 64 lowercase hex")]
fn checkpoint_rejects_bad_state_hash() {
    let mut c = setup();
    pay_run(&mut c, "buyer.testnet", "r1", 750_000, 0);
    let sig = ckpt_sig("r1", "CLNP", 1, "XYZ", &[]);
    ctx("relayer.testnet", 10);
    c.checkpoint_run("r1".into(), 1, "XYZ".into(), vec![], sig);
}

#[test]
#[should_panic(expected = "invalid runner signature")]
fn checkpoint_rejects_wrong_signature() {
    let mut c = setup();
    pay_run(&mut c, "buyer.testnet", "r1", 750_000, 0);
    let sig = ckpt_sig("r1", "CLNP", 2, STATE, &[]); // signed for another seq
    ctx("relayer.testnet", 10);
    c.checkpoint_run("r1".into(), 1, STATE.into(), vec![], sig);
}

#[test]
#[should_panic(expected = "run not pending")]
fn checkpoint_after_settlement_rejected() {
    let mut c = setup();
    pay_run(&mut c, "buyer.testnet", "r1", 750_000, 0);
    report(&mut c, "r1", "ok", 0);
    checkpoint(&mut c, "r1", "CLNP", 1, &[], 10);
}

#[test]
#[should_panic(expected = "unknown run")]
fn checkpoint_unknown_run() {
    let mut c = setup();
    checkpoint(&mut c, "nope", "CLNP", 1, &[], 10);
}

#[test]
#[should_panic(expected = "runner inactive")]
fn checkpoint_needs_active_runner() {
    let mut c = setup();
    pay_run(&mut c, "buyer.testnet", "r1", 750_000, 0);
    ctx("owner.testnet", 0);
    c.set_runner_active(acct("runner.testnet"), false);
    checkpoint(&mut c, "r1", "CLNP", 1, &[], 10);
}

// ------------------------------------------------------------- v5: reserve into the guarantee deposit

/// CLNP plus "RSRV": the same five parts, final mode, reserve_bps 2500.
fn setup_reserve() -> Contract {
    let mut c = setup();
    ctx_storage("creator.testnet", 0);
    c.publish_recipe("RSRV".into(), "Reserve".into(), "h".into(), acct("runner.testnet"), all_parts(), U128(750_000), 2500, None, None);
    c
}

fn run_ok(c: &mut Contract, recipe: &str, run_id: &str, ts: u64) -> Vec<Payout> {
    ctx(USDC, ts);
    let msg = json!({"action":"run","recipe_id":recipe,"run_id":run_id,"inputs_hash":"ff".repeat(32)}).to_string();
    let _ = c.ft_on_transfer(acct("buyer.testnet"), U128(750_000), msg);
    let parts = all_parts();
    let m = run_report_message(CONTRACT, run_id, recipe, "ok", OUT, 0, &parts);
    ctx("relayer.testnet", ts + 1);
    c.report_run(run_id.into(), "ok".into(), parts, OUT.into(), U128(0), Base64VecU8(signing_key().sign(m.as_bytes()).to_bytes().to_vec()))
}

#[test]
fn reserve_grows_bond_available() {
    let mut c = setup_reserve();
    run_ok(&mut c, "RSRV", "a1", 0);
    // remainder 565000, reserve floor(565000 * 2500 / 10000) = 141250
    assert_eq!(c.get_recipe("RSRV".into()).unwrap().bond_available.0, 141_250);
    assert_eq!(bal(&c, "creator.testnet"), 423_750);
    run_ok(&mut c, "RSRV", "a2", 10);
    let r = c.get_recipe("RSRV".into()).unwrap();
    assert_eq!((r.bond_available.0, r.bond_locked.0, r.runs), (282_500, 0, 2));
    // the reserve backs quotes like any deposit and the creator can withdraw it
    ctx("creator.testnet", 20);
    c.withdraw_bond("RSRV".into(), U128(282_500));
    assert_eq!(c.get_recipe("RSRV".into()).unwrap().bond_available.0, 0);
    assert_eq!(bal(&c, "creator.testnet"), 2 * 423_750 + 282_500);
}

#[test]
fn settlement_event_has_v5_fields_in_order() {
    let mut c = setup_reserve();
    run_ok(&mut c, "RSRV", "a1", 0);
    let e = last_event();
    assert_eq!(e["event"], "srs_settlement");
    let d = e["data"][0].as_object().unwrap();
    let keys: Vec<&str> = d.keys().map(|k| k.as_str()).collect();
    // serde_json is built with preserve_order, so the logged order is the spec order
    assert_eq!(keys, ["run_id", "recipe_id", "buyer", "price", "output_hash", "payouts", "reserve", "delivered", "compensation"]);
    assert_eq!(d["reserve"], "141250");
    let roles: Vec<&str> = d["payouts"].as_array().unwrap().iter().map(|p| p["role"].as_str().unwrap()).collect();
    assert_eq!(roles.first(), Some(&"protocol"));
    assert_eq!(roles.last(), Some(&"creator"));
    for gone in ["shareholder_pool", "acc_increment", "creator_royalty"] {
        assert!(!e.to_string().contains(gone), "{gone} must not appear");
    }
}

#[test]
fn payouts_plus_reserve_equal_price() {
    for (recipe, bps) in [("CLNP", 0u16), ("RSRV", 2500)] {
        // fresh mocked blockchain (thread-local storage) per case
        std::thread::spawn(move || {
            let mut c = setup_reserve();
            let payouts = run_ok(&mut c, recipe, "p1", 0);
            let reserve = c.get_recipe(recipe.into()).unwrap().bond_available.0;
            let sum: u128 = payouts.iter().map(|p| p.amount.0).sum();
            assert_eq!(sum + reserve, 750_000, "{recipe}: payouts + reserve == price");
            assert_eq!(reserve, 565_000 * bps as u128 / 10_000, "{recipe}: reserve");
        })
        .join()
        .expect("case failed");
    }
}

#[test]
fn payouts_plus_reserve_equal_price_with_checkpoint_billing() {
    // DURA: checkpoint mode, reserve_bps 1000; three parts billed at two checkpoints
    let mut c = setup_checkpoint_mode();
    let mut billed: u128 = 0;
    billed += checkpoint(&mut c, "d1", "DURA", 1, &["wallet-scanner", "private-swap"], 10).iter().map(|p| p.amount.0).sum::<u128>();
    billed += checkpoint(&mut c, "d1", "DURA", 2, &["fresh-address"], 20).iter().map(|p| p.amount.0).sum::<u128>();
    assert_eq!(billed, 80_000);
    let parts = all_parts();
    let m = run_report_message(CONTRACT, "d1", "DURA", "ok", OUT, 0, &parts);
    ctx("relayer.testnet", 30);
    let payouts = c.report_run("d1".into(), "ok".into(), parts, OUT.into(), U128(0), Base64VecU8(signing_key().sign(m.as_bytes()).to_bytes().to_vec()));
    let reserve = c.get_recipe("DURA".into()).unwrap().bond_available.0;
    let sum: u128 = payouts.iter().map(|p| p.amount.0).sum();
    assert_eq!(reserve, 56_500);
    assert_eq!(billed + sum + reserve, 750_000, "checkpoint payouts + final payouts + reserve == price");
    // and every unit landed in a balance or the guarantee deposit
    let credited: u128 = ["protocol.testnet", "runner.testnet", "creator.testnet", "scanlabs.testnet", "shieldai.testnet", "dustco.testnet", "freshkeys.testnet", "swapsmith.testnet"]
        .iter()
        .map(|a| bal(&c, a))
        .sum();
    assert_eq!(credited + reserve, 750_000);
}

#[test]
fn reserve_adds_to_an_existing_deposit() {
    let mut c = setup_reserve();
    ctx(USDC, 0);
    let _ = c.ft_on_transfer(acct("creator.testnet"), U128(1_000_000), json!({"action":"bond","recipe_id":"RSRV"}).to_string());
    run_ok(&mut c, "RSRV", "b1", 5);
    assert_eq!(c.get_recipe("RSRV".into()).unwrap().bond_available.0, 1_000_000 + 141_250);
}

#[test]
fn recipe_fields_in_spec_order() {
    let c = setup();
    let r = serde_json::to_value(c.get_recipe("CLNP".into()).unwrap()).unwrap();
    let keys: Vec<&str> = r.as_object().unwrap().keys().map(|k| k.as_str()).collect();
    assert_eq!(
        keys,
        [
            "id", "name", "creator", "sealed_hash", "runner_id", "parts", "price_per_run", "reserve_bps", "runs",
            "revenue", "listed", "failed", "aborted", "promised_total", "delivered_total", "compensated_total",
            "bond_available", "bond_locked", "settle_mode", "version", "pending_sealed_hash", "update_effective_ns",
            "price_floor", "price_ceiling", "target_runs", "period_start_ns", "period_runs",
        ]
    );
}

// ------------------------------------------------------------- v6: market-driven pricing

/// CLNP-like recipe "MKT": list price 1.00, band 0.50..2.00, target 2 runs per period.
fn setup_market() -> Contract {
    let mut c = setup();
    ctx_storage("creator.testnet", 0);
    c.publish_recipe(
        "MKT".into(),
        "Market priced".into(),
        "sha256:mkt".into(),
        acct("runner.testnet"),
        all_parts(),
        U128(1_000_000),
        0,
        None,
        Some(PricingInput { price_floor: U128(500_000), price_ceiling: U128(2_000_000), target_runs: 2 }),
    );
    c
}

fn pay(c: &mut Contract, recipe: &str, run_id: &str, amount: u128, ts: u64, extra: serde_json::Value) -> serde_json::Value {
    ctx(USDC, ts);
    let mut msg = json!({"action":"run","recipe_id":recipe,"run_id":run_id,"inputs_hash":"ff".repeat(32)});
    for (k, v) in extra.as_object().unwrap() {
        msg[k] = v.clone();
    }
    let _ = c.ft_on_transfer(acct("bob.testnet"), U128(amount), msg.to_string());
    last_event()
}

fn price(c: &Contract, id: &str) -> u128 {
    c.get_recipe(id.into()).unwrap().price_per_run.0
}

#[test]
fn next_price_follows_the_eip1559_rule() {
    use crate::pricing::next_price;
    // at target: unchanged; double the target: +12.5%; idle: -12.5%; clamped to the band
    assert_eq!(next_price(1_000_000, 2, 2, 0, 10_000_000), Some(1_000_000));
    assert_eq!(next_price(1_000_000, 4, 2, 0, 10_000_000), Some(1_125_000));
    assert_eq!(next_price(1_000_000, 400, 2, 0, 10_000_000), Some(1_125_000), "capped at 2x target");
    assert_eq!(next_price(1_000_000, 3, 2, 0, 10_000_000), Some(1_062_500));
    assert_eq!(next_price(1_000_000, 0, 2, 0, 10_000_000), Some(875_000));
    assert_eq!(next_price(1_000_000, 0, 2, 950_000, 10_000_000), Some(950_000));
    assert_eq!(next_price(1_000_000, 4, 2, 0, 1_100_000), Some(1_100_000));
    assert_eq!(next_price(1, 0, 0, 0, 2), None, "target 0 is rejected");
}

#[test]
fn busy_recipe_price_rises_idle_recipe_price_falls() {
    let mut c = setup_market();
    for i in 0..4 {
        pay(&mut c, "MKT", &format!("b{i}"), 1_000_000, 10 + i, json!({}));
    }
    assert_eq!(c.get_recipe("MKT".into()).unwrap().period_runs, 4);
    // the view already shows the next period's price; storage catches up on the next payment
    ctx("anyone.testnet", PERIOD);
    assert_eq!(price(&c, "MKT"), 1_125_000);
    let ev = pay(&mut c, "MKT", "b4", 1_125_000, PERIOD + 1, json!({}));
    assert_eq!(ev["event"], "run_requested");
    assert_eq!(c.get_run("b4".into()).unwrap().amount.0, 1_125_000, "charged the new list price");
    // three idle periods: 1.125 * 0.875^... but the run in the current period counts for the first
    ctx("anyone.testnet", 4 * PERIOD + 5);
    let p = price(&c, "MKT");
    assert!((500_000..1_125_000).contains(&p), "idle periods pull the price down, not below the floor: {p}");
    // a long idle stretch ends at the floor
    ctx("anyone.testnet", 200 * PERIOD);
    assert_eq!(price(&c, "MKT"), 500_000);
}

#[test]
fn price_updated_event_and_overpayment_refund() {
    let mut c = setup_market();
    for i in 0..4 {
        pay(&mut c, "MKT", &format!("b{i}"), 1_000_000, 10 + i, json!({}));
    }
    ctx(USDC, PERIOD + 1);
    let msg = json!({"action":"run","recipe_id":"MKT","run_id":"b9","inputs_hash":"ff".repeat(32)});
    let _ = c.ft_on_transfer(acct("bob.testnet"), U128(1_200_000), msg.to_string());
    let logs = near_sdk::test_utils::get_logs();
    let pu: serde_json::Value = logs
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|l| serde_json::from_str::<serde_json::Value>(l).unwrap())
        .find(|e| e["event"] == "price_updated")
        .expect("price_updated emitted");
    assert_eq!(
        pu["data"][0],
        json!({"recipe_id":"MKT","previous":"1000000","price":"1125000","periods":"1","runs":"4","target_runs":2})
    );
    assert_eq!(bal(&c, "bob.testnet"), 75_000, "overpayment credited");
    let r = c.get_recipe("MKT".into()).unwrap();
    assert_eq!((r.period_runs, r.period_start_ns.0), (1, PERIOD));
}

#[test]
fn max_price_protects_the_buyer() {
    let mut c = setup_market();
    ctx(USDC, 0);
    let msg = json!({"action":"run","recipe_id":"MKT","run_id":"m1","inputs_hash":"ff".repeat(32),"max_price":"900000","on_behalf_of":"bob.testnet"});
    let _ = c.ft_on_transfer(acct("solver.testnet"), U128(1_000_000), msg.to_string());
    let e = last_event();
    assert_eq!(e["event"], "transfer_rejected");
    assert_eq!(e["data"][0]["reason"], "price above max_price");
    assert_eq!(bal(&c, "bob.testnet"), 1_000_000);
    assert!(c.get_run("m1".into()).is_none());
    // at or above the list price it goes through
    let ev = pay(&mut c, "MKT", "m2", 1_000_000, 1, json!({"max_price":"1000000"}));
    assert_eq!(ev["event"], "run_requested");
}

#[test]
fn signed_quote_locks_its_price_within_the_band() {
    let mut c = setup_market();
    post_bond_to(&mut c, "MKT", 5_000_000);
    let mut q = Q::new(1_000_000, 0);
    q.sealed_hash = "sha256:mkt".into();
    q.price = 1_300_000; // runner priced this job above the list price
    let ev = pay(&mut c, "MKT", "q1", 1_300_000, 1, json!({"quote": q.json_for("MKT")}));
    assert_eq!(ev["event"], "run_requested");
    assert_eq!(c.get_run("q1".into()).unwrap().amount.0, 1_300_000);
    // a quote below the floor is rejected (the floor keeps every run viable)
    let mut low = q.clone();
    low.price = 400_000;
    low.job_hash = "ee".repeat(32);
    ctx(USDC, 2);
    let msg = json!({"action":"run","recipe_id":"MKT","run_id":"q2","inputs_hash":"ff".repeat(32),"quote":low.json_for("MKT"),"on_behalf_of":"bob.testnet"});
    let _ = c.ft_on_transfer(acct("solver.testnet"), U128(1_300_000), msg.to_string());
    assert_eq!(last_event()["data"][0]["reason"], "quoted price outside price_floor..price_ceiling");
    // the signature covers the price: paying a tampered price fails verification
    let mut j = q.json_for("MKT");
    j["price"] = json!("500000");
    j["job_hash"] = json!("dd".repeat(32));
    ctx(USDC, 3);
    let msg = json!({"action":"run","recipe_id":"MKT","run_id":"q3","inputs_hash":"ff".repeat(32),"quote":j,"on_behalf_of":"bob.testnet"});
    let _ = c.ft_on_transfer(acct("solver.testnet"), U128(500_000), msg.to_string());
    assert_eq!(last_event()["data"][0]["reason"], "invalid quote signature");
}

#[test]
fn settlement_conserves_at_a_market_price() {
    let mut c = setup_market();
    pay(&mut c, "MKT", "s1", 1_000_000, 1, json!({}));
    ctx("relayer.testnet", 2);
    let parts = all_parts();
    let payouts = c.report_run("s1".into(), "ok".into(), parts.clone(), "ab".repeat(32), U128(0), sign("s1", "MKT", "ok", &"ab".repeat(32), &parts));
    let total: u128 = payouts.iter().map(|p| p.amount.0).sum();
    assert_eq!(total, 1_000_000);
}

#[test]
fn set_pricing_is_creator_only_and_validated() {
    let mut c = setup_market();
    ctx("creator.testnet", 1);
    c.set_pricing("MKT".into(), PricingInput { price_floor: U128(600_000), price_ceiling: U128(800_000), target_runs: 5 });
    let r = c.get_recipe("MKT".into()).unwrap();
    assert_eq!((r.price_per_run.0, r.price_floor.0, r.price_ceiling.0, r.target_runs), (800_000, 600_000, 800_000, 5));
    assert_eq!(last_event()["event"], "pricing_updated");
}

#[test]
#[should_panic(expected = "creator only")]
fn set_pricing_rejects_others() {
    let mut c = setup_market();
    ctx("bob.testnet", 1);
    c.set_pricing("MKT".into(), PricingInput { price_floor: U128(600_000), price_ceiling: U128(800_000), target_runs: 5 });
}

#[test]
#[should_panic(expected = "price_floor below minimum viable price")]
fn set_pricing_keeps_the_floor_viable() {
    let mut c = setup_market();
    ctx("creator.testnet", 1);
    c.set_pricing("MKT".into(), PricingInput { price_floor: U128(100_000), price_ceiling: U128(800_000), target_runs: 5 });
}

#[test]
#[should_panic(expected = "price_per_run must be within price_floor and price_ceiling")]
fn publish_rejects_a_start_price_outside_the_band() {
    let mut c = setup();
    ctx_storage("creator.testnet", 0);
    c.publish_recipe(
        "BAD".into(), "x".into(), "sha256:x".into(), acct("runner.testnet"), all_parts(), U128(3_000_000), 0, None,
        Some(PricingInput { price_floor: U128(500_000), price_ceiling: U128(2_000_000), target_runs: 2 }),
    );
}

#[test]
fn conformance_pricing_matches_proved_model() {
    let v: serde_json::Value =
        serde_json::from_str(include_str!("../../test-vectors/conformance-money.json")).unwrap();
    let cases = v["pricing"].as_array().unwrap();
    assert!(cases.len() >= 200);
    for (k, c) in cases.iter().enumerate() {
        let got = crate::pricing::next_price(
            n(&c["price"]),
            c["runs"].as_u64().unwrap(),
            c["target"].as_u64().unwrap() as u32,
            n(&c["floor"]),
            n(&c["ceiling"]),
        );
        match (&c["expected"], got) {
            (serde_json::Value::Null, None) => {}
            (e, Some(p)) if !e.is_null() => assert_eq!(p, n(e), "pricing case {k}"),
            (e, g) => panic!("pricing case {k}: model {e}, Rust {g:?}"),
        }
    }
}

#[test]
fn anyone_can_apply_ended_periods() {
    let mut c = setup_market();
    ctx("keeper.testnet", 3 * PERIOD);
    let p = c.update_price("MKT".into());
    assert_eq!(p.0, 669_922, "three idle periods: 1.0 -> 0.875 -> 0.765625 -> 0.669922 (each step rounds the decrease down)");
    let e = last_event();
    assert_eq!(e["event"], "price_updated");
    assert_eq!(e["data"][0]["periods"], "3");
    // nothing more to apply in the same period
    let before = near_sdk::test_utils::get_logs().len();
    c.update_price("MKT".into());
    assert_eq!(near_sdk::test_utils::get_logs().len(), before);
}

// ---------------------------------------------------- storage paid by the caller

#[test]
#[should_panic(expected = "to pay for")]
fn register_part_without_a_storage_deposit_is_rejected() {
    let mut c = setup();
    ctx("spammer.testnet", 0);
    c.register_part("spam.part@1".into(), "1".into(), U128(1), "h".into());
}

#[test]
#[should_panic(expected = "to pay for")]
fn publish_recipe_without_a_storage_deposit_is_rejected() {
    let mut c = setup();
    ctx("creator.testnet", 0);
    c.publish_recipe("FREE".into(), "f".into(), "h".into(), acct("runner.testnet"), all_parts(), U128(750_000), 0, None, None);
}

#[test]
fn storage_is_charged_by_the_bytes_written_and_the_rest_is_refunded() {
    let mut c = setup();
    ctx_storage("author.testnet", 0);
    let before = env::storage_usage();
    c.register_part("x.part@1".into(), "1.0.0".into(), U128(1), "h".into());
    let used = env::storage_usage() - before;
    assert!(used > 0, "the part is stored");
    let cost = env::storage_byte_cost().saturating_mul(used as u128);
    // one refund receipt back to the caller: the deposit minus exactly the storage cost
    let receipts = near_sdk::test_utils::get_created_receipts();
    let refund = receipts.last().expect("refund receipt");
    assert_eq!(refund.receiver_id, acct("author.testnet"));
    match &refund.actions[..] {
        [near_sdk::mock::MockAction::Transfer { deposit, .. }] => {
            assert_eq!(*deposit, NearToken::from_millinear(100).saturating_sub(cost));
        }
        other => panic!("expected one transfer, got {other:?}"),
    }
}

#[test]
#[should_panic(expected = "version must be 1..=32 bytes")]
fn register_part_rejects_an_oversized_version() {
    let mut c = setup();
    ctx_storage("author.testnet", 0);
    c.register_part("big.part@1".into(), "v".repeat(33), U128(1), "h".into());
}

#[test]
#[should_panic(expected = "manifest_hash must be 1..=128 bytes")]
fn register_part_rejects_an_oversized_manifest_hash() {
    let mut c = setup();
    ctx_storage("author.testnet", 0);
    c.register_part("big.part@1".into(), "1".into(), U128(1), "h".repeat(129));
}

#[test]
#[should_panic(expected = "sealed_hash must be at most 128 bytes")]
fn publish_rejects_an_oversized_sealed_hash() {
    let mut c = setup();
    ctx_storage("creator.testnet", 0);
    c.publish_recipe("LONG".into(), "n".into(), "h".repeat(129), acct("runner.testnet"), all_parts(), U128(750_000), 0, None, None);
}

#[test]
fn publish_has_no_cap_on_parts_or_name_length_the_creator_pays_for_the_bytes() {
    // SRS-1 §12: nothing caps the nodes in a recipe. A big recipe only costs more storage.
    let mut c = setup();
    let parts = vec!["dust-filter".to_string(); 40];
    ctx_storage("creator.testnet", 0);
    let small = env::storage_usage();
    c.publish_recipe("ONE".into(), "n".into(), "h".into(), acct("runner.testnet"), vec!["dust-filter".to_string()], U128(750_000), 0, None, None);
    let small = env::storage_usage() - small;
    ctx_storage("creator.testnet", 0);
    let big = env::storage_usage();
    c.publish_recipe("MANY".into(), "n".repeat(200), "h".into(), acct("runner.testnet"), parts, U128(5_000_000), 0, None, None);
    let big = env::storage_usage() - big;
    assert!(big > small, "the bigger recipe stores (and pays for) more bytes");
    assert_eq!(c.get_recipe("MANY".into()).unwrap().parts.len(), 40);
}
