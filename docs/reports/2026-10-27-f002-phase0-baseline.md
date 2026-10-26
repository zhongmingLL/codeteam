---
title: "F002 Phase 0 baseline evidence"
doc_kind: report
status: current
created: 2026-10-27
updated: 2026-10-27
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
---

# F002 Phase 0 baseline evidence

> Scope: W0a Phase 0 only — docs/plans truth source, clean-checkout reproduction,
> CI coverage, supply-chain minimum, and branch protection. This is not the W0a
> gate report and does not authorize W1.

## Environment

| Item | Value |
|---|---|
| Host | WSL2, Linux `6.6.87.2-microsoft-standard-WSL2` |
| Node / npm | `v24.19.0` / `11.17.0` |
| Base commit | `8fab3265b` (`codeteam-work`) |
| Worktree | `/home/ming/agent/codeteam-f002-p0-baseline` |
| Branch | `feat/f002-p0-baseline` |
| Data boundary | isolated temp/worktree only; no production user data |

## Results

| Check | Command | Result |
|---|---|---|
| Plans truth source | `git ls-files docs/plans` | 8 files tracked |
| Install | `NODE_ENV=development npm install --ignore-scripts` | pass; exit 0 |
| Pinned catalog | `curl` pinned revision + `node packages/ai/scripts/hydrate-model-catalog.ts` | pass; 43 provider files |
| Build | `NODE_ENV=development npm run build:offline` | pass; exit 0 |
| Check | `NODE_ENV=development npm run check` | pass; exit 0 |
| Production audit | `node scripts/npm-audit.mjs` | pass after safe fixes + accepted zod exception |
| Registry signatures | `npm audit signatures --omit=dev` | pass; 137 packages verified |
| Full tests | `NODE_ENV=development ./test.sh` | exit 1; failures below |
| CI YAML parse | Node `yaml` parse of `.github/workflows/ci.yml` | pass; 4 jobs |

`npm install` reports 12 advisories across the full tree (5 moderate, 7 high);
the production audit is the blocking gate and passes. The remaining full-tree
advisories are outside the production audit scope and remain a W0b follow-up.

## Full test result

`./test.sh` exited 1 with the same host/baseline failures already recorded in
`docs/reports/2026-10-26-pi-v1.4.0-baseline.md`, plus 7 `packages/ai` failures:

| Package | Result | Notes |
|---|---|---|
| `packages/ai` | 2 files failed / 7 tests failed; 148 files passed | classifier/Cloudflare fixture mismatch |
| `packages/coding-agent` | 4 files failed / 14 tests failed; 299 files passed | 1 auth-storage, 12 clipboard, 1 model-runtime |
| `packages/env` | 6 suites failed | Rust daemon missing; no `cargo`/`rustc` on host |
| Other packages | pass | agent, codemod, durable workers, evals, mcp, telemetry, tui |

The 7 `packages/ai` failures were reproduced in the base `codeteam-work` worktree
with the same targeted command, so they are not introduced by Phase 0:

```bash
cd packages/ai
NODE_ENV=development npx vitest --run \
  test/classifier-models.test.ts \
  test/cloudflare-workers-ai-system-one.test.ts
# exit 1: same 7 failures; pinned catalog lacks the fixture fields the tests expect
```

This host is not a full-test green environment. The CI runs on `ubuntu-latest`;
WSL2-only failures must not be reported as a project-wide pass.

## CI changes

`.github/workflows/ci.yml` now:

- triggers on `push` and `pull_request` for `main` and `codeteam-work`;
- grants only `contents: read`;
- keeps `build-check-test` and `mcp-conformance`;
- adds `codeteam-package-tests` (`NODE_ENV=development npm test --workspaces --if-present`);
- adds `supply-chain` (`npm ci --ignore-scripts --no-audit --no-fund`,
  `node scripts/npm-audit.mjs`, `npm audit signatures --omit=dev`).

CI YAML parsed with jobs: `build-check-test`, `codeteam-package-tests`,
`supply-chain`, `mcp-conformance`.

## Branch protection evidence

Both branches now require PRs, strict required checks, no force pushes, and no
deletions; admins are enforced. Required checks:

```json
[
  "build-check-test",
  "codeteam-package-tests",
  "supply-chain",
  "mcp-conformance"
]
```

| Branch | Checks | Strict | Enforce admins | Force push | Deletions |
|---|---|---|---|---|---|
| `main` | 4 | true | true | false | false |
| `codeteam-work` | 4 | true | true | false | false |

The API response was captured from
`repos/zhongmingLL/codeteam/branches/<branch>/protection` on 2026-10-27.

## Supply-chain delta

- `packages/coding-agent`: `undici` `8.10.2` -> `8.12.3`.
- root override: gondolin `undici` -> `6.29.1`.
- `packages/coding-agent/install-lock/package-lock.json` regenerated.
- `scripts/npm-audit.mjs`: accepted `GHSA-mrhx-c7xc-m3w5` for `zod@3.25.76`.

The zod exception is **not silently approved**: the only direct zod-3 constraint
is the unpublished `@anthropic-ai/sandbox-runtime` example. It needs independent
security review (砚砚) before this Phase is mergeable, and must be revisited
before W2 sandbox work or when the example upgrades to zod >= 4.6.6.

## Gaps and next

1. **Security review pending** for the zod exception.
2. **Remote CI not run yet**: the worktree branch is local; a push/PR is needed to
   prove the new jobs and required-check names on GitHub. Do not claim CI green
   from local YAML parsing.
3. `codeteam-work` remote is behind the local baseline commit until push; branch
   protection is set but no remote PR has exercised it.
4. WSL2 full tests remain red for the documented host/baseline reasons; the
   supported Linux CI runner is the acceptance environment.

## Rollback

- Revert the Phase 0 commit to restore the previous CI/dependency files.
- Restore `main` protection to no required status checks if needed.
- `codeteam-work` was unprotected before this change; delete its protection to
  restore the previous state.
