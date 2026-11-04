--------------------------- MODULE VersionedRecipes ---------------------------
(***************************************************************************)
(* Recipe versions with a notice period (contract v4: update_sealed,       *)
(* cancel_update, apply_update / lazy activation) and the marketplace      *)
(* vault that keeps every version a pending run may still need.            *)
(* Retain = FALSE keeps only the current version: TLC then finds a run     *)
(* stranded without its recipe (MC_VersionsNoRetain.cfg).                  *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANTS Delay, MaxTime, MaxVersion, Runs, Retain

VARIABLES time, cur, pending, eff, announcedAt, activatedAt, vault, run

vars == <<time, cur, pending, eff, announcedAt, activatedAt, vault, run>>
None == 0

Init ==
  /\ time = 0 /\ cur = 1 /\ pending = None /\ eff = 0
  /\ announcedAt = [v \in 1..MaxVersion |-> -1] /\ activatedAt = [v \in 1..MaxVersion |-> IF v = 1 THEN 0 ELSE -1]
  /\ vault = {1}
  /\ run = [r \in Runs |-> [st |-> "idle", ver |-> 0, ran |-> 0]]

Tick == time < MaxTime /\ time' = time + 1 /\ UNCHANGED <<cur, pending, eff, announcedAt, activatedAt, vault, run>>

\* creator announces the next version: stored in the vault now, effective after Delay (replaces a pending one)
Announce ==
  /\ \E v \in (cur + 1)..MaxVersion :
       /\ announcedAt[v] = -1
       /\ pending' = v /\ eff' = time + Delay
       /\ announcedAt' = [announcedAt EXCEPT ![v] = time]
       /\ vault' = vault \cup {v}
  /\ UNCHANGED <<time, cur, activatedAt, run>>

Cancel == pending # None /\ pending' = None /\ eff' = 0 /\ UNCHANGED <<time, cur, announcedAt, activatedAt, vault, run>>

\* keeper apply_update, or lazily on the next run payment
Activate ==
  /\ pending # None /\ time >= eff
  /\ cur' = pending /\ pending' = None /\ eff' = 0
  /\ activatedAt' = [activatedAt EXCEPT ![pending] = time]
  /\ vault' = IF Retain THEN vault ELSE {pending}
  /\ UNCHANGED <<time, announcedAt, run>>

\* a run snapshots the version current at payment (the contract stores sealed_hash in the run)
Pay(r) ==
  /\ run[r].st = "idle"
  /\ run' = [run EXCEPT ![r] = [st |-> "pending", ver |-> cur, ran |-> 0]]
  /\ UNCHANGED <<time, cur, pending, eff, announcedAt, activatedAt, vault>>

\* the runner executes (possibly much later, e.g. after a crash and resume): it fetches the paid version
Execute(r) ==
  /\ run[r].st = "pending" /\ run[r].ver \in vault
  /\ run' = [run EXCEPT ![r].st = "done", ![r].ran = run[r].ver]
  /\ UNCHANGED <<time, cur, pending, eff, announcedAt, activatedAt, vault>>

Next == Tick \/ Announce \/ Cancel \/ Activate \/ \E r \in Runs : Pay(r) \/ Execute(r)
Spec == Init /\ [][Next]_vars

\* a version can only become current after it was announced at least Delay earlier
NoticeRespected == \A v \in 2..MaxVersion : activatedAt[v] >= 0 => activatedAt[v] >= announcedAt[v] + Delay
\* every run executes exactly the version it paid for
ExecutesPaidVersion == \A r \in Runs : run[r].st = "done" => run[r].ran = run[r].ver
\* a pending run can always still get its recipe
NoStrandedRun == \A r \in Runs : run[r].st = "pending" => run[r].ver \in vault
=============================================================================
