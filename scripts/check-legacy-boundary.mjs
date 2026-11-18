#!/usr/bin/env node
// R1-0 legacy boundary guard (F018). Fails when code outside the allowed
// baseline imports task-first legacy code, when retired A2A tool names or
// legacy tables are referenced from v1 runtime paths, or when the baseline
// allowlist itself drifts (entries that no longer offend must be removed).
//
// Rules (plan 0021 §2.5):
//   1. Non-legacy files under packages/superagentteam-daemon/src must not
//      import `legacy/task-first/` (directly) or the old-path compatibility
//      shims, unless the file is listed in LEGACY_IMPORT_ALLOWLIST below.
//   2. v1 runtime paths (`src/domains/`) must not import legacy or shims at
//      all (no allowlist entries allowed there), must not reference retired
//      tool names, and must not reference frozen legacy tables.
//   3. The allowlist must stay exact: stale entries are an error so the list
//      only ever shrinks.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const DAEMON_SRC = join(process.cwd(), "packages/superagentteam-daemon/src");
const V1_DIRS = ["domains"];
const LEGACY_TOP_DIRS = [
  "dispatch",
  "scheduling",
  "review",
  "merge",
  "gates",
  "sop",
  "managed-work",
  "deployment-wait",
  "custody",
  "a2a",
];
const RETIRED_TOOL_NAMES = [
  "a2a_send",
  "handoff_create",
  "handoff_claim",
  "handoff_complete",
  "handoff_withdraw",
];
const LEGACY_TABLES = [
  "tasks",
  "handoffs",
  "custody_events",
  "budgets",
  "reviews",
  "merges",
];

// Baseline allowlist: active files that still import legacy (directly or via
// shims) at R1-0. Each entry names the owner and the removal stage. Entries
// may only be removed, never added; adding a new legacy import to a file not
// listed here fails the guard.
const LEGACY_IMPORT_ALLOWLIST = new Map(
  [
    ["index.ts", { owner: "R1-a", why: "package barrel; prunes legacy exports in R1-a" }],
    ["daemon-runtime.ts", { owner: "R1-a", why: "wires legacy DispatchService until v1 runtime lands" }],
    ["control/store.ts", { owner: "R1-b", why: "aggregates legacy stores until domain stores replace them" }],
    ["control/index.ts", { owner: "R1-b", why: "re-exports legacy control surface" }],
    ["control/database.ts", { owner: "R1-a", why: "applies legacy task-first migrations until the v1 migration harness (infrastructure/db) replaces it" }],
    ["control/read-models.ts", { owner: "R5", why: "compatibility shim" }],
    ["control/stores/types.ts", { owner: "R5", why: "deprecated legacy type barrel" }],
    ["cli/budget.ts", { owner: "R2", why: "legacy CLI; thread-budget replaces in later round" }],
    ["cli/deployment.ts", { owner: "R5", why: "legacy deployment-wait CLI" }],
    ["cli/gate.ts", { owner: "R5", why: "legacy gate CLI" }],
    ["cli/merge.ts", { owner: "R5", why: "legacy merge CLI" }],
    ["cli/schedule.ts", { owner: "R5", why: "legacy schedule CLI" }],
    ["cli/sop.ts", { owner: "R5", why: "legacy sop CLI" }],
    ["cli/thread.ts", { owner: "R1-a", why: "task-bound thread CLI; v1 thread CLI replaces it" }],
    ["workers/control.ts", { owner: "R2", why: "serves legacy a2a tool calls until v1 surface lands" }],
    ["workers/tool-policy.ts", { owner: "R2", why: "legacy A2A role tool policy" }],
    ["workers/worker-extension.ts", { owner: "R2", why: "registers legacy A2A tool specs" }],
    ["workers/executor.ts", { owner: "R2", why: "task-bound executor branches" }],
    ["workers/runtime.ts", { owner: "R2", why: "task-bound runtime branches" }],
    ["eval/report.ts", { owner: "R5", why: "reads legacy review model-family" }],
  ].map(([k, v]) => [k, v]),
);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

function isShim(rel, src) {
  // Shims live at the old top-level paths and only re-export legacy.
  if (rel === "control/migrations/index.ts") {
    return /^\/\/ Legacy compatibility shim/.test(src);
  }
  if (!LEGACY_TOP_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`))) return false;
  return /^\/\/ Legacy compatibility shim/.test(src);
}

function importsLegacy(rel, src) {
  const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  // Importing the legacy control/migrations barrel from anywhere inside
  // control/ uses a dir-relative specifier (./migrations/, ../migrations/).
  if (dir.startsWith("control") && !dir.startsWith("control/stores/types")) {
    const relSpec = relative(dir, "control/migrations").replaceAll("\\\\", "/");
    if (relSpec && src.includes(`from "./${relSpec}/`)) return true;
  }
  const up = (rel.match(/\//g) || []).length;
  const prefixes = [];
  for (let i = 0; i <= up; i++) {
    prefixes.push("../".repeat(i));
  }
  prefixes.push(`./`);
  const legacyA2aFiles = [
    "index",
    "tools",
    "tool-surface",
    "principal",
    "observation",
    "terminal",
    "requests",
  ];
  return prefixes.some((pre) => {
    if (src.includes(`from "${pre}legacy/task-first/`)) return true;
    if (src.includes(`from "${pre}control/migrations/`)) return true;
    if (src.includes(`from "${pre}a2a/`)) {
      // a2a/ is also a future v1 dir name; only the legacy implementation
      // files below count as legacy imports from active code.
      return legacyA2aFiles.some((f) => src.includes(`from "${pre}a2a/${f}.ts"`));
    }
    return LEGACY_TOP_DIRS.some((d) => d !== "a2a" && src.includes(`from "${pre}${d}/`));
  });
}

const errors = [];
const offenders = new Set();

for (const file of walk(DAEMON_SRC)) {
  const rel = relative(DAEMON_SRC, file).replaceAll("\\", "/");
  const src = readFileSync(file, "utf8");
  const inV1 = V1_DIRS.some((d) => rel.startsWith(`${d}/`));

  if (rel.startsWith("legacy/")) continue;
  if (isShim(rel, src)) continue;

  if (importsLegacy(rel, src)) {
    offenders.add(rel);
    const entry = LEGACY_IMPORT_ALLOWLIST.get(rel);
    if (inV1) {
      errors.push(`${rel}: v1 runtime path imports legacy code — not allowlistable`);
    } else if (!entry) {
      errors.push(`${rel}: imports task-first legacy outside the baseline allowlist`);
    }
  }

  if (inV1) {
    for (const tool of RETIRED_TOOL_NAMES) {
      if (src.includes(tool)) errors.push(`${rel}: v1 path references retired tool '${tool}'`);
    }
    for (const table of LEGACY_TABLES) {
      if (new RegExp(`\\b${table}\\b`).test(src)) {
        errors.push(`${rel}: v1 path references frozen legacy table '${table}'`);
      }
    }
  }
}

for (const [rel] of LEGACY_IMPORT_ALLOWLIST) {
  if (!offenders.has(rel)) {
    errors.push(`allowlist stale: ${rel} no longer imports legacy — remove the entry`);
  }
}

if (errors.length > 0) {
  console.error(`check-legacy-boundary: ${errors.length} violation(s)`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log("check-legacy-boundary: OK (boundary held)");
