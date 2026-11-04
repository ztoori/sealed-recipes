---- MODULE VersionedRecipes_TTrace_1793825972 ----
EXTENDS Sequences, TLCExt, VersionedRecipes, Toolbox, VersionedRecipes_TEConstants, Naturals, TLC

_expression ==
    LET VersionedRecipes_TEExpression == INSTANCE VersionedRecipes_TEExpression
    IN VersionedRecipes_TEExpression!expression
----

_trace ==
    LET VersionedRecipes_TETrace == INSTANCE VersionedRecipes_TETrace
    IN VersionedRecipes_TETrace!trace
----

_inv ==
    ~(
        TLCGet("level") = Len(_TETrace)
        /\
        cur = (2)
        /\
        eff = (0)
        /\
        pending = (0)
        /\
        activatedAt = (<<0, 3, -1>>)
        /\
        run = ((r1 :> [st |-> "pending", ver |-> 1, ran |-> 0] @@ r2 :> [st |-> "idle", ver |-> 0, ran |-> 0]))
        /\
        time = (3)
        /\
        vault = ({2})
        /\
        announcedAt = (<<-1, 1, -1>>)
    )
----

_init ==
    /\ pending = _TETrace[1].pending
    /\ run = _TETrace[1].run
    /\ announcedAt = _TETrace[1].announcedAt
    /\ eff = _TETrace[1].eff
    /\ activatedAt = _TETrace[1].activatedAt
    /\ time = _TETrace[1].time
    /\ vault = _TETrace[1].vault
    /\ cur = _TETrace[1].cur
----

_next ==
    /\ \E i,j \in DOMAIN _TETrace:
        /\ \/ /\ j = i + 1
              /\ i = TLCGet("level")
        /\ pending  = _TETrace[i].pending
        /\ pending' = _TETrace[j].pending
        /\ run  = _TETrace[i].run
        /\ run' = _TETrace[j].run
        /\ announcedAt  = _TETrace[i].announcedAt
        /\ announcedAt' = _TETrace[j].announcedAt
        /\ eff  = _TETrace[i].eff
        /\ eff' = _TETrace[j].eff
        /\ activatedAt  = _TETrace[i].activatedAt
        /\ activatedAt' = _TETrace[j].activatedAt
        /\ time  = _TETrace[i].time
        /\ time' = _TETrace[j].time
        /\ vault  = _TETrace[i].vault
        /\ vault' = _TETrace[j].vault
        /\ cur  = _TETrace[i].cur
        /\ cur' = _TETrace[j].cur

\* Uncomment the ASSUME below to write the states of the error trace
\* to the given file in Json format. Note that you can pass any tuple
\* to `JsonSerialize`. For example, a sub-sequence of _TETrace.
    \* ASSUME
    \*     LET J == INSTANCE Json
    \*         IN J!JsonSerialize("VersionedRecipes_TTrace_1793825972.json", _TETrace)

=============================================================================

 Note that you can extract this module `VersionedRecipes_TEExpression`
  to a dedicated file to reuse `expression` (the module in the 
  dedicated `VersionedRecipes_TEExpression.tla` file takes precedence 
  over the module `VersionedRecipes_TEExpression` below).

---- MODULE VersionedRecipes_TEExpression ----
EXTENDS Sequences, TLCExt, VersionedRecipes, Toolbox, VersionedRecipes_TEConstants, Naturals, TLC

expression == 
    [
        \* To hide variables of the `VersionedRecipes` spec from the error trace,
        \* remove the variables below.  The trace will be written in the order
        \* of the fields of this record.
        pending |-> pending
        ,run |-> run
        ,announcedAt |-> announcedAt
        ,eff |-> eff
        ,activatedAt |-> activatedAt
        ,time |-> time
        ,vault |-> vault
        ,cur |-> cur
        
        \* Put additional constant-, state-, and action-level expressions here:
        \* ,_stateNumber |-> _TEPosition
        \* ,_pendingUnchanged |-> pending = pending'
        
        \* Format the `pending` variable as Json value.
        \* ,_pendingJson |->
        \*     LET J == INSTANCE Json
        \*     IN J!ToJson(pending)
        
        \* Lastly, you may build expressions over arbitrary sets of states by
        \* leveraging the _TETrace operator.  For example, this is how to
        \* count the number of times a spec variable changed up to the current
        \* state in the trace.
        \* ,_pendingModCount |->
        \*     LET F[s \in DOMAIN _TETrace] ==
        \*         IF s = 1 THEN 0
        \*         ELSE IF _TETrace[s].pending # _TETrace[s-1].pending
        \*             THEN 1 + F[s-1] ELSE F[s-1]
        \*     IN F[_TEPosition - 1]
    ]

