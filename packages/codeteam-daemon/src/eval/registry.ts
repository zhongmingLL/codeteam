import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { parse } from "yaml";
import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import type { AgentProfile, Thread } from "../control/stores/types.ts";
import { type EvalConfig, resolveEvalConfig } from "./config.ts";
import {
	EVAL_DOMAIN_ID_PATTERN,
	type EvalAgentInvocationPacket,
	type EvalDomainFixture,
	type EvalDomainRegistryEntry,
	type EvalDomainSla,
	type EvalSourceAdapterId,
	type EvalSourceRefsKind,
	type EvalTriggerPolicy,
} from "./contract.ts";

const ENTRY_KEYS = new Set([
	"domainId",
	"displayName",
	"descriptionForHuman",
	"metricGlossary",
	"systemThreadId",
	"evalAgent",
	"frequency",
	"triggerPolicy",
	"sourceAdapter",
	"sourceRefsKind",
	"handoffTargetResolver",
	"sla",
	"fixtures",
	"legacyScheduledTaskIds",
	"enabled",
	"dormancy",
]);
const EVAL_AGENT_KEYS = new Set(["profileId", "role", "handle", "model"]);
const HANDOFF_KEYS = new Set(["featureId", "ownerProfileId", "threadLookup"]);
const SLA_KEYS = new Set(["acknowledgeHours", "reevalWithinHours"]);
const DORMANCY_KEYS = new Set(["reason", "revivalPath", "decisionRef"]);
const FIXTURE_KEYS = new Set(["id", "featureId", "path", "skill", "signal"]);
const TIME_ONLY_KEYS = new Set(["mode", "maxDetectionDelayHours"]);
const THRESHOLD_KEYS = new Set(["mode", "cooldownHours", "eventSource", "threshold"]);
const FREQUENCY_PATTERN = /^(?:daily|weekly|every-[1-9][0-9]*d)$/;
const FEATURE_ID_PATTERN = /^F[0-9]+$/;
const SOURCE_ADAPTERS = new Set<EvalSourceAdapterId>(["task_outcome", "eval_corpus"]);
const SOURCE_REF_KINDS = new Set<EvalSourceRefsKind>(["task", "review", "merge", "artifact", "trajectory"]);

export interface LoadEvalDomainRegistryOptions {
	readonly dir: string;
	readonly store?: ControlStore;
	readonly defaults?: EvalDomainSla;
	readonly allowMissing?: boolean;
}

export interface ResolvedEvalDomain {
	readonly entry: EvalDomainRegistryEntry;
	readonly profile: AgentProfile;
	readonly owner: AgentProfile;
	readonly thread: Thread;
}

export interface BuildEvalAgentInvocationInput {
	readonly invocationId: string;
	readonly windowStartMs: number;
	readonly windowEndMs: number;
	readonly trendRefs?: readonly string[];
	readonly verdictRefs?: readonly string[];
	readonly sourceRefs?: readonly string[];
}

function assertObject(value: unknown, label: string, allowedKeys: ReadonlySet<string>): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ControlError("invalid_input", `${label} must be a YAML mapping`);
	}
	for (const key of Object.keys(value)) {
		if (!allowedKeys.has(key)) {
			throw new ControlError("invalid_input", `${label} has unknown key ${key}`);
		}
	}
	return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new ControlError("invalid_input", `${label} must be a non-empty string`);
	}
	return value.trim();
}

function positiveInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new ControlError("invalid_input", `${label} must be a positive integer`);
	}
	return value;
}

function parseSla(value: unknown, filePath: string, defaults: EvalDomainSla): EvalDomainSla {
	if (value === undefined) return defaults;
	const raw = assertObject(value, `${filePath}: sla`, SLA_KEYS);
	return {
		acknowledgeHours: positiveInteger(raw.acknowledgeHours, `${filePath}: sla.acknowledgeHours`),
		reevalWithinHours: positiveInteger(raw.reevalWithinHours, `${filePath}: sla.reevalWithinHours`),
	};
}

