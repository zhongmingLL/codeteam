import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { parse } from "yaml";
import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import type { AgentProfile, Thread } from "../control/stores/types.ts";
import {
	EVAL_DOMAIN_ID_PATTERN,
	type EvalAgentInvocationPacket,
	type EvalDomainRegistryEntry,
	type EvalDomainSla,
	type EvalSourceAdapterId,
	type EvalSourceRefsKind,
	type EvalTriggerPolicyKind,
} from "./contract.ts";

const ENTRY_KEYS = new Set([
	"domainId",
	"descriptionForHuman",
	"systemThreadId",
	"evalAgent",
	"frequency",
	"triggerPolicy",
	"sourceAdapter",
	"sourceRefsKind",
	"sla",
	"enabled",
	"dormancy",
]);
const TRIGGER_POLICY_KEYS = new Set(["kind", "maxDetectionDelayHours"]);
const SLA_KEYS = new Set(["acknowledgementHours", "reevaluationHours"]);
const DORMANCY_KEYS = new Set(["reason", "revivalPath", "decisionRef"]);
const FREQUENCIES = new Set(["manual", "daily", "weekly"]);
const TRIGGER_POLICY_KINDS = new Set<EvalTriggerPolicyKind>(["time_only", "threshold_or_time"]);
const SOURCE_ADAPTERS = new Set<EvalSourceAdapterId>(["task_outcome", "eval_corpus"]);
const SOURCE_REF_KINDS = new Set<EvalSourceRefsKind>(["task", "review", "merge", "artifact", "trajectory"]);

export interface LoadEvalDomainRegistryOptions {
	readonly dir: string;
	readonly store?: ControlStore;
}

export interface ResolvedEvalDomain {
	readonly entry: EvalDomainRegistryEntry;
	readonly profile: AgentProfile;
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

function parseDomainEntry(raw: unknown, filePath: string): EvalDomainRegistryEntry {
	const entry = assertObject(raw, `eval domain ${filePath}`, ENTRY_KEYS);
	const domainId = nonEmptyString(entry.domainId, `${filePath}: domainId`);
	if (!EVAL_DOMAIN_ID_PATTERN.test(domainId)) {
		throw new ControlError("invalid_input", `${filePath}: invalid domainId ${domainId}`);
	}
	const frequency = nonEmptyString(entry.frequency, `${filePath}: frequency`);
	if (!FREQUENCIES.has(frequency)) {
		throw new ControlError("invalid_input", `${filePath}: invalid frequency ${frequency}`);
	}
	const triggerPolicyRaw = assertObject(entry.triggerPolicy, `${filePath}: triggerPolicy`, TRIGGER_POLICY_KEYS);
	const triggerKind = nonEmptyString(triggerPolicyRaw.kind, `${filePath}: triggerPolicy.kind`);
	if (!TRIGGER_POLICY_KINDS.has(triggerKind as EvalTriggerPolicyKind)) {
		throw new ControlError("invalid_input", `${filePath}: invalid triggerPolicy.kind ${triggerKind}`);
	}
	const sourceAdapter = nonEmptyString(entry.sourceAdapter, `${filePath}: sourceAdapter`);
	if (!SOURCE_ADAPTERS.has(sourceAdapter as EvalSourceAdapterId)) {
		throw new ControlError("invalid_input", `${filePath}: invalid sourceAdapter ${sourceAdapter}`);
	}
	const sourceRefsKind = nonEmptyString(entry.sourceRefsKind, `${filePath}: sourceRefsKind`);
	if (!SOURCE_REF_KINDS.has(sourceRefsKind as EvalSourceRefsKind)) {
		throw new ControlError("invalid_input", `${filePath}: invalid sourceRefsKind ${sourceRefsKind}`);
	}
	const slaRaw = assertObject(entry.sla, `${filePath}: sla`, SLA_KEYS);
	const sla: EvalDomainSla = {
		acknowledgementHours: positiveInteger(slaRaw.acknowledgementHours, `${filePath}: sla.acknowledgementHours`),
		reevaluationHours: positiveInteger(slaRaw.reevaluationHours, `${filePath}: sla.reevaluationHours`),
	};
	if (sla.reevaluationHours < sla.acknowledgementHours) {
		throw new ControlError("invalid_input", `${filePath}: reevaluationHours must be >= acknowledgementHours`);
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
	return Object.freeze({
		domainId: domainId as `eval:${string}`,
		...(entry.descriptionForHuman === undefined
			? {}
			: { descriptionForHuman: nonEmptyString(entry.descriptionForHuman, `${filePath}: descriptionForHuman`) }),
		systemThreadId: nonEmptyString(entry.systemThreadId, `${filePath}: systemThreadId`),
		evalAgent: nonEmptyString(entry.evalAgent, `${filePath}: evalAgent`),
		frequency: frequency as EvalDomainRegistryEntry["frequency"],
		triggerPolicy: {
			kind: triggerKind as EvalTriggerPolicyKind,
			maxDetectionDelayHours: positiveInteger(
				triggerPolicyRaw.maxDetectionDelayHours,
				`${filePath}: triggerPolicy.maxDetectionDelayHours`,
			),
		},
		sourceAdapter: sourceAdapter as EvalSourceAdapterId,
		sourceRefsKind: sourceRefsKind as EvalSourceRefsKind,
		sla,
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
		throw new ControlError("invalid_input", `cannot read eval domain registry ${options.dir}`, { cause: error });
	}
	if (files.length === 0) {
		throw new ControlError("invalid_input", `eval domain registry ${options.dir} has no YAML files`);
	}
	const entries: EvalDomainRegistryEntry[] = [];
	const seen = new Set<string>();
	for (const file of files) {
		const path = join(options.dir, file);
		let parsed: unknown;
		try {
			parsed = parse(readFileSync(path, "utf8"));
		} catch (error) {
			throw new ControlError("invalid_input", `cannot parse eval domain ${path}`, { cause: error });
		}
		const entry = parseDomainEntry(parsed, path);
		if (seen.has(entry.domainId)) {
			throw new ControlError("invalid_input", `duplicate eval domainId ${entry.domainId}`);
		}
		seen.add(entry.domainId);
		if (options.store && entry.enabled) resolveEvalDomain({ entry, store: options.store });
		entries.push(entry);
	}
	return entries;
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
	const profile = store.profiles.get(entry.evalAgent);
	if (!profile) {
		throw new ControlError(
			"not_found",
			`eval domain ${entry.domainId} references missing profile ${entry.evalAgent}`,
		);
	}
	if (profile.role !== "eval") {
		throw new ControlError(
			"invalid_state",
			`eval domain ${entry.domainId} profile ${entry.evalAgent} has role ${profile.role}, expected eval`,
		);
	}
	if (profile.status !== "active") {
		throw new ControlError("invalid_state", `eval domain ${entry.domainId} profile ${entry.evalAgent} is disabled`);
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
	return { entry, profile, thread };
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
		evalAgent: resolved.profile.id,
		evalAgentRole: "eval",
		instructions: {
			goal:
				entry.descriptionForHuman ??
				`Evaluate ${entry.sourceAdapter} evidence and return a verdict handoff packet.`,
			sourceAdapter: entry.sourceAdapter,
			sourceRefsKind: entry.sourceRefsKind,
			outputContract: "VerdictHandoffPacketV1",
		},
		context: {
			windowStartMs: input.windowStartMs,
			windowEndMs: input.windowEndMs,
			trendRefs: assertRefs(input.trendRefs, "trendRefs"),
			verdictRefs: assertRefs(input.verdictRefs, "verdictRefs"),
			sourceRefs,
			sla: entry.sla,
		},
	};
}
