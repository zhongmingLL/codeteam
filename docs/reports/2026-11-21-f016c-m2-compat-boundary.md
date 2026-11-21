# F016c-M2 S4 — canonical rich identity + compat boundary

Date: 2026-11-21
Owner: 宪宪 (Ragdoll/DeepSeek Flash)
Scope: S4 for `docs/plans/0031-f016c-m2-events.md`

## Canonical rich replay identity

`OperatorMessageIngress` no longer compares rich payloads by raw
`JSON.stringify`. `canonicalJson` recursively sorts object keys (array order
stays significant, `undefined` properties are omitted like JSON serialization)
and is used for the rich replay identity check.

Evidence:

- `canonical-json.test.ts`: key-order variants equal; array order and content
  changes differ.
- `f018-r2a-dispatch.test.ts`: same message id + semantically equal rich payload
  with different key order replays; changed rich content still raises
  `ingress_message_id_conflict`.

## CORS / classic Hub boundary

- **First-party thin Hub**: daemon-served SPA is same-origin; no CORS is added.
  The S2 SSE client uses the same-origin session cookie and Vite's `/api` proxy in
  development.
- **Classic Hub is optional compat, not first-party M2**: direct cross-origin use
  would require an explicit opt-in origin allowlist + credentials (+ preflight),
  never a wildcard. It is not enabled by default and is tracked by the separate
  compat task.
- **Socket.IO**: not added for the first-party Hub; SSE invalidation covers the
  one-way change signal. A Socket.IO adapter is only justified if a real classic
  Hub consumer requires it.
- **Hub projectPath/mentions facts**: first-party projectPath is enforced by
  F021 (`project_path_invalid`); classic Hub form behavior and mentions value
  domain remain in the optional compat task.

## F016c-M2 slice status

| Slice | Evidence |
|---|---|
| S0 contract | Plan 0031 accepted (SSE invalidation, HTTP refetch, fallback) |
| S1 daemon | `7fe1c148`; ChangeBus + `/api/events` + commit-after-publish hooks; 860 daemon tests |
| S2 web | `00a9b0a2`; EventSource/refetch/fallback/reconnect; 69 web tests |
| S3 latency/acceptance | `ed4fed04`; <500ms assertions + static/Vite-proxy/fallback/reconnect report |
| S4 canonical/compat | `49b8114dd`; this report; canonical rich JSON + opt-in-only compat boundary |

## F016 umbrella close posture

- F016a: done.
- F016c-M1: done (headless API/session/legacy shells).
- F016c-M2: S0–S4 complete and merged (`ad18dad0`, `7fe1c148`, `00a9b0a2`,
  `ed4fed04`, `49b8114dd`); first-party event/refetch path delivered.
- F016b: deferred by `D1=A`; no real caller in this scope.
- Classic Hub compat: optional track, separate task; not a first-party M2 gate.

Close of the F016 umbrella remains an operator decision; this report is the
technical close packet.

[宪宪/deepseek-flash🐾]