=============================================================================



Parsing and semantic processing can take forever if the trace below is long.
 In this case, it is advised to uncomment the module below to deserialize the
 trace from a generated binary file.

\*
\*---- MODULE VersionedRecipes_TETrace ----
\*EXTENDS IOUtils, VersionedRecipes, VersionedRecipes_TEConstants, TLC
\*
\*trace == IODeserialize("VersionedRecipes_TTrace_1793825972.bin", TRUE)
\*
\*=============================================================================
\*

---- MODULE VersionedRecipes_TETrace ----
EXTENDS VersionedRecipes, VersionedRecipes_TEConstants, TLC

trace == 
    <<
    ([cur |-> 1,eff |-> 0,pending |-> 0,activatedAt |-> <<0, -1, -1>>,run |-> (r1 :> [st |-> "idle", ver |-> 0, ran |-> 0] @@ r2 :> [st |-> "idle", ver |-> 0, ran |-> 0]),time |-> 0,vault |-> {1},announcedAt |-> <<-1, -1, -1>>]),
    ([cur |-> 1,eff |-> 0,pending |-> 0,activatedAt |-> <<0, -1, -1>>,run |-> (r1 :> [st |-> "idle", ver |-> 0, ran |-> 0] @@ r2 :> [st |-> "idle", ver |-> 0, ran |-> 0]),time |-> 1,vault |-> {1},announcedAt |-> <<-1, -1, -1>>]),
    ([cur |-> 1,eff |-> 3,pending |-> 2,activatedAt |-> <<0, -1, -1>>,run |-> (r1 :> [st |-> "idle", ver |-> 0, ran |-> 0] @@ r2 :> [st |-> "idle", ver |-> 0, ran |-> 0]),time |-> 1,vault |-> {1, 2},announcedAt |-> <<-1, 1, -1>>]),
    ([cur |-> 1,eff |-> 3,pending |-> 2,activatedAt |-> <<0, -1, -1>>,run |-> (r1 :> [st |-> "idle", ver |-> 0, ran |-> 0] @@ r2 :> [st |-> "idle", ver |-> 0, ran |-> 0]),time |-> 2,vault |-> {1, 2},announcedAt |-> <<-1, 1, -1>>]),
    ([cur |-> 1,eff |-> 3,pending |-> 2,activatedAt |-> <<0, -1, -1>>,run |-> (r1 :> [st |-> "idle", ver |-> 0, ran |-> 0] @@ r2 :> [st |-> "idle", ver |-> 0, ran |-> 0]),time |-> 3,vault |-> {1, 2},announcedAt |-> <<-1, 1, -1>>]),
    ([cur |-> 1,eff |-> 3,pending |-> 2,activatedAt |-> <<0, -1, -1>>,run |-> (r1 :> [st |-> "pending", ver |-> 1, ran |-> 0] @@ r2 :> [st |-> "idle", ver |-> 0, ran |-> 0]),time |-> 3,vault |-> {1, 2},announcedAt |-> <<-1, 1, -1>>]),
    ([cur |-> 2,eff |-> 0,pending |-> 0,activatedAt |-> <<0, 3, -1>>,run |-> (r1 :> [st |-> "pending", ver |-> 1, ran |-> 0] @@ r2 :> [st |-> "idle", ver |-> 0, ran |-> 0]),time |-> 3,vault |-> {2},announcedAt |-> <<-1, 1, -1>>])
    >>
----


=============================================================================

---- MODULE VersionedRecipes_TEConstants ----
EXTENDS VersionedRecipes

CONSTANTS r1, r2

=============================================================================

---- CONFIG VersionedRecipes_TTrace_1793825972 ----
CONSTANTS
    Delay = 2
    MaxTime = 6
    MaxVersion = 3
    Runs = { r1 , r2 }
    Retain = FALSE
    r1 = r1
    r2 = r2

INVARIANT
    _inv

CHECK_DEADLOCK
    \* CHECK_DEADLOCK off because of PROPERTY or INVARIANT above.
    FALSE

INIT
    _init

NEXT
    _next

CONSTANT
    _TETrace <- _trace

ALIAS
    _expression
=============================================================================
\* Generated on Wed Nov 04 15:59:33 EST 2026