# F016c-M2 S3 acceptance — SSE latency + Hub fallback/restore

Date: 2026-11-21
Owner: 宪宪 (Ragdoll/DeepSeek Flash)
Scope: S3 for `docs/plans/0031-f016c-m2-events.md`

## Build under test

- S1 daemon: `7fe1c148` (ChangeBus + `/api/events` SSE + commit-after-publish hooks).
- S2 web: `00a9b0a2` (EventSource client, refetch, polling fallback, reconnect).
- Web tests at S2: 69 passed / 22 files; typecheck 0; build 299.33 kB / 94.35 kB gzip.
- Daemon tests at S1: 860 passed / 3 skipped (128 files).

## Automated latency

- `api-events.test.ts`: from the message POST start until the first SSE `change`
  containing `messages/queue/thread` is **<500ms** (asserted in the test).
- `f021-busy-live.test.ts`: from the message POST start until an SSE `change`
  containing `live` is **<500ms** (asserted alongside the real pi worker busy state).

## Browser matrix

Environment: daemon on `127.0.0.1:3011`, isolated data dir, built web `dist`;
Vite dev proxy on `:3000` for the proxy-specific check.

| Area | Check | Result |
|---|---|---|
| SSE live | Active thread constructs `/api/events?threadId=...`, receives `ready`, no fallback note | pass |
| Message freshness | Live polling is 30s; sending `SSE S2 smoke` appeared within ~1s | pass |
| Fallback | Playwright `page.route('**/api/events**', abort)` + reload → “实时更新不可用，正在使用轮询。” and 50 messages still render | pass |
| Polling fallback | While SSE blocked, a message inserted directly into the isolated DB appeared after the 2s polling tick | pass |
| Reconnect | Removing the route block cleared the fallback note; EventSource log showed 6 bounded attempts, not a tight loop | pass |
| Vite proxy | Vite `:3000` EventSource constructed through `/api` proxy; no fallback note; 50 messages rendered | pass |
| Existing acceptance | Dark theme, 390 layout, 401→relogin→returnTo, long-thread scroll, real-worker busy live from F020 H4/F021 | pass (prior evidence) |

## Interpretation

- Invalidation-only semantics held: the UI refreshed through the existing
  `store.refresh()`/`refreshA2A()`/`loadDetail()` paths; no event payload became
  UI state.
- Fallback is behaviorally real, not a label: polling still converged a DB-side
  message while the EventSource was blocked.
- Reconnect is bounded and the note is bidirectional (visible only while the
  stream is unavailable, gone after `ready`).

## Remaining (S4)

- Canonical rich JSON replay identity.
- Compat/CORS decision record; classic Hub facts remain an optional task.
- F016 close evidence after S4.

[宪宪/deepseek-flash🐾]
