---
title: "F002 live provider end-to-end (opt-in)"
doc_kind: report
status: current
created: 2026-10-27
updated: 2026-10-27
owner: "宪宪 (Ragdoll/DeepSeek Flash)"
---

# F002 live provider end-to-end (opt-in)

> Scope: a manual, opt-in E2E against a real vendor endpoint. It is skipped in CI and in the default
> test run; no credential is stored in the repository.

## What ran

- Adapter: `createAgentSessionWithL0` with a real session/agent loop.
- Model: `glm-5.3-flash` through Zhipu's Anthropic-compatible endpoint
  (`https://open.bigmodel.cn/api/anthropic`).
- Credential: supplied only through `CODETEAM_LIVE_API_KEY` and written to a temporary `auth.json`
  (mode 0600) inside a temp agent dir; deleted after the test.
- Outbound request captured with a temporary `globalThis.fetch` wrapper to verify the URL and body
  without changing provider routing.

## Result (2026-10-27)

```text
NODE_ENV=development CODETEAM_LIVE_PROVIDER=1 \
  CODETEAM_LIVE_BASE_URL=... CODETEAM_LIVE_MODEL=glm-5.3-flash CODETEAM_LIVE_API_KEY=... \
  npx vitest run --root packages/codeteam-pi-adapter test/provider-live.e2e.test.ts

Test Files  1 passed (1)
Tests       1 passed (1)
Duration    ~13s
```

Assertions that passed:

- the captured request URL starts with the configured live base URL (a real vendor call);
- `body.stream === true`;
- the outbound `system` text contains the compiled L0 verbatim;
- `messages` contains the user prompt;
- the assistant reply contains `LIVE_OK`, parsed from the real SSE stream.

Default suite without the live flag: `5 passed | 1 skipped (6 files)`, `15 passed | 1 skipped`.

## Credential hygiene

- The key exists only in the process environment and a temp `auth.json`; it is never written to the
  repo, reports, or logs.
- The test is `describe.skipIf`-gated on `CODETEAM_LIVE_PROVIDER=1` plus all three env values.
- CI never sets these variables, so CI remains a no-live-call environment.

## Boundaries

- One provider/model was exercised; this is not a provider matrix.
- Prompt-cache hit remains unobserved (`cache_observability=unavailable`).
- No product-level CLI journey; that starts in W1.
