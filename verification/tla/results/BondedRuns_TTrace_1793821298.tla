---- MODULE BondedRuns_TTrace_1793821298 ----
EXTENDS Sequences, TLCExt, Toolbox, BondedRuns, BondedRuns_TEConstants, Naturals, TLC

_expression ==
    LET BondedRuns_TEExpression == INSTANCE BondedRuns_TEExpression
    IN BondedRuns_TEExpression!expression
----

_trace ==
    LET BondedRuns_TETrace == INSTANCE BondedRuns_TETrace
    IN BondedRuns_TETrace!trace
----

_inv ==
    ~(
        TLCGet("level") = Len(_TETrace)
        /\
        compensated = (3)
        /\
        avail = (0)
        /\
        quote = ((q1 :> [buyer |-> b1, promised |-> 3, cover |-> 3, issued |-> TRUE] @@ q2 :> [buyer |-> "-", promised |-> 0, cover |-> 0, issued |-> FALSE]))
        /\
        wallet = ((b1 :> 3 @@ b2 :> 3))
        /\
        withdrawn = (0)
        /\
        run = ((r1 :> [st |-> "done", buyer |-> b1, q |-> q1, promised |-> 3, cover |-> 3, fresh |-> 3, executed |-> 0, delivered |-> 0, comp |-> 3, outcome |-> "ok"] @@ r2 :> [st |-> "idle", buyer |-> "-", q |-> "none", promised |-> 0, cover |-> 0, fresh |-> 0, executed |-> 0, delivered |-> 0, comp |-> 0, outcome |-> "-"]))
        /\
        used = ({q1})
        /\
        locked = (0)
    )
----

_init ==
    /\ quote = _TETrace[1].quote
    /\ run = _TETrace[1].run
    /\ wallet = _TETrace[1].wallet
    /\ compensated = _TETrace[1].compensated
    /\ used = _TETrace[1].used
    /\ withdrawn = _TETrace[1].withdrawn
    /\ locked = _TETrace[1].locked
    /\ avail = _TETrace[1].avail
----

_next ==
    /\ \E i,j \in DOMAIN _TETrace:
        /\ \/ /\ j = i + 1
              /\ i = TLCGet("level")
        /\ quote  = _TETrace[i].quote
        /\ quote' = _TETrace[j].quote
        /\ run  = _TETrace[i].run
        /\ run' = _TETrace[j].run
        /\ wallet  = _TETrace[i].wallet
        /\ wallet' = _TETrace[j].wallet
        /\ compensated  = _TETrace[i].compensated
        /\ compensated' = _TETrace[j].compensated
        /\ used  = _TETrace[i].used
        /\ used' = _TETrace[j].used
        /\ withdrawn  = _TETrace[i].withdrawn
        /\ withdrawn' = _TETrace[j].withdrawn
        /\ locked  = _TETrace[i].locked
        /\ locked' = _TETrace[j].locked
        /\ avail  = _TETrace[i].avail
        /\ avail' = _TETrace[j].avail

\* Uncomment the ASSUME below to write the states of the error trace
\* to the given file in Json format. Note that you can pass any tuple
\* to `JsonSerialize`. For example, a sub-sequence of _TETrace.
    \* ASSUME
    \*     LET J == INSTANCE Json
    \*         IN J!JsonSerialize("BondedRuns_TTrace_1793821298.json", _TETrace)

=============================================================================

 Note that you can extract this module `BondedRuns_TEExpression`
  to a dedicated file to reuse `expression` (the module in the 
  dedicated `BondedRuns_TEExpression.tla` file takes precedence 
  over the module `BondedRuns_TEExpression` below).

---- MODULE BondedRuns_TEExpression ----
EXTENDS Sequences, TLCExt, Toolbox, BondedRuns, BondedRuns_TEConstants, Naturals, TLC

expression == 
    [
        \* To hide variables of the `BondedRuns` spec from the error trace,
        \* remove the variables below.  The trace will be written in the order
        \* of the fields of this record.
        quote |-> quote
        ,run |-> run
        ,wallet |-> wallet
        ,compensated |-> compensated
        ,used |-> used
        ,withdrawn |-> withdrawn
        ,locked |-> locked
        ,avail |-> avail
        
        \* Put additional constant-, state-, and action-level expressions here:
        \* ,_stateNumber |-> _TEPosition
        \* ,_quoteUnchanged |-> quote = quote'
        
        \* Format the `quote` variable as Json value.
        \* ,_quoteJson |->
        \*     LET J == INSTANCE Json
        \*     IN J!ToJson(quote)
        
        \* Lastly, you may build expressions over arbitrary sets of states by
        \* leveraging the _TETrace operator.  For example, this is how to
        \* count the number of times a spec variable changed up to the current
        \* state in the trace.
        \* ,_quoteModCount |->
        \*     LET F[s \in DOMAIN _TETrace] ==
        \*         IF s = 1 THEN 0
        \*         ELSE IF _TETrace[s].quote # _TETrace[s-1].quote
        \*             THEN 1 + F[s-1] ELSE F[s-1]
        \*     IN F[_TEPosition - 1]
    ]

=============================================================================



Parsing and semantic processing can take forever if the trace below is long.
 In this case, it is advised to uncomment the module below to deserialize the
 trace from a generated binary file.

\*
\*---- MODULE BondedRuns_TETrace ----
\*EXTENDS IOUtils, BondedRuns, BondedRuns_TEConstants, TLC
\*
\*trace == IODeserialize("BondedRuns_TTrace_1793821298.bin", TRUE)
\*
\*=============================================================================
\*