function parseTriggerPolicy(value: unknown, filePath: string): EvalTriggerPolicy {
	const raw = assertObject(value, `${filePath}: triggerPolicy`, new Set([...TIME_ONLY_KEYS, ...THRESHOLD_KEYS]));
	const mode = nonEmptyString(raw.mode, `${filePath}: triggerPolicy.mode`);
	if (mode === "time_only") {
		for (const key of Object.keys(raw)) {
			if (!TIME_ONLY_KEYS.has(key)) {
				throw new ControlError("invalid_input", `${filePath}: time_only trigger has unknown key ${key}`);
			}
		}
		return {
			mode,
			maxDetectionDelayHours: positiveInteger(
				raw.maxDetectionDelayHours,
				`${filePath}: triggerPolicy.maxDetectionDelayHours`,
			),
		};
	}
	if (mode === "threshold_or_time") {
		for (const key of Object.keys(raw)) {
			if (!THRESHOLD_KEYS.has(key)) {
				throw new ControlError("invalid_input", `${filePath}: threshold trigger has unknown key ${key}`);
			}
		}
		const thresholdRaw = assertObject(
			raw.threshold,
			`${filePath}: triggerPolicy.threshold`,
			new Set(Object.keys(raw.threshold ?? {})),
		);
		const threshold: Record<string, number> = {};
		for (const [key, entry] of Object.entries(thresholdRaw)) {
			if (typeof entry !== "number" || !Number.isFinite(entry)) {
				throw new ControlError("invalid_input", `${filePath}: triggerPolicy.threshold.${key} must be a number`);
			}
			threshold[key] = entry;
		}
		return {
			mode,
			cooldownHours: positiveInteger(raw.cooldownHours, `${filePath}: triggerPolicy.cooldownHours`),
			eventSource: nonEmptyString(raw.eventSource, `${filePath}: triggerPolicy.eventSource`),
			threshold,
		};
	}
	throw new ControlError("invalid_input", `${filePath}: invalid triggerPolicy.mode ${mode}`);
}

function parseFixtures(value: unknown, filePath: string): EvalDomainFixture[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new ControlError("invalid_input", `${filePath}: fixtures must be an array`);
	return value.map((fixture, index) => {
		const raw = assertObject(fixture, `${filePath}: fixtures[${index}]`, FIXTURE_KEYS);
		const path = nonEmptyString(raw.path, `${filePath}: fixtures[${index}].path`);
		if (path.split(/[\\/]+/).includes("..")) {
			throw new ControlError("invalid_input", `${filePath}: fixtures[${index}].path must not traverse`);
		}
		return {
			id: nonEmptyString(raw.id, `${filePath}: fixtures[${index}].id`),
			featureId: parseFeatureId(raw.featureId, `${filePath}: fixtures[${index}].featureId`),
			path,
			...(raw.skill === undefined
				? {}
				: { skill: nonEmptyString(raw.skill, `${filePath}: fixtures[${index}].skill`) }),
			...(raw.signal === undefined
				? {}
				: { signal: nonEmptyString(raw.signal, `${filePath}: fixtures[${index}].signal`) }),
		};
	});
}

function parseFeatureId(value: unknown, label: string): `F${number}` {
	const featureId = nonEmptyString(value, label);
	if (!FEATURE_ID_PATTERN.test(featureId)) throw new ControlError("invalid_input", `${label} must look like F123`);
	return featureId as `F${number}`;
}

