#!/usr/bin/env python3
"""
Runs every machine-checked proof and writes verification/RESULTS.json.

  python3 verification/run.py          Z3 proofs (money, auction) + conformance freshness check   (~10 s)
  python3 verification/run.py --tla    also model-check the run/quote/bond lifecycle with TLC     (~10 min)

Requires: pip install z3-solver; for --tla, Java 11+ and tla2tools.jar (TLA2TOOLS env var or tools/tla2tools.jar).
Exit code 0 only if every theorem has its expected outcome, the conformance vectors are current, and (with
--tla) the fixed rule passes every invariant while the previous rule is caught violating NoBondDrain.
"""
import json, os, re, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "smt"))
import prove_money, prove_auction, gen_conformance  # noqa: E402

ok = True
print("== Z3: settlement, bonds, dividends"); m = prove_money.main()
print("== Z3: batch auction"); a = prove_auction.main()
results = m.results + a.results
bad = [r for r in results if not r["ok"]]
ok &= not bad
print(f"\nZ3: {len(results) - len(bad)}/{len(results)} theorems as expected")
print("== conformance vectors are generated from the proved models and current")
sys.argv.append("--check"); rc = gen_conformance.main(); sys.argv.remove("--check")
ok &= rc == 0
print("   current" if rc == 0 else "   STALE")

tla = None
if "--tla" in sys.argv:
    jar = os.environ.get("TLA2TOOLS") or str(HERE.parent / "tools" / "tla2tools.jar")
    tla = {}
    for cfg, expect in (("MC_credited", "pass"), ("MC_v3", "NoBondDrain")):
        print(f"== TLC {cfg} (expect {expect})")
        p = subprocess.run(["java", "-XX:+UseParallelGC", "-cp", jar, "tlc2.TLC", "-workers", "auto", "-deadlock",
                            "-metadir", f"/tmp/tlc-{cfg}", "-config", f"{cfg}.cfg", "BondedRuns.tla"],
                           cwd=HERE / "tla", capture_output=True, text=True)
        log = "\n".join(l for l in p.stdout.splitlines() if not l.startswith("Picked up"))
        (HERE / "tla" / "results" / f"{cfg}.log").write_text(log + "\n")
        for f in (HERE / "tla").glob("BondedRuns_TTrace_*"):
            f.replace(HERE / "tla" / "results" / f.name)
        got = "pass" if "No error has been found" in log else (re.search(r"Invariant (\w+) is violated", log) or [None, "error"])[1]
        states = re.search(r"([\d,]+) distinct states found", log)
        tla[cfg] = {"expected": expect, "got": got, "distinct_states": states.group(1) if states else None}
        print(f"   {got} ({tla[cfg]['distinct_states']} distinct states)")
        ok &= got == expect

out = {"z3": json.loads(json.dumps(results)), "tla": tla}
prev = HERE / "RESULTS.json"
if tla is None and prev.exists():
    out["tla"] = json.loads(prev.read_text()).get("tla")  # keep the last full TLC run
prev.write_text(json.dumps(out, indent=1) + "\n")
print("\nALL AS EXPECTED" if ok else "\nFAILED")
sys.exit(0 if ok else 1)
