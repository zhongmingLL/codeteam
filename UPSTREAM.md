# Upstream

codeteam is a downstream fork of [`earendil-works/pi`](https://github.com/earendil-works/pi).

## Current baseline

- Upstream tag: `v1.3.0`
- Upstream commit: `71023aec1546d6d677a65669c5665c0927ce0dd0`
- License: MIT (see `LICENSE`)
- Local checkout: detached at `v1.3.0`; `packages/codeteam` is the codeteam-owned package.

## Sync

```bash
git fetch --depth=1 upstream refs/tags/<tag>:refs/tags/<tag>
git merge <tag>
```

After every sync:

1. Run `NODE_ENV=development npm run build:offline`.
2. Run upstream `./test.sh` (or the package-level tests relevant to the change).
3. Run `NODE_ENV=test npm run test --workspace=@codeteam/core`.
4. Update the baseline above and the patch log.

## Patch log

| Area | Change | Reason | Upstreamable |
|---|---|---|---|
| `packages/codeteam` | ControlPlane + SqliteControlStore | Durable task/run/handoff, CAS, terminal, deadline, loop guard, recovery | N/A |
| `packages/codeteam` | pi session adapter | Role-scoped `createAgentSession`; no kernel patch needed yet | N/A |
| `fixtures/smoke-bug-01` + live smoke runner | Gate B end-to-end fixture | Prove coder/tool/test loop with real providers | N/A |
| `packages/codeteam/src/review` + review smoke | Typed review findings, parser, cross-provider smoke | Prove clean-diff approval and bad-diff rejection | N/A |

Keep kernel patches small, tested, and listed here. Prefer adding behavior in `packages/codeteam` or an extension before patching `packages/agent` / `packages/coding-agent` / `packages/ai`.
