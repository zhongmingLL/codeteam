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

## Provider matrix (2026-10-27)

| Provider | API shape | Model | Result |
|---|---|---|---|
| Zhipu GLM | `anthropic-messages` | `glm-5.3-flash` | pass (~4s) |
| DeepSeek | `openai-completions` | `deepseek-flash` | pass (~0.8s) |
| Kimi | `openai-completions` | `kimi-for-coding` | pass (~2.3s) |

All three asserted: request URL matches the live base, `stream: true`, L0 present in the outbound
system (top-level `system` or a `system` message with content parts), the user prompt in `messages`,
and `LIVE_OK` in the real streamed reply.

## Result (GLM, 2026-10-27)

```text
CODETEAM_LIVE_PROVIDER=1 CODETEAM_LIVE_API=anthropic-messages CODETEAM_LIVE_PROVIDER_ID=anthropic \
  CODETEAM_LIVE_BASE_URL=... CODETEAM_LIVE_MODEL=glm-5.3-flash CODETEAM_LIVE_API_KEY=... \
  npx vitest run --root packages/codeteam-pi-adapter test/provider-live.e2e.test.ts

# OpenAI-compatible providers
CODETEAM_LIVE_PROVIDER=1 CODETEAM_LIVE_API=openai-completions CODETEAM_LIVE_PROVIDER_ID=openrouter \
  CODETEAM_LIVE_BASE_URL=<provider>/v1 CODETEAM_LIVE_MODEL=<model> CODETEAM_LIVE_API_KEY=... \
  npx vitest run --root packages/codeteam-pi-adapter test/provider-live.e2e.test.ts
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

- Three vendors were exercised across two API shapes; this is still a small matrix, not an exhaustive one.
- Prompt-cache hit remains unobserved (`cache_observability=unavailable`).
- No product-level CLI journey; that starts in W1.
