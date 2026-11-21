# Upstream baseline

SuperAgentTeam (`zhongmingLL/superagentteam`) is a downstream mirror of the pi monorepo. It is **not** a GitHub-native fork (`isFork=false`); the upstream relationship is maintained through a Git remote.

## Pin

| Item | Value |
|---|---|
| Upstream | `https://github.com/earendil-works/pi` |
| Repository | `zhongmingLL/superagentteam` |
| Tag | `v1.4.0` |
| Commit | `4a080252f06caf63a525d7873c5d94d3c23887e0` |
| Release baseline branch | `main` |
| Development branch | `superagentteam-work` |
| GitHub visibility | public |

The previous baseline was `v1.3.0` (`71023aec1546d6d677a65669c5665c0927ce0dd0`). It remains the fallback if the W0a L0/session spike fails on `v1.4.0`; a fallback must be recorded in `KERNEL_GAPS.md` with evidence, not silently switched.

## Branch model

- `main`: pinned pi release baseline. Protected; changes arrive through PRs only.
- `superagentteam-work`: default development branch for SuperAgentTeam work, renamed
  from `codeteam-work` in F019.4.
- `feature/*`: short-lived task branches, one per worktree/task.

## Sync with upstream

```bash
git fetch upstream --tags --prune
git log --oneline main..upstream/main | head -50
```

To move the baseline deliberately:

```bash
git checkout -b sync/pi-vX.Y.Z main
git merge --no-ff vX.Y.Z
# run the baseline checks, update UPSTREAM.md, then open a PR into main
```

Do not merge upstream directly into `superagentteam-work` without first updating `main`; the release baseline is the version lock.

## Kernel policy

The kernel is read-only by default. `packages/superagentteam-*`, extensions, MCP servers, and SDK adapters are the preferred implementation surfaces. A kernel patch is allowed only when a W0a/W1 spike has a reproducible failure and the patch is recorded in `KERNEL_GAPS.md`.

## Baseline verification

```bash
NODE_ENV=development npm install --ignore-scripts
NODE_ENV=development npm run build:offline
NODE_ENV=development ./test.sh
```

These checks prove the upstream build and tests. They do **not** prove the W0a acceptance items: L0 compaction preservation, session export/resume, and the Hub compatibility spike must be verified separately.

## Downstream divergences

