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
