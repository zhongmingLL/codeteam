# Kernel gaps

Current status: **zero kernel patches**. codeteam development is SDK/extension-first; kernel packages are read-only by default.

## Patch admission

A kernel patch is admitted only when all of the following exist:

1. A reproducible failure in a W0a/W1 spike or acceptance test.
2. A minimal failing test or fixture that demonstrates the gap.
3. A patch scoped to the smallest necessary kernel surface.
4. An upstreamability note (issue/PR link or reason it cannot go upstream).
5. A removal/retirement condition.

## Open gaps

None confirmed as of bootstrap (2026-10-26).

## W0a spikes (not patches yet)

- L0 compiled system prompt is preserved verbatim through auto and manual compaction.
- Session export/resume works across process restarts.
- Hub compatibility subset can display external thread, message, and approval data.
- WSL2 `bwrap` availability and low-privilege worker/reviewer worktree permissions.
- Reproducible install/build on Node `>=22.19.0` with the pinned lockfile.

If a spike fails, record the command, observed behavior, expected behavior, and affected upstream files here before proposing a kernel patch.
