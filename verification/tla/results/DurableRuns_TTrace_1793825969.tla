---- MODULE DurableRuns_TTrace_1793825969 ----
EXTENDS Sequences, TLCExt, DurableRuns, Toolbox, Naturals, TLC

_expression ==
    LET DurableRuns_TEExpression == INSTANCE DurableRuns_TEExpression
    IN DurableRuns_TEExpression!expression
----

_trace ==
    LET DurableRuns_TETrace == INSTANCE DurableRuns_TETrace
    IN DurableRuns_TETrace!trace
----

_inv ==
    ~(
        TLCGet("level") = Len(_TETrace)
        /\
        sub = ("approved")
        /\
        nextQ = (2)
        /\
        alive = (TRUE)
        /\
        pending = (0)
        /\
        store = ([pc |-> 2, sub |-> "none", q |-> 0])
        /\
        crashes = (1)
        /\
        paidFinal = ({})
        /\
        done = (FALSE)
        /\
        deposits = (<<1, 1, 0, 0>>)
        /\
        q = (2)
        /\
        pc = (2)
        /\
        billed = ({})
        /\
        approvalLog = ({1, 2})
    )
----

_init ==
    /\ pending = _TETrace[1].pending
    /\ nextQ = _TETrace[1].nextQ
    /\ sub = _TETrace[1].sub
    /\ store = _TETrace[1].store
    /\ done = _TETrace[1].done
    /\ crashes = _TETrace[1].crashes
    /\ alive = _TETrace[1].alive
    /\ deposits = _TETrace[1].deposits
    /\ q = _TETrace[1].q
    /\ approvalLog = _TETrace[1].approvalLog
    /\ paidFinal = _TETrace[1].paidFinal
    /\ pc = _TETrace[1].pc
    /\ billed = _TETrace[1].billed
----

_next ==
    /\ \E i,j \in DOMAIN _TETrace:
        /\ \/ /\ j = i + 1
              /\ i = TLCGet("level")
        /\ pending  = _TETrace[i].pending
        /\ pending' = _TETrace[j].pending
        /\ nextQ  = _TETrace[i].nextQ
        /\ nextQ' = _TETrace[j].nextQ
        /\ sub  = _TETrace[i].sub
        /\ sub' = _TETrace[j].sub
        /\ store  = _TETrace[i].store
        /\ store' = _TETrace[j].store
        /\ done  = _TETrace[i].done
        /\ done' = _TETrace[j].done
        /\ crashes  = _TETrace[i].crashes
        /\ crashes' = _TETrace[j].crashes
        /\ alive  = _TETrace[i].alive
        /\ alive' = _TETrace[j].alive
        /\ deposits  = _TETrace[i].deposits
        /\ deposits' = _TETrace[j].deposits
        /\ q  = _TETrace[i].q
        /\ q' = _TETrace[j].q
        /\ approvalLog  = _TETrace[i].approvalLog
        /\ approvalLog' = _TETrace[j].approvalLog
        /\ paidFinal  = _TETrace[i].paidFinal
        /\ paidFinal' = _TETrace[j].paidFinal
        /\ pc  = _TETrace[i].pc
        /\ pc' = _TETrace[j].pc
        /\ billed  = _TETrace[i].billed
        /\ billed' = _TETrace[j].billed

\* Uncomment the ASSUME below to write the states of the error trace
\* to the given file in Json format. Note that you can pass any tuple
\* to `JsonSerialize`. For example, a sub-sequence of _TETrace.
    \* ASSUME
    \*     LET J == INSTANCE Json
    \*         IN J!JsonSerialize("DurableRuns_TTrace_1793825969.json", _TETrace)

=============================================================================

 Note that you can extract this module `DurableRuns_TEExpression`
  to a dedicated file to reuse `expression` (the module in the 
  dedicated `DurableRuns_TEExpression.tla` file takes precedence 
  over the module `DurableRuns_TEExpression` below).

---- MODULE DurableRuns_TEExpression ----
EXTENDS Sequences, TLCExt, DurableRuns, Toolbox, Naturals, TLC

