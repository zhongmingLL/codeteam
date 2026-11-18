// F018 v1 shared contract types (R1-0 skeleton).
//
// Dual-generation rule (plan 0021 §2.1): these types are defined fresh from
// the F018 architecture docs (0005/0007/0008/0011/0016/0017). They must not
// import, extend, or alias the legacy task-first types in
// superagentteam-daemon/src/legacy/task-first/control/stores/types.ts, and no
// file may depend on both generations. Enforced by
// scripts/check-legacy-boundary.mjs (v1 paths) and review.
//
// R1-a fills in: Thread, ThreadParticipant, StoredMessage, MessageLifecycle,
// AgentSession, AgentReadState, AgentConfig, InvocationRecord,
// InvocationAttempt, TurnExecution, QueueEntry, QueueAdmission, QueueTarget,
// QueueClaim, InvocationCredential, Worker, WorkerBinding, DraftRecord.

export type SuperAgentTeamSharedVersion = "v1-r1-0";
