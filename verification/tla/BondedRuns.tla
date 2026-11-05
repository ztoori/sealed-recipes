---------------------------- MODULE BondedRuns ----------------------------
(***************************************************************************)
(* The run / quote / bond lifecycle of Sealed Recipes, including a buyer *)
(* who tries to drain the recipe's bond.                                   *)
(*                                                                         *)
(* Actors and what they control in this model:                            *)
(*  - the runner issues signed quotes (promised = the wallet's value at    *)
(*    the quoted minimum outputs, cover = min(promised, free bond)),       *)
(*    re-prices the job before executing, and reports the outcome;        *)
(*  - the contract checks quotes (issued, bound to the payer, unused,      *)
(*    cover <= promise, bond >= cover), locks and releases cover, and      *)
(*    pays compensation = min(cover, promised - reported delivered);       *)
(*  - the buyer (adversarial) may pay with any quote, move funds out of    *)
(*    the wallet at any moment, and deposit less than the runner asked;    *)
(*  - the market may lose up to Slip on a deposit, or fail and refund it.  *)
(*  - the creator may withdraw free bond at any time.                      *)
(*                                                                         *)
(* Values are abstract units at the quoted minimum-output prices, so a     *)
(* full deposit of value d delivers d - (market loss).                     *)
(*                                                                         *)
(* Rule = "v3"      : delivered is reported as measured (before this pass) *)
(* Rule = "credited": delivered + whatever the buyer withheld relative to  *)
(*                    the pre-execution re-check (runner/src/metrics.ts)   *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANTS Runs, Quotes, Buyers, MaxW, Slip, Bond0, Rule, NoQuote

VARIABLES avail, locked, withdrawn, compensated, wallet, quote, run, used

vars == <<avail, locked, withdrawn, compensated, wallet, quote, run, used>>

Min(a, b) == IF a <= b THEN a ELSE b
Max(a, b) == IF a >= b THEN a ELSE b


Statuses == {"idle", "pending", "checked", "done"}
Outcomes == {"-", "ok", "fail", "abort", "timeout"}

RunRec == [st: Statuses, buyer: Buyers \cup {"-"}, q: Quotes \cup {NoQuote}, promised: 0..MaxW,
           cover: 0..MaxW, fresh: 0..MaxW, executed: 0..MaxW, delivered: 0..MaxW, comp: 0..MaxW,
           outcome: Outcomes]
Idle == [st |-> "idle", buyer |-> "-", q |-> NoQuote, promised |-> 0, cover |-> 0, fresh |-> 0,
         executed |-> 0, delivered |-> 0, comp |-> 0, outcome |-> "-"]

RECURSIVE SumCover(_)
SumCover(S) == IF S = {} THEN 0 ELSE LET r == CHOOSE x \in S : TRUE IN
               (IF run[r].st \in {"pending", "checked"} THEN run[r].cover ELSE 0) + SumCover(S \ {r})

Init ==
  /\ avail = Bond0 /\ locked = 0 /\ withdrawn = 0 /\ compensated = 0
  /\ wallet = [b \in Buyers |-> MaxW]   \* every lower value is reachable by Drain
  /\ quote = [q \in Quotes |-> [issued |-> FALSE, buyer |-> "-", promised |-> 0, cover |-> 0]]
  /\ run = [r \in Runs |-> Idle]
  /\ used = {}

\* runner: dry run for buyer b's job; signed promise and cover
IssueQuote(q, b) ==
  /\ ~quote[q].issued
  /\ quote' = [quote EXCEPT ![q] = [issued |-> TRUE, buyer |-> b, promised |-> wallet[b],
                                     cover |-> Min(wallet[b], avail)]]
  /\ UNCHANGED <<avail, locked, withdrawn, compensated, wallet, run, used>>

\* contract: ft_on_transfer {"action":"run", quote} — every check of the v3 spec that matters here
PayQuoted(r, q, b) ==
  /\ run[r].st = "idle" /\ quote[q].issued
  /\ quote[q].buyer = b              \* signature binds the buyer
  /\ q \notin used                   \* single use
  /\ quote[q].cover <= quote[q].promised
  /\ avail >= quote[q].cover         \* bond below quoted cover -> rejected
  /\ avail' = avail - quote[q].cover /\ locked' = locked + quote[q].cover
  /\ used' = used \cup {q}
  /\ run' = [run EXCEPT ![r] = [Idle EXCEPT !.st = "pending", !.buyer = b, !.q = q,
                                 !.promised = quote[q].promised, !.cover = quote[q].cover]]
  /\ UNCHANGED <<withdrawn, compensated, wallet, quote>>

PayUnquoted(r, b) ==
  /\ run[r].st = "idle"
  /\ run' = [run EXCEPT ![r] = [Idle EXCEPT !.st = "pending", !.buyer = b]]
  /\ UNCHANGED <<avail, locked, withdrawn, compensated, wallet, quote, used>>

\* buyer: move funds out of the wallet at any moment
Drain(b) ==
  /\ \E w \in 0..(wallet[b] - 1) : wallet' = [wallet EXCEPT ![b] = w]
  /\ UNCHANGED <<avail, locked, withdrawn, compensated, quote, run, used>>

