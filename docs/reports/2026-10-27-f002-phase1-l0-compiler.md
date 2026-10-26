---
title: "F002 Phase 1 L0/session slice"
doc_kind: report
status: current
created: 2026-10-27
updated: 2026-10-27
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
---

# F002 Phase 1 L0 compiler slice

> Scope: the Phase 1 core slice. It implements L0 compilation, native system-prompt injection,
> fake-provider compaction evidence, and cross-process JSONL resume. It does not prove live
> provider prompt-cache hits or RPC worker behavior (W5).

## What changed

- `packages/codeteam-pi-adapter` workspace package.
- `src/l0/compiler.ts`: deterministic role template + governance compilation, SHA-256 revision.
- `src/l0/templates/{coder,reviewer,verifier}.md`.
- `src/session/resource-loader.ts`: `DefaultResourceLoader` with:
  - `systemPromptOverride` = compiled L0;
  - `noContextFiles: true`;
  - `appendSystemPromptOverride: () => []`;
  - no extensions, skills, prompt templates, or themes.
- `src/session/session.ts`: `createAgentSessionWithL0` wrapper around the public SDK session factory.
- `test/session-compaction.test.ts`: fake-provider session evidence for manual/threshold compaction,
  system-hash stability, and cross-process resume.
- `test/fixtures/resume-session.mjs`: child-process JSONL resume fixture.
- Root `build` / `build:offline` now build the adapter after the pi coding-agent package.

## Verification

| Check | Command | Result |
|---|---|---|
| Build | `NODE_ENV=development npm run build:offline` | exit 0; adapter dist + templates generated |
| Adapter tests | `NODE_ENV=development npm test --workspace @codeteam/pi-adapter` | 3 files, 10 tests pass |
| Root check | `NODE_ENV=development npm run check` | exit 0 |
| Audit | `node scripts/npm-audit.mjs` | exit 0 |

The tests verify:

- deterministic L0 revision (role/section order/line-ending normalization);
- `AGENTS.md` sentinel not loaded, append prompts empty, effective system prompt == compiled L0;
- manual `session.compact()` preserves L0 in the first post-compaction request;
- threshold auto-compaction preserves L0 in the next normal request;
- system hash is stable across normal requests;
- a child process opens the exported JSONL, restores the parent message content (asserted by exact
  `parentCount + 2` after continue), keeps the same L0 revision, and successfully continues with
  another prompt. Model/thinking values are configured defaults in this fixture, not continuity
  evidence.

`cache_observability=unavailable` for the fake provider. The stable system hash is the cache
evidence available at this layer; no live prompt-cache hit is claimed.

## Remaining boundaries

- Live provider prompt-cache metrics are not observed; the adapter records stable system hashes only.
- RPC worker migration and re-attach semantics remain W5.
- Independent review of this Phase 1 slice is still required before the Phase 1 gate is closed.