- Root `AGENTS.md`: SuperAgentTeam project instructions. The pi `v1.4.0` `AGENTS.md` is preserved at `docs/upstream/pi-development-rules.md` and applies to pi package work. Reason: F302 treats an existing root `AGENTS.md` as the canonical project guide and skips generation; keeping pi rules at root would leave project-specific agent instructions unmaterialized.
- `README.md`: added a SuperAgentTeam banner pointing to `SUPERAGENTTEAM.md`; the upstream Pi README body is unchanged. Reason: F019.1 requires the repository landing page to show the platform name without rewriting upstream documentation; the banner is the only downstream edit.
- `.gitignore`: narrowed the upstream `plans/` rule to `/plans/` so `docs/plans/` is versioned as the project plan truth source; added local agent/tool state directories (`.cat-cafe/`, `.codex/`, `.gemini/`, `.kimi-code/`; `.claude/` was already ignored). Reason: a clean clone must contain the W0–W8 plans, while local agent state must never be committed.
- `.github/workflows/ci.yml`: added `codeteam-work` push/PR triggers, read-only workflow permissions, a blocking supply-chain job, and a pinned-catalog hydrate step before `build:offline`/tests. The empty `codeteam-package-tests` job was deferred to Phase 1; after `@superagentteam/pi-adapter` landed, root `npm test --workspaces` was verified to run its tests inside `build-check-test` (3 files / 10 tests in CI), so no duplicate job was added. Reason: W0a required checks must cover the development branch without duplicating the full upstream test job or relying on a live model-catalog fetch. On 2026-10-28 the same job was made scope-aware: a `changes` job classifies the PR diff, docs-only runs a whitespace check, SuperAgentTeam package changes build/check and test only the SuperAgentTeam workspaces (lane renamed to `superagentteam` in F019.2), and any upstream/root/tooling/rename/unknown change fails closed to the full suite. Reason: full pi tests on every docs PR made the required check 5-16 minutes long without adding coverage.
- `package.json` / `packages/coding-agent/package.json`: bumped `undici` to `8.12.3` and overrode gondolin's `undici` to `6.29.1`; regenerated `packages/coding-agent/install-lock` and `package-lock.json`. Reason: fix unaccepted high advisories without a kernel patch.
- `packages/coding-agent/package.json` / `package-lock.json`: bumped `minimatch` from `10.2.6` to `11.0.3`, and refreshed the lockfile so gondolin's `node-forge` resolves to `1.4.2` within its `^1.3.3` range; regenerated `packages/coding-agent/install-lock`. Reason: clear GHSA-g3hv-75wg-m249 and the node-forge advisories without changing branch protection or adding a gate exception. `scripts/npm-audit.mjs` drops the now-stale GHSA-86w9-cpqp-85rv exception because a fixed node-forge release exists.
- `scripts/npm-audit.mjs`: accepted `GHSA-mrhx-c7xc-m3w5` for `zod@3.25.76`, which is directly required only by the unpublished sandbox example (`@anthropic-ai/sandbox-runtime`). This exception needs independent security review before merge and must be revisited before W2 sandbox work or when the example upgrades to zod >= 4.6.6.
- `nix/model-catalog.json`: moved the pinned catalog from `sha256-7fe1b41f...` (v1.4.0 release pin) to `sha256-7604547f...` because the release pin lacks the System One classifier fixtures added in `7f225f25d` (`clef-omni`, `jev-1.14.0`, classifier compat). The new pin hash was verified against the immutable catalog body; targeted `packages/ai` tests pass after hydration. Reason: keep CI deterministic without a live catalog fetch while matching the v1.4.0 generator/tests.
- `package.json`: root `build` / `build:offline` now also build `packages/superagentteam-pi-adapter` and `packages/superagentteam-skills` after the pi coding-agent package; root `tsconfig.json` maps `@superagentteam/*` to package sources for type-checking. Reason: SuperAgentTeam-specific runtime adapters and the curated skill catalog live under `packages/superagentteam-*` and must participate in the normal build and type graph.
- F019.2 package rename: `@codeteam/*` / `packages/codeteam-*` -> `@superagentteam/*` / `packages/superagentteam-*`; updated root build scripts, tsconfig paths, CI scope classifier, risk path patterns, and `package-lock.json`. Reason: F019 SuperAgentTeam rename; no upstream pi package is affected.
- F019.3 compatibility: new `SUPERAGENTTEAM_*` env names with `CODETEAM_*` fallback, `~/.superagentteam` with `~/.codeteam` dual-read, `superagentteam` CLI bin + `codeteam` wrapper, `superagentteam_*` tool IDs and `superagentteam-*` skill IDs with `codeteam_*` / `codeteam-*` aliases. Reason: F019 SuperAgentTeam rename; no upstream pi package is affected.
- F019.4 repo/branch rename: `zhongmingLL/codeteam` -> `zhongmingLL/superagentteam` and `codeteam-work` -> `superagentteam-work` on 2026-11-17. Old repo URLs 301-redirect; branch names do not. Branch protection and required checks followed the branch rename and were verified. Reason: F019 SuperAgentTeam rename; no upstream pi package is affected.
- `.github/workflows/pr-gate.yml` and `.github/workflows/publish-model-catalog.yml`: downstream trigger fixes. PR Gate re-runs on `synchronize`/`reopened`, so contributor checks follow PR updates instead of only the opening event. Publish Model Catalog generates after successful push CI on `main` or `superagentteam-work`; the latest-release compatibility check and the `publish` job are restricted to the upstream `earendil-works/pi` repository, because the downstream mirror does not carry upstream release tags and must never upload to pi.dev production R2. Reason: the downstream repo needs reliable PR gates and catalog validation while inheriting none of upstream's production publishing authority or release-tag assumptions.

## W0a verification status (2026-10-27)

- L0 native injection, manual/threshold compaction, and cross-process JSONL resume were verified on
  v1.4.0 with fake-provider evidence; the v1.3.0 fallback was not needed. See
  `docs/reports/2026-10-27-f002-phase1-l0-compiler.md`.
- Curated skills were injected through `DefaultResourceLoader.additionalSkillPaths` with
  `noSkills: true`; no automatic discovery or HOME mount. See
  `docs/reports/2026-10-27-f002-phase2-skill-surface.md`.
- Kernel package sources remain untouched; the only coding-agent changes are the `undici` pin and the
  regenerated install lock recorded above.