expression == 
    [
        \* To hide variables of the `DurableRuns` spec from the error trace,
        \* remove the variables below.  The trace will be written in the order
        \* of the fields of this record.
        pending |-> pending
        ,nextQ |-> nextQ
        ,sub |-> sub
        ,store |-> store
        ,done |-> done
        ,crashes |-> crashes
        ,alive |-> alive
        ,deposits |-> deposits
        ,q |-> q
        ,approvalLog |-> approvalLog
        ,paidFinal |-> paidFinal
        ,pc |-> pc
        ,billed |-> billed
        
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
\*---- MODULE DurableRuns_TETrace ----
\*EXTENDS IOUtils, DurableRuns, TLC
\*
\*trace == IODeserialize("DurableRuns_TTrace_1793825969.bin", TRUE)
\*
\*=============================================================================
\*

---- MODULE DurableRuns_TETrace ----
EXTENDS DurableRuns, TLC

trace == 
    <<
    ([sub |-> "none",nextQ |-> 0,alive |-> TRUE,pending |-> 0,store |-> [pc |-> 1, sub |-> "none", q |-> 0],crashes |-> 0,paidFinal |-> {},done |-> FALSE,deposits |-> <<0, 0, 0, 0>>,q |-> 0,pc |-> 1,billed |-> {},approvalLog |-> {}]),
    ([sub |-> "none",nextQ |-> 0,alive |-> TRUE,pending |-> 0,store |-> [pc |-> 2, sub |-> "none", q |-> 0],crashes |-> 0,paidFinal |-> {},done |-> FALSE,deposits |-> <<0, 0, 0, 0>>,q |-> 0,pc |-> 2,billed |-> {},approvalLog |-> {}]),
    ([sub |-> "quoted",nextQ |-> 1,alive |-> TRUE,pending |-> 0,store |-> [pc |-> 2, sub |-> "none", q |-> 0],crashes |-> 0,paidFinal |-> {},done |-> FALSE,deposits |-> <<0, 0, 0, 0>>,q |-> 1,pc |-> 2,billed |-> {},approvalLog |-> {}]),
    ([sub |-> "asked",nextQ |-> 1,alive |-> TRUE,pending |-> 1,store |-> [pc |-> 2, sub |-> "none", q |-> 0],crashes |-> 0,paidFinal |-> {},done |-> FALSE,deposits |-> <<0, 0, 0, 0>>,q |-> 1,pc |-> 2,billed |-> {},approvalLog |-> {}]),
    ([sub |-> "approved",nextQ |-> 1,alive |-> TRUE,pending |-> 0,store |-> [pc |-> 2, sub |-> "none", q |-> 0],crashes |-> 0,paidFinal |-> {},done |-> FALSE,deposits |-> <<1, 0, 0, 0>>,q |-> 1,pc |-> 2,billed |-> {},approvalLog |-> {1}]),
    ([sub |-> "approved",nextQ |-> 1,alive |-> FALSE,pending |-> 0,store |-> [pc |-> 2, sub |-> "none", q |-> 0],crashes |-> 1,paidFinal |-> {},done |-> FALSE,deposits |-> <<1, 0, 0, 0>>,q |-> 1,pc |-> 2,billed |-> {},approvalLog |-> {1}]),
    ([sub |-> "none",nextQ |-> 1,alive |-> TRUE,pending |-> 0,store |-> [pc |-> 2, sub |-> "none", q |-> 0],crashes |-> 1,paidFinal |-> {},done |-> FALSE,deposits |-> <<1, 0, 0, 0>>,q |-> 0,pc |-> 2,billed |-> {},approvalLog |-> {1}]),
    ([sub |-> "quoted",nextQ |-> 2,alive |-> TRUE,pending |-> 0,store |-> [pc |-> 2, sub |-> "none", q |-> 0],crashes |-> 1,paidFinal |-> {},done |-> FALSE,deposits |-> <<1, 0, 0, 0>>,q |-> 2,pc |-> 2,billed |-> {},approvalLog |-> {1}]),
    ([sub |-> "asked",nextQ |-> 2,alive |-> TRUE,pending |-> 2,store |-> [pc |-> 2, sub |-> "none", q |-> 0],crashes |-> 1,paidFinal |-> {},done |-> FALSE,deposits |-> <<1, 0, 0, 0>>,q |-> 2,pc |-> 2,billed |-> {},approvalLog |-> {1}]),
    ([sub |-> "approved",nextQ |-> 2,alive |-> TRUE,pending |-> 0,store |-> [pc |-> 2, sub |-> "none", q |-> 0],crashes |-> 1,paidFinal |-> {},done |-> FALSE,deposits |-> <<1, 1, 0, 0>>,q |-> 2,pc |-> 2,billed |-> {},approvalLog |-> {1, 2}])
    >>
----


=============================================================================

---- CONFIG DurableRuns_TTrace_1793825969 ----
CONSTANTS
    WAL = FALSE
    MaxCrashes = 3
    MaxQuotes = 4

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
\* Generated on Wed Nov 04 15:59:30 EST 2026