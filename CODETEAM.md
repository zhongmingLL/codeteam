# codeteam

codeteam is a repo-native, headless-first code agent team runtime built on a pinned pi downstream baseline.

## Truth sources

- Project docs: [`docs/README.md`](docs/README.md)
- Development plan: [`docs/plans/README.md`](docs/plans/README.md)
- Architecture contract: [`docs/features/F001-architecture-v1.md`](docs/features/F001-architecture-v1.md) and [`docs/architecture/0001-codeteam-architecture-v1.md`](docs/architecture/0001-codeteam-architecture-v1.md)
- Upstream pin: [`UPSTREAM.md`](UPSTREAM.md)
- Kernel patch policy: [`KERNEL_GAPS.md`](KERNEL_GAPS.md)
- Agent instructions: [`AGENTS.md`](AGENTS.md)
- Upstream pi rules: [`docs/upstream/pi-development-rules.md`](docs/upstream/pi-development-rules.md)

## Branch model

- `main`: pinned pi release baseline (`v1.4.0`).
- `codeteam-work`: default development branch.

## Current stage

W0a bootstrap: the pi `v1.4.0` baseline, documentation migration, and repository baseline are being established. Implementation has not started. The next implementation gate is W0a: L0/session spikes, Hub compatibility spike, sandbox/worktree preflight, and supply-chain baseline.

## Development rule

Prefer `packages/codeteam-*`, extensions, MCP servers, and SDK adapters. Keep the pi kernel read-only unless a failure is recorded in `KERNEL_GAPS.md` and a minimal patch is justified.
