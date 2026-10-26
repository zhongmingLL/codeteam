---
title: "F002 Phase 2 curated skill surface"
doc_kind: report
status: current
created: 2026-10-27
updated: 2026-10-27
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
---

# F002 Phase 2 curated skill surface

> Scope: prove that role-curated skills can be injected through pi's native skill surface without
> re-enabling auto-discovery or HOME mounts. It does not implement package admission, marketplace
> discovery, fork/import multi-file merging, or any tool-policy change.

## What changed

- `packages/codeteam-skills`: strict manifest parser and allowlist resolver.
  - `manifest.yaml` entries carry only `skillId/path/sourceKind/category/not_for/output/next/sop_step`.
  - `name`, `description`, and `triggers` are read from each `SKILL.md` frontmatter.
- `@codeteam/pi-adapter`:
  - `createL0ResourceLoader` accepts `additionalSkillPaths`;
  - `createAgentSessionWithL0` accepts `curatedSkillPaths`;
  - `noSkills: true` stays the baseline, so only the allowlist is loaded.
- Root `build`/`build:offline` build `packages/codeteam-skills` after the adapter; root `tsconfig`
  maps `@codeteam/*` to source for type-checking.

## Contract

`loadCuratedCatalog({ catalogRoot })` returns `{ skills, skillPaths, diagnostics }`:

| Input | Result |
|---|---|
| Empty `skills: []` | valid allowlist, zero paths, zero diagnostics |
| Two skill directories | both resolved in manifest order, merged into one path list |
| Missing `SKILL.md` or missing path | `skill_missing` error, skill excluded |
| Absolute path | `path_absolute` error, skill excluded |
| `..` segment | `path_escape` error, skill excluded |
| Symlink escaping the catalog root | `path_escape` error after `realpath`, skill excluded |
| Symlink inside the skill directory pointing outside it | `path_escape` error, skill excluded |
| Unresolvable symlink inside the skill directory | `path_escape` error, skill excluded |
| Frontmatter name differs from `skillId` | `name_mismatch` error, skill excluded |
| Secret-shaped content in the skill directory | `secret_detected` error, skill excluded |
| `SKILL.md` larger than 2 MiB | `skill_too_large` error, skill excluded |
| `next` pointing outside the resolved set | `dangling_next` warning, skill still loads |
| Unknown manifest key such as `description` | `manifest_invalid` error (metadata lives in `SKILL.md`) |

The adapter injects only the resolved directories. A skill's body is not copied into the system
prompt: the prompt carries an `<available_skills>` index entry with the `SKILL.md` location, and the
model loads the body through the normal read tool.

## Verification

| Check | Command | Result |
|---|---|---|
| Build | `NODE_ENV=development npm run build:offline` | exit 0; adapter and skills packages emit `dist` |
| Skills tests | `NODE_ENV=development npm test --workspace @codeteam/skills` | 1 file, 15 tests pass |
| Adapter tests | `NODE_ENV=development npx vitest run --root packages/codeteam-pi-adapter` | 4 files, 14 tests pass (including 4 skill-surface tests) |
| Root check | `NODE_ENV=development npm run check` | exit 0 |
| Production audit | `node scripts/npm-audit.mjs` | exit 0; no unaccepted advisories |

Skill-surface tests prove:

- only allowlisted skills reach `loader.getSkills()` and the `<available_skills>` prompt section;
- decoy skills in `agentDir/skills` and `cwd/.pi/skills` are not discovered;
- an empty allowlist produces no skills section;
- the prompt index points at `SKILL.md` and does not inline the body;
- the tool surface is identical with and without curated skills (`read` only);
- a missing allowlist path surfaces a loader diagnostic instead of silently loading nothing.
- symlinks inside a skill directory cannot escape it, and `SKILL.md` is scanned regardless of the
  general 512 KiB file-scan limit (2 MiB hard cap).

## AC-12 mapping

| Requirement | Evidence | Status |
|---|---|---|
| Manifest schema | 11 catalog tests, strict unknown-key rejection | satisfied |
| Index/body split | prompt index test; body marker absent from system prompt | satisfied |
| Empty allowlist loads nothing | adapter + catalog tests | satisfied |
| Dangling id warning | `dangling_next` test | satisfied |
| Path containment | absolute, `..`, symlink-escape tests | satisfied |
| Secret scan | `secret_detected` test | satisfied |
| In-skill symlink containment | file and directory symlink escape tests | satisfied |
| Multi-skill merge | two-directory manifest-order test | satisfied for catalog merging |
| No auto-discovery / HOME mount | decoy `agentDir/skills` and `cwd/.pi/skills` tests | satisfied |
| Multi-file skill merged into one file at fork/import | not implemented | **open, owner W4** |

AC-12 stays open until the fork/import multi-file merge exists or the W0a gate records it as a
conditional gap with that owner and a revisit trigger (first skill fork/import path).

## Review fixes

Reviewer probes at `280fd4a9b` found two gaps, both fixed on the same branch:

- P2: symlinks inside a skill directory were skipped by the scanner and could point outside the
  skill; resolution now rejects any escaping or unresolvable symlink (`path_escape`).
- P3: the 512 KiB scan limit exempted `SKILL.md`, so an oversized main file could hide a secret;
  `SKILL.md` is now always scanned and rejected above a 2 MiB hard cap (`skill_too_large`).
