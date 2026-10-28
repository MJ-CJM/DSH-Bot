------------------------- MODULE bot_message -------------------------
EXTENDS Naturals, FiniteSets, TLC
CONSTANTS Bots, Versions, Messages, Limit, CheckEpoch
VARIABLES epoch, birth, payloadPresent, forgotten, barrier, approvalEpoch,
  approvalBirth, source, owner, dispatchState, quota, botQuota, log, projection,
  crashed, staleDispatch, crossBirth
vars == <<epoch, birth, payloadPresent, forgotten, barrier, approvalEpoch,
  approvalBirth, source, owner, dispatchState, quota, botQuota, log, projection,
  crashed, staleDispatch, crossBirth>>
Init == /\ epoch = 0 /\ birth = [b \in Bots |-> 0]
  /\ payloadPresent \in SUBSET Versions /\ forgotten = {} /\ barrier = FALSE
  /\ approvalEpoch = [m \in Messages |-> 0]
  /\ approvalBirth = [m \in Messages |-> 0]
  /\ source \in [Messages -> Versions] /\ owner \in [Messages -> Bots]
  /\ dispatchState = [m \in Messages |-> "new"] /\ quota = 0
  /\ botQuota = [b \in Bots |-> 0]
  /\ log = payloadPresent /\ projection = payloadPresent /\ crashed = FALSE
  /\ staleDispatch = FALSE /\ crossBirth = FALSE
Approve(m) == /\ ~crashed /\ ~barrier /\ dispatchState[m] = "new"
  /\ source[m] \in payloadPresent
  /\ approvalEpoch' = [approvalEpoch EXCEPT ![m] = epoch]
  /\ approvalBirth' = [approvalBirth EXCEPT ![m] = birth[owner[m]]]
  /\ dispatchState' = [dispatchState EXCEPT ![m] = "admitted"]
  /\ UNCHANGED <<epoch, birth, payloadPresent, forgotten, barrier, source,
    owner, quota, botQuota, log, projection, crashed, staleDispatch, crossBirth>>
Forget(v) == /\ ~crashed /\ ~barrier /\ epoch < 2 /\ v \in payloadPresent
  /\ epoch' = epoch + 1 /\ forgotten' = forgotten \cup {v}
  /\ payloadPresent' = payloadPresent \ {v} /\ log' = log \ {v}
  /\ barrier' = TRUE
  /\ UNCHANGED <<birth, approvalEpoch, approvalBirth, source, owner,
    dispatchState, quota, botQuota, projection, crashed, staleDispatch, crossBirth>>
Cleanup == /\ ~crashed /\ barrier /\ projection' = log /\ barrier' = FALSE
  /\ UNCHANGED <<epoch, birth, payloadPresent, forgotten, approvalEpoch,
    approvalBirth, source, owner, dispatchState, quota, botQuota, log, crashed,
    staleDispatch, crossBirth>>
AutoPublish(v, b) == /\ ~crashed /\ ~barrier /\ quota < Limit /\ botQuota[b] < 1
  /\ v \notin forgotten /\ v \notin payloadPresent
  /\ quota' = quota + 1 /\ payloadPresent' = payloadPresent \cup {v}
  /\ botQuota' = [botQuota EXCEPT ![b] = @ + 1]
  /\ log' = log \cup {v} /\ projection' = projection \cup {v}
  /\ UNCHANGED <<epoch, birth, forgotten, barrier, approvalEpoch,
    approvalBirth, source, owner, dispatchState, crashed, staleDispatch, crossBirth>>
Rebirth(b) == /\ ~crashed /\ birth[b] = 0
  /\ birth' = [birth EXCEPT ![b] = 1]
  /\ UNCHANGED <<epoch, payloadPresent, forgotten, barrier, approvalEpoch,
    approvalBirth, source, owner, dispatchState, quota, botQuota, log, projection,
    crashed, staleDispatch, crossBirth>>
Dispatch(m) == /\ ~crashed /\ ~barrier /\ dispatchState[m] = "admitted"
  /\ source[m] \in payloadPresent
  /\ (~CheckEpoch \/ approvalEpoch[m] = epoch)
  /\ approvalBirth[m] = birth[owner[m]] /\ quota < Limit /\ botQuota[owner[m]] < 1
  /\ dispatchState' = [dispatchState EXCEPT ![m] = "dispatching"]
  /\ quota' = quota + 1
  /\ botQuota' = [botQuota EXCEPT ![owner[m]] = @ + 1]
  /\ staleDispatch' = (staleDispatch \/ approvalEpoch[m] # epoch)
  /\ crossBirth' = (crossBirth \/ approvalBirth[m] # birth[owner[m]])
  /\ UNCHANGED <<epoch, birth, payloadPresent, forgotten, barrier,
    approvalEpoch, approvalBirth, source, owner, log, projection, crashed>>
Complete(m) == /\ ~crashed /\ dispatchState[m] = "dispatching"
  /\ dispatchState' = [dispatchState EXCEPT ![m] = "delivered"]
  /\ UNCHANGED <<epoch, birth, payloadPresent, forgotten, barrier,
    approvalEpoch, approvalBirth, source, owner, quota, botQuota, log, projection,
    crashed, staleDispatch, crossBirth>>
Crash == /\ ~crashed /\ crashed' = TRUE
  /\ UNCHANGED <<epoch, birth, payloadPresent, forgotten, barrier,
    approvalEpoch, approvalBirth, source, owner, dispatchState, quota, botQuota,
    log, projection, staleDispatch, crossBirth>>
Recover == /\ crashed /\ crashed' = FALSE /\ projection' = log
  /\ dispatchState' = [m \in Messages |->
    IF dispatchState[m] = "dispatching" THEN "unknown"
    ELSE IF dispatchState[m] = "admitted" THEN "cancelled" ELSE dispatchState[m]]
  /\ UNCHANGED <<epoch, birth, payloadPresent, forgotten, barrier,
    approvalEpoch, approvalBirth, source, owner, quota, botQuota, log, staleDispatch, crossBirth>>
Next == (\E m \in Messages: Approve(m) \/ Dispatch(m) \/ Complete(m))
  \/ (\E v \in Versions: Forget(v) \/ (\E b \in Bots: AutoPublish(v, b)))
  \/ (\E b \in Bots: Rebirth(b)) \/ Cleanup \/ Crash \/ Recover
Spec == Init /\ [][Next]_vars
NoStaleGrant == ~staleDispatch
NoCrossBirth == ~crossBirth
NoResurrection == payloadPresent \cap forgotten = {}
NoOverQuota == quota <= Limit /\ \A b \in Bots: botQuota[b] <= 1
DurableRebuild == (~crashed /\ ~barrier) => projection = log
TypeOK == /\ epoch \in 0..2 /\ birth \in [Bots -> 0..1]
  /\ payloadPresent \subseteq Versions /\ forgotten \subseteq Versions
  /\ quota \in 0..Limit
=============================================================================
