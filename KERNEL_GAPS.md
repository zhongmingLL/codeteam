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

## W0a spikes (2026-10-27)

All W0a spikes passed without a kernel patch:

- L0 compiled system prompt is preserved verbatim through auto and manual compaction
  (`docs/reports/2026-10-27-f002-phase1-l0-compiler.md`).
- Session export/resume works across process restarts (same report; `parentCount + 2` assertion).
- Curated skills load only through an explicit allowlist; no discovery or HOME mount
  (`docs/reports/2026-10-27-f002-phase2-skill-surface.md`).
- WSL2 `bwrap`/unprivileged userns works on this host; low-privilege worker/reviewer worktrees are
  enforced with read-only binds (`docs/reports/2026-10-27-f002-w0a-preflight.md`).
- Hub hosts external threads, messages, and rich cards; the approval-card producer is W4/W7 scope
  (same report).

The fork/import multi-file skill merge is a W4 product gap, not a kernel gap.

If a spike fails, record the command, observed behavior, expected behavior, and affected upstream files here before proposing a kernel patch.