function parseDomainEntry(raw: unknown, filePath: string, defaults: EvalDomainSla): EvalDomainRegistryEntry {
	const entry = assertObject(raw, `eval domain ${filePath}`, ENTRY_KEYS);
	const domainId = nonEmptyString(entry.domainId, `${filePath}: domainId`);
	if (!EVAL_DOMAIN_ID_PATTERN.test(domainId)) {
		throw new ControlError("invalid_input", `${filePath}: invalid domainId ${domainId}`);
	}
	const frequency = nonEmptyString(entry.frequency, `${filePath}: frequency`);
	if (!FREQUENCY_PATTERN.test(frequency)) {
		throw new ControlError("invalid_input", `${filePath}: invalid frequency ${frequency}`);
	}
	const evalAgentRaw = assertObject(entry.evalAgent, `${filePath}: evalAgent`, EVAL_AGENT_KEYS);
	const evalAgentRole = nonEmptyString(evalAgentRaw.role, `${filePath}: evalAgent.role`);
	if (evalAgentRole !== "eval") throw new ControlError("invalid_input", `${filePath}: evalAgent.role must be eval`);
	const handoffRaw = assertObject(entry.handoffTargetResolver, `${filePath}: handoffTargetResolver`, HANDOFF_KEYS);
	const threadLookup = nonEmptyString(handoffRaw.threadLookup, `${filePath}: handoffTargetResolver.threadLookup`);
	if (threadLookup !== "feature-thread") {
		throw new ControlError("invalid_input", `${filePath}: handoffTargetResolver.threadLookup must be feature-thread`);
	}
	const sourceAdapter = nonEmptyString(entry.sourceAdapter, `${filePath}: sourceAdapter`);
	if (!SOURCE_ADAPTERS.has(sourceAdapter as EvalSourceAdapterId)) {
		throw new ControlError("invalid_input", `${filePath}: invalid sourceAdapter ${sourceAdapter}`);
	}
	const sourceRefsKind = nonEmptyString(entry.sourceRefsKind, `${filePath}: sourceRefsKind`);
	if (!SOURCE_REF_KINDS.has(sourceRefsKind as EvalSourceRefsKind)) {
		throw new ControlError("invalid_input", `${filePath}: invalid sourceRefsKind ${sourceRefsKind}`);
	}
	if (typeof entry.enabled !== "boolean") {
		throw new ControlError("invalid_input", `${filePath}: enabled must be a boolean`);
	}
	let dormancy: EvalDomainRegistryEntry["dormancy"];
	if (entry.dormancy !== undefined) {
		const dormancyRaw = assertObject(entry.dormancy, `${filePath}: dormancy`, DORMANCY_KEYS);
		dormancy = {
			reason: nonEmptyString(dormancyRaw.reason, `${filePath}: dormancy.reason`),
			revivalPath: nonEmptyString(dormancyRaw.revivalPath, `${filePath}: dormancy.revivalPath`),
			decisionRef: nonEmptyString(dormancyRaw.decisionRef, `${filePath}: dormancy.decisionRef`),
		};
	}
	if (!entry.enabled && !dormancy) {
		throw new ControlError("invalid_input", `${filePath}: disabled domain requires dormancy metadata`);
	}
	if (entry.enabled && dormancy) {
		throw new ControlError("invalid_input", `${filePath}: enabled domain must not carry stale dormancy metadata`);
	}
	const fixtures = parseFixtures(entry.fixtures, filePath);
	const legacyScheduledTaskIds =
		entry.legacyScheduledTaskIds === undefined
			? []
			: Array.isArray(entry.legacyScheduledTaskIds)
				? entry.legacyScheduledTaskIds.map((item, index) =>
						nonEmptyString(item, `${filePath}: legacyScheduledTaskIds[${index}]`),
					)
				: (() => {
						throw new ControlError("invalid_input", `${filePath}: legacyScheduledTaskIds must be an array`);
					})();
	const metricGlossary =
		entry.metricGlossary === undefined
			? undefined
			: (() => {
					const rawGlossary = assertObject(
						entry.metricGlossary,
						`${filePath}: metricGlossary`,
						new Set(Object.keys(entry.metricGlossary as Record<string, unknown>)),
					);
					const glossary: Record<string, string> = {};
					for (const [key, value] of Object.entries(rawGlossary)) {
						glossary[key] = nonEmptyString(value, `${filePath}: metricGlossary.${key}`);
					}
					return glossary;
				})();
	return Object.freeze({
		domainId: domainId as `eval:${string}`,
		displayName: nonEmptyString(entry.displayName, `${filePath}: displayName`),
		...(entry.descriptionForHuman === undefined
			? {}
			: { descriptionForHuman: nonEmptyString(entry.descriptionForHuman, `${filePath}: descriptionForHuman`) }),
		...(metricGlossary ? { metricGlossary } : {}),
		systemThreadId: nonEmptyString(entry.systemThreadId, `${filePath}: systemThreadId`),
		evalAgent: {
			profileId: nonEmptyString(evalAgentRaw.profileId, `${filePath}: evalAgent.profileId`),
			role: "eval" as const,
			handle: nonEmptyString(evalAgentRaw.handle, `${filePath}: evalAgent.handle`),
			model: nonEmptyString(evalAgentRaw.model, `${filePath}: evalAgent.model`),
		},
		frequency: frequency as EvalDomainRegistryEntry["frequency"],
		triggerPolicy: parseTriggerPolicy(entry.triggerPolicy, filePath),
		sourceAdapter: sourceAdapter as EvalSourceAdapterId,
		sourceRefsKind: sourceRefsKind as EvalSourceRefsKind,
		handoffTargetResolver: {
			featureId: parseFeatureId(handoffRaw.featureId, `${filePath}: handoffTargetResolver.featureId`),
			ownerProfileId: nonEmptyString(handoffRaw.ownerProfileId, `${filePath}: handoffTargetResolver.ownerProfileId`),
			threadLookup: "feature-thread" as const,
		},
		sla: parseSla(entry.sla, filePath, defaults),
		fixtures,
		legacyScheduledTaskIds,
		enabled: entry.enabled,
		...(dormancy ? { dormancy } : {}),
	});
}