Release(r, outcome) ==
  /\ avail' = avail + run[r].cover /\ locked' = locked - run[r].cover
  /\ run' = [run EXCEPT ![r].st = "done", ![r].outcome = outcome]

\* runner: re-price right before executing (98% threshold); unquoted runs skip it
Recheck(r) ==
  /\ run[r].st = "pending"
  /\ LET fresh == wallet[run[r].buyer] IN
     IF run[r].q # NoQuote /\ fresh * 100 < run[r].promised * 98
     THEN Release(r, "abort")
     ELSE /\ run' = [run EXCEPT ![r].st = "checked", ![r].fresh = fresh]
          /\ UNCHANGED <<avail, locked>>
  /\ UNCHANGED <<withdrawn, compensated, wallet, quote, used>>

\* runner executes: scans the wallet, asks for transfers; buyer deposits d (maybe less: INCOMPLETE_DEPOSIT);
\* the market delivers d - loss, or fails and refunds. Then the signed report settles.
Execute(r) ==
  /\ run[r].st = "checked"
  /\ LET b == run[r].buyer IN
     \E d \in 0..wallet[b], loss \in 0..Slip, marketFails \in BOOLEAN :
       IF d = 0
       THEN /\ Release(r, "fail")              \* no deposit arrives: swap part times out, signed fail
            /\ UNCHANGED <<compensated, wallet>>
       ELSE LET complete  == d = wallet[b]
                executed  == IF complete THEN d ELSE 0          \* incomplete deposits are refunded, not executed
                delivered == IF complete /\ ~marketFails THEN Max(0, d - loss) ELSE 0
                reported  == IF Rule = "credited" THEN delivered + Max(0, run[r].fresh - executed) ELSE delivered
                comp      == Min(run[r].cover, Max(0, run[r].promised - reported))
            IN /\ wallet' = [wallet EXCEPT ![b] = wallet[b] - d + (IF complete /\ ~marketFails THEN 0 ELSE d)]
               /\ compensated' = compensated + comp
               /\ avail' = avail + run[r].cover - comp /\ locked' = locked - run[r].cover
               /\ run' = [run EXCEPT ![r].st = "done", ![r].outcome = "ok", ![r].executed = executed,
                                     ![r].delivered = delivered, ![r].comp = comp]
  /\ UNCHANGED <<withdrawn, quote, used>>

\* anyone: reclaim_run after the timeout
Reclaim(r) ==
  /\ run[r].st \in {"pending", "checked"}
  /\ Release(r, "timeout")
  /\ UNCHANGED <<withdrawn, compensated, wallet, quote, used>>

\* creator: withdraw_bond (free bond only)
Withdraw ==
  /\ \E x \in 1..avail : avail' = avail - x /\ withdrawn' = withdrawn + x
  /\ UNCHANGED <<locked, compensated, wallet, quote, run, used>>

Next ==
  \/ \E q \in Quotes, b \in Buyers : IssueQuote(q, b)
  \/ \E r \in Runs, q \in Quotes, b \in Buyers : PayQuoted(r, q, b)
  \/ \E r \in Runs, b \in Buyers : PayUnquoted(r, b)
  \/ \E b \in Buyers : Drain(b)
  \/ \E r \in Runs : Recheck(r) \/ Execute(r) \/ Reclaim(r)
  \/ Withdraw

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Properties                                                               *)
(***************************************************************************)
TypeOK == /\ avail \in Nat /\ locked \in Nat /\ run \in [Runs -> RunRec]

\* every token ever put in the bond is still there, was withdrawn by the creator, or compensated a buyer
BondConservation == avail + locked + withdrawn + compensated = Bond0

\* locked bond is exactly the cover of runs still in flight; free bond never goes negative
LockedIsInFlightCover == locked = SumCover(Runs) /\ avail >= 0

\* a quote pays for at most one run, and only for the buyer it was issued to
QuoteSingleUseAndBound ==
  \A q \in Quotes : /\ Cardinality({r \in Runs : run[r].q = q}) <= 1
                    /\ \A r \in Runs : run[r].q = q => run[r].buyer = quote[q].buyer

\* the bond pays only on a successful, signed run, and never more than the cover
CompensationOnlyOnOk == \A r \in Runs : run[r].comp > 0 => (run[r].outcome = "ok" /\ run[r].comp <= run[r].cover)

\* No bond drain: what the bond pays is bounded by the 2% re-check tolerance plus the market's actual loss on
\* what the buyer really handed over. Withholding funds, draining the wallet or deposits that never arrive
\* cannot turn into compensation.
NoBondDrain ==
  \A r \in Runs : run[r].outcome = "ok" =>
      run[r].comp * 100 <= run[r].promised * 2 + 100 * (run[r].executed - run[r].delivered)

\* an honest buyer (nothing drained, full deposit) whose promise the market missed is paid the whole
\* shortfall, up to the cover: the guarantee still means something after the anti-drain rule
HonestBuyerMadeWhole ==
  \A r \in Runs : (run[r].outcome = "ok" /\ run[r].q # NoQuote /\ run[r].executed = run[r].fresh
                    /\ run[r].fresh = run[r].promised) =>
      run[r].comp = Min(run[r].cover, run[r].promised - run[r].delivered)
=============================================================================
