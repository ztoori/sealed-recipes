----------------------------- MODULE DurableRuns -----------------------------
(***************************************************************************)
(* A durable run of a three-part recipe  scan -> swap -> merge  where the  *)
(* runner may crash at any moment and is resumed from the last checkpoint  *)
(* the marketplace stored. The swap is the irreversible step: the buyer's  *)
(* wallet deposits funds to a quoted deposit address once approved.        *)
(*                                                                         *)
(* Runner (runner/src/main.ts, executor.ts, parts/intents-swap.ts):        *)
(*  - after every part, stores a checkpoint and (checkpoint mode) bills    *)
(*    that part on-chain;                                                  *)
(*  - inside the swap: quotes, then (WAL = TRUE) stores the quotes before  *)
(*    asking for approval, and stores the signed tx hashes after it;       *)
(*  - on resume: continues from the stored checkpoint; inside the swap it  *)
(*    reuses the stored quotes, and an approval the marketplace already    *)
(*    relayed for them is replayed instead of asking the buyer again.      *)
(* Marketplace (server/src/main.ts): stores checkpoints, logs approvals    *)
(* atomically with executing the buyer's deposits, detects the crash.      *)
(* Contract: bills parts at checkpoints at most once; the final report     *)
(* pays the parts not billed yet.                                          *)
(*                                                                         *)
(* WAL = FALSE removes the write-ahead store before the approval request:  *)
(* TLC then finds a double deposit (MC_DurableNoWAL.cfg).                  *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANTS WAL, MaxCrashes, MaxQuotes

Parts == {"scan", "swap", "merge"}
Order == <<"scan", "swap", "merge">>

VARIABLES
  alive, crashes,          \* runner process
  pc, sub, q,              \* runner memory: next part index (1..4), swap sub-state, current quote id
  store,                   \* marketplace: last checkpoint [pc, sub, q]
  pending,                 \* marketplace: approval request shown to the buyer (quote id) or 0
  approvalLog,             \* marketplace: quote ids the buyer approved (logged with the deposit)
  deposits,                \* buyer's wallet: deposits made, per quote id
  nextQ,                   \* quote ids issued so far
  billed, paidFinal,       \* contract: parts billed at checkpoints / paid in the final receipt
  done

vars == <<alive, crashes, pc, sub, q, store, pending, approvalLog, deposits, nextQ, billed, paidFinal, done>>
Ckpt(p, s, qq) == [pc |-> p, sub |-> s, q |-> qq]

Init ==
  /\ alive = TRUE /\ crashes = 0
  /\ pc = 1 /\ sub = "none" /\ q = 0
  /\ store = Ckpt(1, "none", 0)
  /\ pending = 0 /\ approvalLog = {} /\ deposits = [i \in 1..MaxQuotes |-> 0] /\ nextQ = 0
  /\ billed = {} /\ paidFinal = {} /\ done = FALSE

\* a completed part: store the checkpoint (acknowledged), then bill it on-chain (may crash in between)
CompletePart(next) ==
  /\ pc' = next /\ sub' = "none" /\ q' = 0
  /\ store' = Ckpt(next, "none", 0)

Scan ==
  /\ alive /\ ~done /\ pc = 1
  /\ CompletePart(2)
  /\ UNCHANGED <<alive, crashes, pending, approvalLog, deposits, nextQ, billed, paidFinal, done>>

BillOnChain ==            \* checkpoint_run with parts_done = the part just finished; contract refuses a re-bill
  /\ alive /\ ~done /\ pc > 1 /\ sub = "none"
  /\ Order[pc - 1] \notin billed
  /\ billed' = billed \cup {Order[pc - 1]}
  /\ UNCHANGED <<alive, crashes, pc, sub, q, store, pending, approvalLog, deposits, nextQ, paidFinal, done>>

SwapQuote ==
  /\ alive /\ ~done /\ pc = 2 /\ sub = "none" /\ nextQ < MaxQuotes   \* MaxQuotes = MaxCrashes + 1: one fresh quote per restart
  /\ nextQ' = nextQ + 1 /\ q' = nextQ + 1 /\ sub' = "quoted"
  /\ UNCHANGED <<alive, crashes, pc, store, pending, approvalLog, deposits, billed, paidFinal, done>>

AskApproval ==           \* write-ahead: the quotes are stored before the buyer sees the request
  /\ alive /\ ~done /\ pc = 2 /\ sub = "quoted"
  /\ store' = IF WAL THEN Ckpt(2, "quoted", q) ELSE store
  /\ pending' = q /\ sub' = "asked"
  /\ UNCHANGED <<alive, crashes, pc, q, approvalLog, deposits, nextQ, billed, paidFinal, done>>

\* the buyer signs: deposits are executed and the approval is logged together, by the marketplace
BuyerApproves ==
  /\ pending # 0
  /\ deposits' = [deposits EXCEPT ![pending] = @ + 1]
  /\ approvalLog' = approvalLog \cup {pending}
  /\ pending' = 0
  /\ sub' = IF alive /\ sub = "asked" /\ q = pending THEN "approved" ELSE sub
  /\ UNCHANGED <<alive, crashes, pc, q, store, nextQ, billed, paidFinal, done>>

StoreSubmitted ==        \* tx hashes stored before submitting them to 1Click
  /\ alive /\ ~done /\ pc = 2 /\ sub = "approved"
  /\ store' = IF WAL THEN Ckpt(2, "submitted", q) ELSE store
  /\ sub' = "submitted"
  /\ UNCHANGED <<alive, crashes, pc, q, pending, approvalLog, deposits, nextQ, billed, paidFinal, done>>

SwapSettled ==
  /\ alive /\ ~done /\ pc = 2 /\ sub = "submitted"
  /\ CompletePart(3)
  /\ UNCHANGED <<alive, crashes, pending, approvalLog, deposits, nextQ, billed, paidFinal, done>>

MergeAndReport ==        \* last part, then the signed final report pays every part not billed yet
  /\ alive /\ ~done /\ pc = 3 /\ sub = "none"
  /\ pc' = 4 /\ store' = Ckpt(4, "none", 0)
  /\ paidFinal' = {p \in Parts : p \notin billed}
  /\ done' = TRUE
  /\ UNCHANGED <<alive, crashes, sub, q, pending, approvalLog, deposits, nextQ, billed>>

Crash ==
  /\ alive /\ ~done /\ crashes < MaxCrashes
  /\ alive' = FALSE /\ crashes' = crashes + 1
  /\ UNCHANGED <<pc, sub, q, store, pending, approvalLog, deposits, nextQ, billed, paidFinal, done>>

\* marketplace notices the broken stream: the open approval request is withdrawn (the buyer may still have
\* approved it just before; that approval is in the log)
Detect ==
  /\ ~alive /\ pending # 0
  /\ pending' = 0
  /\ UNCHANGED <<alive, crashes, pc, sub, q, store, approvalLog, deposits, nextQ, billed, paidFinal, done>>

Resume ==
  /\ ~alive /\ pending = 0
  /\ alive' = TRUE /\ pc' = store.pc /\ q' = store.q
  /\ sub' = CASE store.sub = "submitted"                        -> "submitted"
              [] store.sub = "quoted" /\ store.q \in approvalLog -> "approved"   \* replayed approval
              [] store.sub = "quoted"                            -> "quoted"     \* ask again, same quotes
              [] OTHER                                           -> "none"
  /\ UNCHANGED <<crashes, store, pending, approvalLog, deposits, nextQ, billed, paidFinal, done>>

Next == Scan \/ BillOnChain \/ SwapQuote \/ AskApproval \/ BuyerApproves \/ StoreSubmitted \/ SwapSettled
        \/ MergeAndReport \/ Crash \/ Detect \/ Resume

Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

(***************************************************************************)
TypeOK == pc \in 1..4 /\ sub \in {"none", "quoted", "asked", "approved", "submitted"}

\* the buyer's funds go into the swap at most once, however often the runner crashes
DepositsOnce == (LET S == {i \in 1..MaxQuotes : deposits[i] > 0} IN Cardinality(S) <= 1)
                /\ \A i \in 1..MaxQuotes : deposits[i] <= 1

\* every part's author is paid exactly once by the end: at a checkpoint or in the final receipt, never both
PaidExactlyOnce == done => (billed \cap paidFinal = {} /\ billed \cup paidFinal = Parts)

\* liveness: the run always completes (fairness; bounded crashes)
EventuallyDone == <>done
=============================================================================
