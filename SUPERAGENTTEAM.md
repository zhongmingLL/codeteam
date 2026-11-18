---
title: "SuperAgentTeam"
doc_kind: note
status: active
updated: 2026-11-18
---

# SuperAgentTeam

SuperAgentTeam is a repo-native, headless-first, durable A2A team runtime built on a pinned pi
downstream baseline. Thread, invocation, queue, turn, worker, and credential are the shared
runtime; team profiles and SOPs compose on top. `codeteam` is the historical/legacy name.
The repository is now `zhongmingLL/superagentteam`; package/env/data/CLI/tool/skill names
use `superagentteam*`. F019.5 removed the `codeteam*` compatibility aliases. The default
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

As of 2026-11-18: F018 A2A runtime v1 design is accepted (Phase A contract closed at
`86310de24`). F019.1 docs/branding, F019.2 packages/scope, F019.3
env/data/CLI/tool/skill compatibility, F019.4 repository/branch rename, and F019.5
alias cleanup are complete. F019 is closed; `codeteam*` remains only in historical
docs and legacy data. F018 development ownership was handed to 砚砚 on 2026-11-18;
F018 R1-0 start still awaits the operator's explicit unpause.

## Data migration

The data root is `~/.superagentteam`. F019.5 removed the legacy `~/.codeteam` dual-read;
the old root is no longer read or written. If an old install still has `~/.codeteam`,
migrate it manually while the service is stopped.

## Development rule

Prefer the product package surface (`packages/superagentteam-*`), extensions, MCP servers,
and SDK adapters. Keep the pi kernel read-only
unless a failure is recorded in `KERNEL_GAPS.md` and a minimal patch is justified.
