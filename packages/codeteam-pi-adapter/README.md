# @codeteam/pi-adapter

Pi runtime adapter for codeteam. The first slice provides:

- deterministic L0 compilation (`compileL0`) with role templates and a governance section;
- a `DefaultResourceLoader` helper that injects L0 through `systemPromptOverride`, disables
  context-file discovery, and clears append-system-prompt content.
- `createAgentSessionWithL0` for the native SDK session path.

```ts
import { compileL0, createAgentSessionWithL0, createL0ResourceLoader } from "@codeteam/pi-adapter";

const compiledL0 = compileL0({ role: "coder" });
const { loader, l0Revision } = await createL0ResourceLoader({ cwd, agentDir, compiledL0 });
const { session } = await createAgentSessionWithL0({ cwd, agentDir, compiledL0 });
```

Tests cover deterministic L0, no-context-file injection, manual and threshold compaction, stable
system hashes, and cross-process JSONL resume with continued prompting.

## Live provider E2E (opt-in)

`test/provider-live.e2e.test.ts` makes a real vendor call and is skipped unless
`CODETEAM_LIVE_PROVIDER=1` and `CODETEAM_LIVE_BASE_URL`, `CODETEAM_LIVE_MODEL`,
`CODETEAM_LIVE_API_KEY` are set. `CODETEAM_LIVE_API` selects `anthropic-messages` (default) or
`openai-completions`; `CODETEAM_LIVE_PROVIDER_ID` selects the auth key id. The key is written only to
a temp `auth.json` and is never committed.

