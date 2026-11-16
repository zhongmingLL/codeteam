---
title: "SuperAgentTeam"
doc_kind: note
status: active
updated: 2026-11-16
---

# SuperAgentTeam

SuperAgentTeam is a repo-native, headless-first, durable A2A team runtime built on a pinned pi
downstream baseline. Thread, invocation, queue, turn, worker, and credential are the shared
runtime; team profiles and SOPs compose on top. `codeteam` is the historical/legacy name:
the repository, branch, npm scope, env vars, data paths, CLI, and tool names keep the old
spelling until the F019.2–F019.4 migration lands, then become `superagentteam*`.

## Truth sources

- Project docs: [`docs/README.md`](docs/README.md)
- Development plan: [`docs/plans/README.md`](docs/plans/README.md)
- Architecture contract: [`docs/features/F001-architecture-v1.md`](docs/features/F001-architecture-v1.md) and [`docs/architecture/0001-codeteam-architecture-v1.md`](docs/architecture/0001-codeteam-architecture-v1.md)
- Upstream pin: [`UPSTREAM.md`](UPSTREAM.md)
- Kernel patch policy: [`KERNEL_GAPS.md`](KERNEL_GAPS.md)
- Agent instructions: [`AGENTS.md`](AGENTS.md)
- Upstream pi rules: [`docs/upstream/pi-development-rules.md`](docs/upstream/pi-development-rules.md)
- Naming matrix and migration: [`docs/features/F019-superagentteam-rename.md`](docs/features/F019-superagentteam-rename.md), [`docs/plans/0023-f019-superagentteam-rename.md`](docs/plans/0023-f019-superagentteam-rename.md)

## Branch model

- `main`: pinned pi release baseline (`v1.4.0`).
- `codeteam-work`: default development branch until the F019.4 repo/branch rename;
  target `codeteam-work` for now. F019.4 renames it to `superagentteam-work`.

## Current stage

As of 2026-11-16: F018 A2A runtime v1 design is accepted (Phase A contract closed at
`86310de24`). F019.1 docs/branding, F019.2 packages/scope, and F019.3
env/data/CLI/tool/skill compatibility are complete. F018 R1-0 remains paused by the
operator; F019.4 repository/branch rename is last. Refresh this block (and the
frontmatter `updated`) at each F019 phase; do not let it drift like the old W0a entry did.

## Development rule

Prefer the product package surface (`packages/superagentteam-*`), extensions, MCP servers,
and SDK adapters. Keep the pi kernel read-only
unless a failure is recorded in `KERNEL_GAPS.md` and a minimal patch is justified.