---- MODULE BondedRuns_TETrace ----
EXTENDS BondedRuns, BondedRuns_TEConstants, TLC

trace == 
    <<
    ([compensated |-> 0,avail |-> 3,quote |-> (q1 :> [buyer |-> "-", promised |-> 0, cover |-> 0, issued |-> FALSE] @@ q2 :> [buyer |-> "-", promised |-> 0, cover |-> 0, issued |-> FALSE]),wallet |-> (b1 :> 3 @@ b2 :> 3),withdrawn |-> 0,run |-> (r1 :> [st |-> "idle", buyer |-> "-", q |-> "none", promised |-> 0, cover |-> 0, fresh |-> 0, executed |-> 0, delivered |-> 0, comp |-> 0, outcome |-> "-"] @@ r2 :> [st |-> "idle", buyer |-> "-", q |-> "none", promised |-> 0, cover |-> 0, fresh |-> 0, executed |-> 0, delivered |-> 0, comp |-> 0, outcome |-> "-"]),used |-> {},locked |-> 0]),
    ([compensated |-> 0,avail |-> 3,quote |-> (q1 :> [buyer |-> b1, promised |-> 3, cover |-> 3, issued |-> TRUE] @@ q2 :> [buyer |-> "-", promised |-> 0, cover |-> 0, issued |-> FALSE]),wallet |-> (b1 :> 3 @@ b2 :> 3),withdrawn |-> 0,run |-> (r1 :> [st |-> "idle", buyer |-> "-", q |-> "none", promised |-> 0, cover |-> 0, fresh |-> 0, executed |-> 0, delivered |-> 0, comp |-> 0, outcome |-> "-"] @@ r2 :> [st |-> "idle", buyer |-> "-", q |-> "none", promised |-> 0, cover |-> 0, fresh |-> 0, executed |-> 0, delivered |-> 0, comp |-> 0, outcome |-> "-"]),used |-> {},locked |-> 0]),
    ([compensated |-> 0,avail |-> 0,quote |-> (q1 :> [buyer |-> b1, promised |-> 3, cover |-> 3, issued |-> TRUE] @@ q2 :> [buyer |-> "-", promised |-> 0, cover |-> 0, issued |-> FALSE]),wallet |-> (b1 :> 3 @@ b2 :> 3),withdrawn |-> 0,run |-> (r1 :> [st |-> "pending", buyer |-> b1, q |-> q1, promised |-> 3, cover |-> 3, fresh |-> 0, executed |-> 0, delivered |-> 0, comp |-> 0, outcome |-> "-"] @@ r2 :> [st |-> "idle", buyer |-> "-", q |-> "none", promised |-> 0, cover |-> 0, fresh |-> 0, executed |-> 0, delivered |-> 0, comp |-> 0, outcome |-> "-"]),used |-> {q1},locked |-> 3]),
    ([compensated |-> 0,avail |-> 0,quote |-> (q1 :> [buyer |-> b1, promised |-> 3, cover |-> 3, issued |-> TRUE] @@ q2 :> [buyer |-> "-", promised |-> 0, cover |-> 0, issued |-> FALSE]),wallet |-> (b1 :> 3 @@ b2 :> 3),withdrawn |-> 0,run |-> (r1 :> [st |-> "checked", buyer |-> b1, q |-> q1, promised |-> 3, cover |-> 3, fresh |-> 3, executed |-> 0, delivered |-> 0, comp |-> 0, outcome |-> "-"] @@ r2 :> [st |-> "idle", buyer |-> "-", q |-> "none", promised |-> 0, cover |-> 0, fresh |-> 0, executed |-> 0, delivered |-> 0, comp |-> 0, outcome |-> "-"]),used |-> {q1},locked |-> 3]),
    ([compensated |-> 3,avail |-> 0,quote |-> (q1 :> [buyer |-> b1, promised |-> 3, cover |-> 3, issued |-> TRUE] @@ q2 :> [buyer |-> "-", promised |-> 0, cover |-> 0, issued |-> FALSE]),wallet |-> (b1 :> 3 @@ b2 :> 3),withdrawn |-> 0,run |-> (r1 :> [st |-> "done", buyer |-> b1, q |-> q1, promised |-> 3, cover |-> 3, fresh |-> 3, executed |-> 0, delivered |-> 0, comp |-> 3, outcome |-> "ok"] @@ r2 :> [st |-> "idle", buyer |-> "-", q |-> "none", promised |-> 0, cover |-> 0, fresh |-> 0, executed |-> 0, delivered |-> 0, comp |-> 0, outcome |-> "-"]),used |-> {q1},locked |-> 0])
    >>
----


=============================================================================

---- MODULE BondedRuns_TEConstants ----
EXTENDS BondedRuns

CONSTANTS r1, r2, q1, q2, b1, b2

=============================================================================

---- CONFIG BondedRuns_TTrace_1793821298 ----
CONSTANTS
    Runs = { r1 , r2 }
    Quotes = { q1 , q2 }
    Buyers = { b1 , b2 }
    MaxW = 3
    Slip = 1
    Bond0 = 3
    Rule = "v3"
    NoQuote = "none"
    q2 = q2
    q1 = q1
    r2 = r2
    b2 = b2
    r1 = r1
    b1 = b1

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
\* Generated on Wed Nov 04 14:41:39 EST 2026