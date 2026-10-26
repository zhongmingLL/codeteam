# @codeteam/pi-adapter

Pi runtime adapter for codeteam. The first slice provides:

- deterministic L0 compilation (`compileL0`) with role templates and a governance section;
- a `DefaultResourceLoader` helper that injects L0 through `systemPromptOverride`, disables
  context-file discovery, and clears append-system-prompt content.

```ts
import { compileL0, createL0ResourceLoader } from "@codeteam/pi-adapter";

const compiledL0 = compileL0({ role: "coder" });
const { loader, l0Revision } = await createL0ResourceLoader({ cwd, agentDir, compiledL0 });
```

Session creation, compaction evidence, and export/resume wiring are added in the remaining
F002 Phase 1 work.
