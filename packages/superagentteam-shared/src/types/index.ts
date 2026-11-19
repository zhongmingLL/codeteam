// F018 v1 shared contract types (R1-a).
//
// Dual-generation rule (plan 0021 §2.1): these types are defined fresh from
// the F018 architecture docs (0005/0007/0008/0009/0010/0011/0016/0017). They
// must not import, extend, or alias the legacy task-first types in
// superagentteam-daemon/src/legacy/task-first/control/stores/types.ts, and no
// file may depend on both generations. Enforced by
// scripts/check-legacy-boundary.mjs (shared package has zero tolerance).

export type SuperAgentTeamSharedVersion = "v1-r1-0";

export * from "./invocation.ts";
export * from "./message.ts";
export * from "./multi-mention.ts";
export * from "./thread.ts";
