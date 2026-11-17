---
title: "SuperAgentTeam"
doc_kind: note
status: active
updated: 2026-11-17
---

# SuperAgentTeam

SuperAgentTeam is a repo-native, headless-first, durable A2A team runtime built on a pinned pi
downstream baseline. Thread, invocation, queue, turn, worker, and credential are the shared
runtime; team profiles and SOPs compose on top. `codeteam` is the historical/legacy name.
The repository is now `zhongmingLL/superagentteam`; package/env/data/CLI/tool/skill names
use `superagentteam*` with `codeteam*` compatibility aliases through F019.5. The default
branch is now `superagentteam-work`; old `codeteam-work` refs are not redirected.

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

- Repository: `zhongmingLL/superagentteam` (renamed 2026-11-17; old URLs redirect).
- `main`: pinned pi release baseline (`v1.4.0`).
- `superagentteam-work`: default development branch. The old `codeteam-work` branch
  name no longer resolves; update remote refs/tracking if you still have them.

## Current stage

As of 2026-11-17: F018 A2A runtime v1 design is accepted (Phase A contract closed at
`86310de24`). F019.1 docs/branding, F019.2 packages/scope, and F019.3
env/data/CLI/tool/skill compatibility are complete. F019.4 repository rename to
`zhongmingLL/superagentteam` and default-branch rename to `superagentteam-work` are
complete (old repo URLs 301; protection/required checks carried over).
F018 R1-0 remains paused by the operator; F019.5 alias cleanup is later. Refresh this
block (and the frontmatter `updated`) at each F019 phase; do not let it drift like the
old W0a entry did.

## Data migration

Existing `~/.codeteam` data is read in place; there is no automatic copy. An explicit
migration is a manual directory rename to `~/.superagentteam` performed while the service
is not running. Until then, writes remain under the old root; the new root is not created
early.

## Development rule

Prefer the product package surface (`packages/superagentteam-*`), extensions, MCP servers,
and SDK adapters. Keep the pi kernel read-only
unless a failure is recorded in `KERNEL_GAPS.md` and a minimal patch is justified.
