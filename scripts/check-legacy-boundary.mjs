#!/usr/bin/env node
// F018 R1-0 legacy boundary guard.
//
// Rules (plan 0021 §2.5, INDEX docs/legacy/task-first/INDEX.md):
//   1. Files under packages/superagentteam-daemon/src outside `legacy/` and
//      outside the shim files themselves must not import task-first legacy
//      code — directly (`legacy/task-first/`), through an old-path shim
//      (top-level legacy dirs, `a2a/<legacy-file>.ts`, the
//      `control/stores/types.ts` deprecated barrel, `control/read-models.ts`,
//      or the `control/migrations/` barrel) — unless listed in
//      scripts/legacy-boundary-allowlist.json.
//   2. `packages/superagentteam-shared/src` (the v1 type home) has ZERO
//      tolerance: any legacy import fails, no allowlist possible.
//   3. v1 runtime paths (`src/domains/`) additionally must not reference
//      retired tool names or frozen legacy tables, and cannot be allowlisted.
//   4. Stale allowlist entries are an error so the list only ever shrinks.
//
// Allowlist discipline: entries live in
// scripts/legacy-boundary-allowlist.json (file -> {owner, why}) and MUST
// come with an owner + removal stage. The guard cannot mechanically stop an
// author from adding an entry and an import in the same commit — additions
// are visible as diffs to that JSON file and reviewers must reject them.
// Machine-enforced parts: unlisted imports fail, stale entries fail, shared
// package and src/domains/ can never be allowlisted.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const DAEMON_SRC = join(ROOT, "packages/superagentteam-daemon/src");
const SHARED_SRC = join(ROOT, "packages/superagentteam-shared/src");
const ALLOWLIST_PATH = join(ROOT, "scripts/legacy-boundary-allowlist.json");

// v1 A2A entrypoints per plan 0021 §2.5. `a2a/` currently holds only legacy
// shims (exempted by isShim before these checks); non-shim files placed in
// these dirs get the strict v1 rules (no allowlist, no retired tools/tables).
// v1 runtime paths. infrastructure/ added in R1-d per review: the DB layer
// holds greenfield truth, so retired tools/legacy tables are machine-checked
// there too. NOTE: the scan matches raw source text (no comment stripping) —
// legacy tokens in comments also trip it, by design.
const V1_DIRS = ["domains", "a2a", "thread", "invocation", "queue", "infrastructure"];
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
];
const LEGACY_A2A_FILES = [
  "index",
  "tools",
  "tool-surface",
  "principal",
  "observation",
  "terminal",
  "requests",
];
// Old-path shims that are not top-level dirs. Value is the shim path relative
// to daemon src; consumers are detected via dir-relative specifiers.
const LEGACY_SHIM_PATHS = [
  "control/stores/types.ts",
  "control/read-models.ts",
  "control/migrations",
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

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

function isShim(rel, src) {
  if (rel === "control/migrations/index.ts") {
    return /^\/\/ Legacy compatibility shim/.test(src);
  }
  if (rel === "control/stores/types.ts") {
    return src.includes("@deprecated Legacy task-first types");
  }
  if (rel === "control/read-models.ts") {
    return /^\/\/ Legacy compatibility shim/.test(src);
  }
  if (LEGACY_A2A_FILES.some((f) => rel === `a2a/${f}.ts`)) {
    return /^\/\/ Legacy compatibility shim/.test(src);
  }
  if (!LEGACY_TOP_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`))) return false;
  return /^\/\/ Legacy compatibility shim/.test(src);
}

// Compute the import specifiers a file at `rel` would use to reach each
// legacy shim path, and detect them in the source.
function importsLegacyShims(rel, src) {
  const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  for (const shim of LEGACY_SHIM_PATHS) {
    let spec = relative(dir, shim).replaceAll("\\", "/");
    if (!spec.startsWith(".")) spec = `./${spec}`;
    const base = spec.replace(/\.ts$/, "");
    if (src.includes(`from "${base}"`) || src.includes(`from "${spec}"`) || src.includes(`from "${base}/`)) return true;
  }
  return false;
}

function importsLegacy(rel, src) {
  const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  const up = (rel.match(/\//g) || []).length;
  const prefixes = [];
  for (let i = 0; i <= up; i++) prefixes.push("../".repeat(i));
  prefixes.push("./");

  if (prefixes.some((pre) => src.includes(`from "${pre}legacy/task-first/`))) return true;
  if (importsLegacyShims(rel, src)) return true;

  return prefixes.some((pre) => {
    if (src.includes(`from "${pre}a2a/`)) {
      return LEGACY_A2A_FILES.some((f) => src.includes(`from "${pre}a2a/${f}.ts"`));
    }
    return LEGACY_TOP_DIRS.some((d) => d !== "a2a" && src.includes(`from "${pre}${d}/`));
  });
}

const rawAllowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"));
for (const [rel, entry] of Object.entries(rawAllowlist)) {
  if (!entry || typeof entry.owner !== "string" || !entry.owner || typeof entry.why !== "string" || !entry.why) {
    console.error(`check-legacy-boundary: allowlist entry ${rel} must have non-empty owner and why`);
    process.exit(1);
  }
}
const allowlist = new Map(Object.entries(rawAllowlist));
const errors = [];
const offenders = new Set();
const sharedFiles = walk(SHARED_SRC);

for (const file of sharedFiles) {
  const rel = relative(SHARED_SRC, file).replaceAll("\\", "/");
  const src = readFileSync(file, "utf8");
  if (/(from\s+")[^"]*legacy\/task-first\//.test(src) || /(from\s+")[^"]*superagentteam[\\/-]daemon/.test(src)) {
    errors.push(`shared/${rel}: v1 type home must not reference daemon legacy`);
  }
}

for (const file of walk(DAEMON_SRC)) {
  const rel = relative(DAEMON_SRC, file).replaceAll("\\", "/");
  const src = readFileSync(file, "utf8");
  const inV1 = V1_DIRS.some((d) => rel.startsWith(`${d}/`));

  if (rel.startsWith("legacy/")) continue;
  if (isShim(rel, src)) continue;

  if (importsLegacy(rel, src)) {
    offenders.add(rel);
    const entry = allowlist.get(rel);
    if (inV1) {
      errors.push(`${rel}: v1 runtime path imports legacy code — not allowlistable`);
    } else if (!entry) {
      errors.push(`${rel}: imports task-first legacy outside the baseline allowlist`);
    } else if (allowlist.get(rel) && V1_DIRS.length && rel.startsWith(`${V1_DIRS[0]}/`)) {
      errors.push(`${rel}: v1 path cannot be allowlisted`);
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

for (const [rel] of allowlist) {
  if (!offenders.has(rel)) {
    errors.push(`allowlist stale: ${rel} no longer imports legacy — remove the entry`);
  }
}

if (errors.length > 0) {
  console.error(`check-legacy-boundary: ${errors.length} violation(s)`);
  for (const e of errors) console.error(`  - ${e}`);
  console.error(`offenders without allowlist entries can be reviewed via:`);
  console.error(`  rg -l "control/stores/types|legacy/task-first" packages/superagentteam-daemon/src | grep -v legacy`);
  process.exit(1);
}
console.log("check-legacy-boundary: OK (boundary held)");
