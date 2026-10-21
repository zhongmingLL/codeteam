# codeteam

codeteam is a downstream fork of [`earendil-works/pi`](https://github.com/earendil-works/pi) for a pure, repo-native coding agent.

## Layout

- `packages/codeteam` — codeteam control plane: SOP, typed handoffs, roles, review evidence, eval.
- `docs/architecture` — architecture and fork decisions.
- `docs/plans` — MVP plan and progress.
- Upstream packages (`packages/ai`, `packages/agent`, `packages/coding-agent`, ...) remain available for deep kernel changes.

## Bootstrap

```bash
NODE_ENV=development npm install --ignore-scripts
NODE_ENV=development npm run build:offline
NODE_ENV=test npm run test --workspace=@codeteam/core
```

## Current Gate A status

- Control plane: single-slot CAS, one terminal, deadline, loop guard, crash recovery, illegal transition.
- Persistence: SQLite control store with hydrate.
- pi SDK adapter: role-scoped `createAgentSession`; coder persistent, reviewer/verifier fresh in-memory context.
- Tests: 19 passing, including faux-provider session, built-in `read` tool execution, review verdict parsing, and SQLite recovery.
- Live smoke: DeepSeek, Kimi, and GLM all fixed `fixtures/smoke-bug-01` end-to-end.
- Review smoke: Kimi and GLM reviewers both approved a clean diff and rejected a bad diff with blocking findings.

Next: verifier falsifier execution, permission wrapper, larger FP/recall sample.
