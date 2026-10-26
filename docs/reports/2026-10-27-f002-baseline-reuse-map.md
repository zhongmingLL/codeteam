---
title: "F002 Phase 4 baseline reuse map"
doc_kind: report
status: current
created: 2026-10-27
updated: 2026-10-27
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
---

# F002 Phase 4 baseline reuse map

> Scope: decide reuse vs fresh for control plane, store, pi adapter, verifier, eval, and CLI before
> W1 starts writing schema. No executable codeteam code was found on this host; the baseline is fresh.

## 1. Source search

The discussion directory exists but is untracked, and the runnable assets named by the architecture
doc are absent:

```text
$ git -C /home/ming/agent/clowder-ai ls-files codeteam
(no output: the whole directory is untracked)

$ git -C /home/ming/agent/clowder-ai status --short codeteam
?? codeteam/

$ find /home/ming/agent -maxdepth 7 -path "*codeteam/src/control-plane.ts"
(no output; the same holds for types.ts, sqlite-store.ts, workflow.ts, orchestrator.ts, cli.ts)
```

`/home/ming/agent/clowder-ai/codeteam/` contains architecture notes, plans, reuse cards, and
`.cat-cafe/` state — no `packages/codeteam` source. The architecture doc's "Phase 0–4 已落地" is a
discussion-time claim, not an asset inventory. It must not be used as evidence that anything exists.

No old implementation was found in any other local checkout under `/home/ming/agent` either.

## 2. Fresh baseline declaration

- W1 starts from synthetic fixtures and an empty database. There is **no backfill** and no migration
  of old codeteam data.
- `clowder-ai/codeteam/` remains discussion history. The working copy of the same docs lives in this
  repository under `docs/` and is the code-side truth source.
- Reuse decisions below are about **contract semantics** from the Clowder reference, not about
  importing Clowder packages, stores, credentials, or deployment assumptions.

## 3. Asset matrix

| Asset | Old codeteam source | Clowder reference | Decision | Reason | W1 migration input |
|---|---|---|---|---|---|
| Control plane | None; `packages/codeteam/src/control-plane.ts` claimed but absent | `docs/reuse/dispatch.md` (ADR-043 / F117 Phase D; `QueueLedger`, `InvocationQueue`, `QueueProcessor`) | **adapt** | Reuse the single pending-wake ledger contract and the A2A chain semantics; the execution kernel is pi, so the code is new | Build `queue_entries`, `messages.dispatch_refs_json`, `runs.queue_entry_id`; no per-target queue rows |
| Store | None; `sqlite-store.ts` claimed but absent | `RedisQueueLedgerStore` is a Clowder deployment shape, not a contract | **fresh** | No data to migrate and Redis is not a codeteam dependency; SQLite keeps W1 local and testable | New SQLite schema + migration + down/rollback; synthetic fixtures only |
| pi adapter | None before W0a; **landed in this feature** as `packages/codeteam-pi-adapter` | pi v1.4.0 SDK (`DefaultResourceLoader`, `SessionManager`, `createAgentSession`) | **reuse (keep)** | L0 injection, compaction survival, cross-process resume, and curated skills are already proven in F002 Phase 1–2 | Extend the adapter; do not introduce a second session/L0 path |
| Verifier | None; `verifier/policy.ts` and `verifier/closure.ts` claimed but absent | `docs/reuse/harness-eval.md` (`VerdictHandoffPacket`, immutable findings, append-only lifecycle) | **adapt** | Reuse verdict/finding semantics; there is no parser or closure code to port | W3 verifier policy + closure built on the verdict envelope; review independence uses profile + session + model family |
| Eval | None; `eval/scoring.ts` claimed but absent | `docs/reuse/harness-eval.md` (F267 measurement validity; F266/F278 are reference-only) | **adapt** | Borrow metric-validity semantics, not a ledger; codeteam has no eval data yet | W6 adds build/test/merge metrics; W1 only leaves typed stubs, no fake scores |
| CLI | None; `cli.ts` claimed but absent | pi CLI provides runtime commands; Clowder's chat/Hub CLI is not a repo-native runner | **fresh** | A code-team CLI needs worktree/task/verify commands and stable exit codes, not chat plumbing | Thin `codeteam` CLI in W1: task/run/worktree/verify commands with machine-readable output |

## 4. W1 inputs

1. `queue_entries` and message dispatch refs per the dispatch card; one ledger, no second queue.
2. A fresh SQLite store with explicit migration and down path, seeded only by synthetic fixtures.
3. The existing `@codeteam/pi-adapter` and `@codeteam/skills` packages as the only session/skill path.
4. A verifier interface shaped by `VerdictHandoffPacket` (finding + severity + stance), implemented later in W3.
5. Typed eval stubs that fail closed instead of returning placeholder scores.
6. A thin CLI that prints machine-readable results and exits non-zero on failed verification.

## 5. Re-verification

```bash
git -C "${CLOWDER_AI_SOURCE:-/home/ming/agent/clowder-ai}" ls-files codeteam | head
find /home/ming/agent -maxdepth 7 -path "*codeteam/src/control-plane.ts"
```

Both should stay empty until a real implementation exists. If a source appears later, update this
card and the reuse matrix before using it.
