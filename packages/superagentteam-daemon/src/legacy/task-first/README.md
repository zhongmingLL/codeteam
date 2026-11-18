# Task-first legacy (frozen — do not extend)

Everything under this tree is the frozen task-first implementation. It is NOT
the F018 A2A runtime baseline; the v1 contracts live in
`docs/architecture/0005-thread-first-runtime.md` and `0007-a2a-runtime-chain.md`.

- Moved here in F018 R1-0 with `git mv`; old paths keep re-export shims.
- Do not add features, refactor, or fix here beyond compile-level maintenance.
- v1 code must not import this tree (enforced by
  `scripts/check-legacy-boundary.mjs`; baseline allowlist lives in that
  script and only shrinks).
- Archived/removed in R5.
- Inventory: `docs/legacy/task-first/INDEX.md` and
  `docs/architecture/0006-task-first-legacy.md`.
