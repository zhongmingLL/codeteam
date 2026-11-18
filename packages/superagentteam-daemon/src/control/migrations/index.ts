// Legacy compatibility shim (R1-0). Real code: src/legacy/task-first/control/migrations/.
// Task-first table migrations are frozen legacy; the F018 v1 migration harness
// (R1-a) lives under src/infrastructure/db/migrations/. Removal: R5.
// Enforced by scripts/check-legacy-boundary.mjs (importing this barrel counts
// as a legacy import and requires a baseline allowlist entry).
export * from "../../legacy/task-first/control/migrations/index.ts";
