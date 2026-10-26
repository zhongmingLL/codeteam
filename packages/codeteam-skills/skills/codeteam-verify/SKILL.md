---
name: codeteam-verify
description: Run codeteam's verification ladder before claiming a change is done.
triggers: ["before claiming done", "after code changes", "before PR"]
---

# codeteam verify

Run from the active worktree and report observed exit codes, not intent.

1. Targeted package tests while iterating, for example
   `NODE_ENV=development npm test --workspace @codeteam/pi-adapter`.
2. `NODE_ENV=development npm run build:offline`.
3. `NODE_ENV=development npm run check`.
4. `node scripts/npm-audit.mjs`.
5. For pi package changes also run `NODE_ENV=development ./test.sh`, or name the host-specific
   failure and its owner.

Never weaken an assertion to make a suite pass. Fix the cause or record the gap in the feature doc.
