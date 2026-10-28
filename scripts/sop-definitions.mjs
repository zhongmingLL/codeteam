#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const sourcePath = resolve(repoRoot, "sop-definitions/development.yaml");
const outputPath = resolve(repoRoot, "packages/codeteam-daemon/src/control/sop-definition.generated.ts");
const checkOnly = process.argv.includes("--check");

const VALID_SEVERITIES = new Set(["blocker", "warn", "info"]);
const VALID_PREDICATE_TYPES = new Set([
  "changed_files_require_command",
  "command_pattern",
  "command_sequence",
  "design_gate_evidence",
  "env_check",
  "git_state_predicate",
  "handle_check",
  "manual_only",
  "sha_dedup",
]);
const VALID_EVIDENCE_KINDS = new Set(["git_sync", "quality_gate", "review", "vision_guard"]);
const PREDICATE_KEY_ALIASES = {
  future_candidate: "futureCandidate",
  must_include: "mustInclude",
  must_not_include: "mustNotInclude",
  must_match: "mustMatch",
  must_not_match: "mustNotMatch",
  anti_pattern: "antiPattern",
  cwd_contains: "cwdContains",
  before_command: "beforeCommand",
  branch_from: "branchFrom",
  include_globs: "includeGlobs",
  exclude_globs: "excludeGlobs",
  consumer_globs: "consumerGlobs",
  canonical_helper_pattern: "canonicalHelperPattern",
};

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a non-empty string`);
}

function requireArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
}

function hasStringOrArray(value) {
  if (typeof value === "string" && value.trim()) return true;
  return Array.isArray(value) && value.some((entry) => typeof entry === "string" && entry.trim());
}

function normalizePredicate(raw, label) {
  if (!raw || typeof raw !== "object") fail(`${label}.predicate must be an object`);
  const predicate = { ...raw };
  for (const [sourceKey, targetKey] of Object.entries(PREDICATE_KEY_ALIASES)) {
    if (!Object.hasOwn(predicate, sourceKey)) continue;
    predicate[targetKey] = predicate[sourceKey];
    delete predicate[sourceKey];
  }
  if (!VALID_PREDICATE_TYPES.has(predicate.type)) fail(`${label}.predicate.type ${String(predicate.type)} is not supported`);
  if (predicate.type === "manual_only") requireString(predicate.reason, `${label}.predicate.reason`);
  if (predicate.type === "command_pattern" && !hasStringOrArray(predicate.mustMatch) && !hasStringOrArray(predicate.mustNotMatch)) {
    fail(`${label}.predicate command_pattern requires must_match or must_not_match`);
  }
  if (predicate.type === "command_sequence" && !hasStringOrArray(predicate.mustInclude) && !hasStringOrArray(predicate.antiPattern) && !hasStringOrArray(predicate.absent)) {
    fail(`${label}.predicate command_sequence requires must_include, anti_pattern, or absent`);
  }
  if (predicate.type === "git_state_predicate") {
    requireString(predicate.repository, `${label}.predicate.repository`);
    requireArray(predicate.checks, `${label}.predicate.checks`);
  }
  if (predicate.type === "handle_check") requireString(predicate.constraint, `${label}.predicate.constraint`);
  if (predicate.type === "design_gate_evidence") {
    requireArray(predicate.consumerGlobs, `${label}.predicate.consumer_globs`);
    requireString(predicate.canonicalHelperPattern, `${label}.predicate.canonical_helper_pattern`);
  }
  if (predicate.type === "env_check") {
    requireString(predicate.key, `${label}.predicate.key`);
    if (!hasStringOrArray(predicate.mustInclude) && !hasStringOrArray(predicate.mustNotInclude)) {
      fail(`${label}.predicate env_check requires must_include or must_not_include`);
    }
  }
  if (predicate.type === "sha_dedup") requireString(predicate.scope, `${label}.predicate.scope`);
  if (predicate.type === "changed_files_require_command") {
    requireArray(predicate.includeGlobs, `${label}.predicate.include_globs`);
    if (!hasStringOrArray(predicate.mustMatch)) fail(`${label}.predicate changed_files_require_command requires must_match`);
  }
  return predicate;
}

function normalizeRule(raw, kind, suggestedSkill, label) {
  requireString(raw?.id, `${label}.id`);
  requireString(raw?.text, `${label}.text`);
  const severity = raw?.severity ?? "warn";
  if (!VALID_SEVERITIES.has(severity)) fail(`${label}.severity ${String(severity)} is not supported`);
  return {
    id: raw.id,
    kind,
    text: raw.text,
    severity,
    owner: raw?.owner ?? { type: "stage_suggested_skill", skill: suggestedSkill },
    predicate: normalizePredicate(raw?.predicate, label),
  };
}

const parsed = YAML.parse(readFileSync(sourcePath, "utf8"));
requireString(parsed?.id, "definition.id");
requireString(parsed?.domain, "definition.domain");
requireString(parsed?.label, "definition.label");
requireString(parsed?.description, "definition.description");
requireArray(parsed?.stages, "definition.stages");
requireArray(parsed?.checks, "definition.checks");

const checks = parsed.checks.map((check, index) => {
  requireString(check?.name, `checks[${index}].name`);
  requireString(check?.evidenceKind, `checks[${index}].evidenceKind`);
  requireString(check?.label, `checks[${index}].label`);
  if (!VALID_EVIDENCE_KINDS.has(check.evidenceKind)) fail(`checks[${index}].evidenceKind is not supported`);
  return { name: check.name, evidenceKind: check.evidenceKind, label: check.label };
});

const stages = parsed.stages.map((stage, index) => {
  requireString(stage?.id, `stages[${index}].id`);
  requireString(stage?.label, `stages[${index}].label`);
  const suggestedSkill = stage?.suggested_skill ?? stage?.suggestedSkill;
  requireString(suggestedSkill, `stages[${index}].suggested_skill`);
  return {
    id: stage.id,
    label: stage.label,
    suggestedSkill,
    optional: stage?.optional === true,
    hardRules: Array.isArray(stage?.hard_rules)
      ? stage.hard_rules.map((rule, ruleIndex) => normalizeRule(rule, "hard_rule", suggestedSkill, `stages[${index}].hard_rules[${ruleIndex}]`))
      : [],
    pitfalls: Array.isArray(stage?.pitfalls)
      ? stage.pitfalls.map((rule, ruleIndex) => normalizeRule(rule, "pitfall", suggestedSkill, `stages[${index}].pitfalls[${ruleIndex}]`))
      : [],
  };
});

const definition = {
  id: parsed.id,
  domain: parsed.domain,
  label: parsed.label,
  description: parsed.description.trim(),
  checks,
  stages,
};

const stageIds = stages.map((stage) => stage.id);
const source = `/**
 * Auto-generated by scripts/sop-definitions.mjs from sop-definitions/development.yaml.
 * Do not edit by hand. Run: npm run generate:sop-definitions
 */

export const SOP_DEFINITION_IDS = [${JSON.stringify(definition.id)}] as const;
export type SopDefinitionId = (typeof SOP_DEFINITION_IDS)[number];

export const DEVELOPMENT_SOP_STAGE_IDS = ${JSON.stringify(stageIds)} as const;
export type DevelopmentSopStageId = (typeof DEVELOPMENT_SOP_STAGE_IDS)[number];

export const SOP_CHECK_NAMES = ${JSON.stringify(checks.map((check) => check.name))} as const;
export type SopCheckName = (typeof SOP_CHECK_NAMES)[number];

export const DEVELOPMENT_SOP_DEFINITION = ${JSON.stringify(definition, null, 2)} as const;
`;

if (checkOnly) {
  let current = "";
  try {
    current = readFileSync(outputPath, "utf8");
  } catch {
    fail(`generated SOP definition is missing: ${outputPath}`);
  }
  if (current !== source) {
    fail("generated SOP definition is stale; run npm run generate:sop-definitions");
  }
  process.stdout.write("SOP definition is up to date\n");
} else {
  writeFileSync(outputPath, source);
  process.stdout.write(`Wrote ${outputPath}\n`);
}

