# AgentTeam

AgentTeam is a repo-native, headless-first, durable A2A team runtime built on a pinned pi
downstream baseline. Thread, invocation, queue, turn, worker, and credential are the shared
runtime; team profiles and SOPs compose on top. `codeteam` is the historical/legacy name:
the repository, branch, npm scope, env vars, data paths, CLI, and tool names keep the old
spelling until the F019.2–F019.4 migration lands.

## Truth sources

- Project docs: [`docs/README.md`](docs/README.md)
- Development plan: [`docs/plans/README.md`](docs/plans/README.md)
- Architecture contract: [`docs/features/F001-architecture-v1.md`](docs/features/F001-architecture-v1.md) and [`docs/architecture/0001-codeteam-architecture-v1.md`](docs/architecture/0001-codeteam-architecture-v1.md)
- Upstream pin: [`UPSTREAM.md`](UPSTREAM.md)
- Kernel patch policy: [`KERNEL_GAPS.md`](KERNEL_GAPS.md)
- Agent instructions: [`AGENTS.md`](AGENTS.md)
- Upstream pi rules: [`docs/upstream/pi-development-rules.md`](docs/upstream/pi-development-rules.md)
- Naming matrix and migration: [`docs/features/F019-agentteam-rename.md`](docs/features/F019-agentteam-rename.md), [`docs/plans/0023-f019-agentteam-rename.md`](docs/plans/0023-f019-agentteam-rename.md)

## Branch model

- `main`: pinned pi release baseline (`v1.4.0`).
- `codeteam-work`: default development branch until the F019.4 repo/branch rename;
  target `codeteam-work` for now.

## Current stage

F018 A2A runtime v1 design is accepted (Phase A contract closed at `86310de24`).
F019 AgentTeam rename runs before F018 R1-0: F019.1 docs/branding, then F019.2
packages/scope, F019.3 env/data/CLI/tools, then F018 R1-0. Repository/branch rename
(F019.4) is last.

## Development rule

Prefer the product package surface (`packages/codeteam-*` today; `packages/agentteam-*`
after F019.2), extensions, MCP servers, and SDK adapters. Keep the pi kernel read-only
unless a failure is recorded in `KERNEL_GAPS.md` and a minimal patch is justified.
