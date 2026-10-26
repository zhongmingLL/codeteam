---
title: "F002 Phase 1 L0 compiler slice"
doc_kind: report
status: current
created: 2026-10-27
updated: 2026-10-27
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
---

# F002 Phase 1 L0 compiler slice

> Scope: the first Phase 1 slice only. It implements the L0 compiler v0 and the native
> system-prompt resource-loader helper. It does not yet prove compaction preservation, prompt
> cache behavior, or cross-process session export/resume.

## What changed

- `packages/codeteam-pi-adapter` workspace package.
- `src/l0/compiler.ts`: deterministic role template + governance compilation, SHA-256 revision.
- `src/l0/templates/{coder,reviewer,verifier}.md`.
- `src/session/resource-loader.ts`: `DefaultResourceLoader` with:
  - `systemPromptOverride` = compiled L0;
  - `noContextFiles: true`;
  - `appendSystemPromptOverride: () => []`;
  - no extensions, skills, prompt templates, or themes.
- Root `build` / `build:offline` now build the adapter after the pi coding-agent package.

## Verification

| Check | Command | Result |
|---|---|---|
| Build | `NODE_ENV=development npm run build:offline` | exit 0; adapter dist + templates generated |
| Adapter tests | `NODE_ENV=development npm test --workspace @codeteam/pi-adapter` | 2 files, 6 tests pass |
| Root check | `NODE_ENV=development npm run check` | exit 0 |
| Audit | `node scripts/npm-audit.mjs` | exit 0 |

The loader test writes an `AGENTS.md` containing a sentinel string, then verifies the compiled
L0 is the effective system prompt, append prompts are empty, and the sentinel is not loaded.

## Not yet verified

- auto/manual compaction preserves L0 in the first post-compaction request;
- prompt-cache evidence when the L0 section is stable;
- session export/resume across processes;
- the real `createAgentSession` integration with a recording provider.

These remain Phase 1 acceptance work; this slice must not be reported as the Phase 1 gate.