export function loadEvalDomainRegistry(options: LoadEvalDomainRegistryOptions): EvalDomainRegistryEntry[] {
	let files: string[];
	try {
		files = readdirSync(options.dir)
			.filter((name) => [".yaml", ".yml"].includes(extname(name)))
			.sort();
	} catch (error) {
		if (options.allowMissing) return [];
		throw new ControlError("invalid_input", `cannot read eval domain registry ${options.dir}`, { cause: error });
	}
	if (files.length === 0) {
		if (options.allowMissing) return [];
		throw new ControlError("invalid_input", `eval domain registry ${options.dir} has no YAML files`);
	}
	const entries: EvalDomainRegistryEntry[] = [];
	const seen = new Set<string>();
	const defaults = options.defaults ?? { acknowledgeHours: 24, reevalWithinHours: 72 };
	for (const file of files) {
		const path = join(options.dir, file);
		let parsed: unknown;
		try {
			parsed = parse(readFileSync(path, "utf8"));
		} catch (error) {
			throw new ControlError("invalid_input", `cannot parse eval domain ${path}`, { cause: error });
		}
		const entry = parseDomainEntry(parsed, path, defaults);
		if (seen.has(entry.domainId)) {
			throw new ControlError("invalid_input", `duplicate eval domainId ${entry.domainId}`);
		}
		seen.add(entry.domainId);
		if (options.store && entry.enabled) resolveEvalDomain({ entry, store: options.store });
		entries.push(entry);
	}
	return entries;
}

export function loadEvalDomainRegistrySafe(options: LoadEvalDomainRegistryOptions): {
	readonly entries: readonly EvalDomainRegistryEntry[];
	readonly warnings: readonly string[];
} {
	if (options.allowMissing && !existsSync(options.dir)) {
		return { entries: [], warnings: [`eval domain registry ${options.dir} is missing`] };
	}
	return { entries: loadEvalDomainRegistry(options), warnings: [] };
}

export function resolveEvalDomain(options: {
	readonly entry: EvalDomainRegistryEntry;
	readonly store: ControlStore;
}): ResolvedEvalDomain {
	const { entry, store } = options;
	if (!entry.enabled) {
		throw new ControlError("invalid_state", `eval domain ${entry.domainId} is disabled or dormant`);
	}
	const role = store.roles.get("eval");
	if (!role || role.status !== "active") {
		throw new ControlError("invalid_state", "eval role is missing or disabled");
	}
	const profile = store.profiles.get(entry.evalAgent.profileId);
	if (!profile) {
		throw new ControlError(
			"not_found",
			`eval domain ${entry.domainId} references missing profile ${entry.evalAgent.profileId}`,
		);
	}
	if (profile.role !== "eval") {
		throw new ControlError(
			"invalid_state",
			`eval domain ${entry.domainId} profile ${entry.evalAgent.profileId} has role ${profile.role}, expected eval`,
		);
	}
	if (profile.status !== "active") {
		throw new ControlError(
			"invalid_state",
			`eval domain ${entry.domainId} profile ${entry.evalAgent.profileId} is disabled`,
		);
	}
	if (profile.model !== entry.evalAgent.model) {
		throw new ControlError(
			"invalid_state",
			`eval domain ${entry.domainId} model ${entry.evalAgent.model} does not match profile model ${profile.model}`,
		);
	}
	const owner = store.profiles.get(entry.handoffTargetResolver.ownerProfileId);
	if (!owner) {
		throw new ControlError(
			"not_found",
			`eval domain ${entry.domainId} references missing owner profile ${entry.handoffTargetResolver.ownerProfileId}`,
		);
	}
	if (owner.status !== "active") {
		throw new ControlError(
			"invalid_state",
			`eval domain ${entry.domainId} owner profile ${entry.handoffTargetResolver.ownerProfileId} is disabled`,
		);
	}
	const thread = store.threads.get(entry.systemThreadId);
	if (!thread) {
		throw new ControlError(
			"not_found",
			`eval domain ${entry.domainId} references missing system thread ${entry.systemThreadId}`,
		);
	}
	if (thread.status !== "active") {
		throw new ControlError(
			"invalid_state",
			`eval domain ${entry.domainId} system thread ${entry.systemThreadId} is archived`,
		);
	}
	return { entry, profile, owner, thread };
}

function assertRefs(refs: readonly string[] | undefined, label: string): string[] {
	const normalized = (refs ?? []).map((ref) => ref.trim());
	if (normalized.some((ref) => ref === "")) {
		throw new ControlError("invalid_input", `${label} must not contain empty refs`);
	}
	return [...new Set(normalized)];
}

export function buildEvalAgentInvocationPacket(options: {
	readonly entry: EvalDomainRegistryEntry;
	readonly store: ControlStore;
	readonly input: BuildEvalAgentInvocationInput;
}): EvalAgentInvocationPacket {
	const { entry, store, input } = options;
	const resolved = resolveEvalDomain({ entry, store });
	if (!Number.isSafeInteger(input.windowStartMs) || input.windowStartMs < 0) {
		throw new ControlError("invalid_input", "windowStartMs must be a non-negative integer");
	}
	if (!Number.isSafeInteger(input.windowEndMs) || input.windowEndMs <= input.windowStartMs) {
		throw new ControlError("invalid_input", "windowEndMs must be greater than windowStartMs");
	}
	const sourceRefs = assertRefs(input.sourceRefs, "sourceRefs");
	const expectedPrefix = entry.sourceRefsKind === "trajectory" ? "inv:" : `${entry.sourceRefsKind}:`;
	if (sourceRefs.length > 0 && !sourceRefs.some((ref) => ref.startsWith(expectedPrefix))) {
		throw new ControlError(
			"invalid_input",
			`sourceRefs must include at least one ${expectedPrefix} ref for ${entry.domainId}`,
		);
	}
	return {
		v: 1,
		invocationId: nonEmptyString(input.invocationId, "invocationId"),
		domainId: entry.domainId,
		targetThreadId: entry.systemThreadId,
		evalAgentProfileId: resolved.profile.id,
		evalAgentRole: "eval",
		instructions: {
			goal:
				entry.descriptionForHuman ?? `Evaluate ${entry.displayName} evidence and return a verdict handoff packet.`,
			publish:
				"Return a VerdictHandoffPacketV1 with non-empty snapshotRefs, attributionRefs, metricRefs, and sampleTraceRefs. The publish pipeline writes immutable artifacts and lifecycle events; do not write the control DB directly.",
			outputContract: "VerdictHandoffPacketV1",
			publishRequired: true,
		},
		context: {
			windowStartMs: input.windowStartMs,
			windowEndMs: input.windowEndMs,
			trendRefs: assertRefs(input.trendRefs, "trendRefs"),
			verdictRefs: assertRefs(input.verdictRefs, "verdictRefs"),
			sourceAdapter: entry.sourceAdapter,
			sourceRefsKind: entry.sourceRefsKind,
			sourceRefs,
			fixtures: entry.fixtures ?? [],
			handoffTargetResolver: entry.handoffTargetResolver,
			sla: entry.sla,
		},
	};
}

export function resolveEvalConfigForDataDir(dataDir: string, env: NodeJS.ProcessEnv = process.env): EvalConfig {
	return resolveEvalConfig({ env, dataDir });
}
