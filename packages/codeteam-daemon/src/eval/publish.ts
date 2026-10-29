import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import type { Eval, Message } from "../control/stores/types.ts";
import { digestEvalArtifactManifest, type EvalArtifactSet, readEvalArtifact, writeEvalArtifacts } from "./artifacts.ts";
import {
	EVAL_BUNDLE_ID_PATTERN,
	EVAL_FINDING_KEY_PATTERN,
	EVAL_MEASUREMENT_STATUSES,
	EVAL_VERDICT_KINDS,
	type EvalArtifactRef,
	type EvalCaseProjection,
	type EvalDomainRegistryEntry,
	type EvalDomainSla,
	type EvalLifecycleActor,
	type EvalMeasurementResultV1,
	type EvalMeasurementStatus,
	type EvalVerdictMetricsV1,
	type VerdictHandoffPacketV1,
} from "./contract.ts";
import {
	appendVerdictCycleEvent,
	appendVerdictOpenedEvent,
	deriveEvalCaseId,
	getEvalCase,
	readEvalVerdictMetrics,
} from "./lifecycle.ts";
import { assertNoEvalSecrets } from "./redaction.ts";
import { resolveEvalDomain } from "./registry.ts";

export interface PublishEvalVerdictInput {
	readonly entry: EvalDomainRegistryEntry;
	readonly packet: VerdictHandoffPacketV1;
	readonly measurement: EvalMeasurementResultV1;
	readonly actor: EvalLifecycleActor;
	readonly maxBytes?: number;
	readonly sampleTraceLimit?: number;
}

export interface PublishEvalVerdictResult {
	readonly eval: Eval;
	readonly artifacts: EvalArtifactSet;
	readonly message: Message;
	readonly case: EvalCaseProjection | null;
	readonly replayed: boolean;
}

const PACKET_KEYS = new Set([
	"v",
	"id",
	"domainId",
	"findingKey",
	"createdAt",
	"phenomenon",
	"harnessUnderEval",
	"evidencePacket",
	"dailyTrend",
	"rootCauseHypothesis",
	"verdict",
	"ownerAsk",
	"governance",
	"acceptanceReevalPlan",
	"counterarguments",
]);
const EVIDENCE_KEYS = new Set(["snapshotRefs", "attributionRefs", "metricRefs", "sampleTraceRefs"]);
const DAILY_TREND_KEYS = new Set(["window", "current", "baseline", "threshold", "direction"]);
const ROOT_CAUSE_KEYS = new Set(["summary", "confidence", "alternatives"]);
const OWNER_ASK_KEYS = new Set(["targetFeatureId", "targetOwnerProfileId", "requestedAction"]);
const GOVERNANCE_KEYS = new Set(["cvoAcceptRequired"]);
const REEVAL_KEYS = new Set(["nextEvalAt", "closureCondition"]);
const MEASUREMENT_KEYS = new Set([
	"v",
	"kind",
	"resultId",
	"bundleId",
	"domainId",
	"generatedAt",
	"status",
	"method",
	"cohort",
	"metrics",
	"decision",
	"actionProposal",
	"measurementRef",
]);
const COHORT_KEYS = new Set(["ref", "sha256", "window"]);
const COHORT_WINDOW_KEYS = new Set(["startMs", "endMs"]);
const METRIC_KEYS = new Set(["metricId", "role", "n", "pointEstimate", "evidenceStatus"]);
const DECISION_KEYS = new Set(["status", "reasons", "withdrawalConditions"]);
const ACTION_PROPOSAL_KEYS = new Set(["action", "rationale"]);

function nonEmpty(value: string | undefined, label: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new ControlError("invalid_input", `${label} must be a non-empty string`);
	}
	return value.trim();
}

function assertObject(value: unknown, label: string, keys: ReadonlySet<string>): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ControlError("invalid_input", `${label} must be an object`);
	}
	for (const key of Object.keys(value)) {
		if (!keys.has(key)) throw new ControlError("invalid_input", `${label} has unknown key ${key}`);
	}
	return value as Record<string, unknown>;
}

function assertIso(value: unknown, label: string): string {
	const text = nonEmpty(value as string | undefined, label);
	if (Number.isNaN(Date.parse(text))) throw new ControlError("invalid_input", `${label} must be an ISO timestamp`);
	return text;
}

function assertInteger(value: unknown, label: string, min = 0): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
		throw new ControlError("invalid_input", `${label} must be a safe integer >= ${min}`);
	}
	return value;
}

function assertStringList(value: unknown, label: string, minItems: number): string[] {
	if (!Array.isArray(value) || value.length < minItems) {
		throw new ControlError("invalid_input", `${label} must contain at least ${minItems} item(s)`);
	}
	return value.map((item, index) => nonEmpty(item as string | undefined, `${label}[${index}]`));
}

function assertNumberRecord(value: unknown, label: string): Record<string, number> {
	const raw = assertObject(value, label, new Set(Object.keys((value ?? {}) as Record<string, unknown>)));
	const record: Record<string, number> = {};
	for (const [key, entry] of Object.entries(raw)) {
		if (typeof entry !== "number" || !Number.isFinite(entry)) {
			throw new ControlError("invalid_input", `${label}.${key} must be a number`);
		}
		record[key] = entry;
	}
	return record;
}

export function validateVerdictPacket(packet: VerdictHandoffPacketV1, entry: EvalDomainRegistryEntry): void {
	const raw = assertObject(packet, "verdict packet", PACKET_KEYS);
	if (raw.v !== 1) throw new ControlError("invalid_input", "verdict packet version must be 1");
	nonEmpty(packet.id, "packet.id");
	if (packet.domainId !== entry.domainId) {
		throw new ControlError(
			"invalid_input",
			`packet domainId ${packet.domainId} does not match registry ${entry.domainId}`,
		);
	}
	assertIso(packet.createdAt, "packet.createdAt");
	if (packet.findingKey !== undefined && !EVAL_FINDING_KEY_PATTERN.test(packet.findingKey)) {
		throw new ControlError("invalid_input", `invalid findingKey ${packet.findingKey}`);
	}
	nonEmpty(packet.phenomenon, "packet.phenomenon");
	const harness = assertObject(
		packet.harnessUnderEval,
		"harnessUnderEval",
		new Set(["featureId", "componentId", "name"]),
	);
	nonEmpty(harness.featureId as string | undefined, "harnessUnderEval.featureId");
	nonEmpty(harness.componentId as string | undefined, "harnessUnderEval.componentId");
	nonEmpty(harness.name as string | undefined, "harnessUnderEval.name");
	const evidence = assertObject(packet.evidencePacket, "evidencePacket", EVIDENCE_KEYS);
	for (const key of EVIDENCE_KEYS) {
		assertStringList(evidence[key], `evidencePacket.${key}`, 1);
	}
	const dailyTrend = assertObject(packet.dailyTrend, "dailyTrend", DAILY_TREND_KEYS);
	nonEmpty(dailyTrend.window as string | undefined, "dailyTrend.window");
	assertNumberRecord(dailyTrend.current, "dailyTrend.current");
	assertNumberRecord(dailyTrend.baseline, "dailyTrend.baseline");
	assertNumberRecord(dailyTrend.threshold, "dailyTrend.threshold");
	if (!["improved", "regressed", "flat", "unknown"].includes(String(dailyTrend.direction))) {
		throw new ControlError("invalid_input", "dailyTrend.direction is invalid");
	}
	const rootCause = assertObject(packet.rootCauseHypothesis, "rootCauseHypothesis", ROOT_CAUSE_KEYS);
	nonEmpty(rootCause.summary as string | undefined, "rootCauseHypothesis.summary");
	if (!["low", "medium", "high"].includes(String(rootCause.confidence))) {
		throw new ControlError("invalid_input", "rootCauseHypothesis.confidence is invalid");
	}
	assertStringList(rootCause.alternatives, "rootCauseHypothesis.alternatives", 0);
	if (!EVAL_VERDICT_KINDS.includes(packet.verdict)) {
		throw new ControlError("invalid_input", `invalid verdict ${String(packet.verdict)}`);
	}
	const ownerAsk = assertObject(packet.ownerAsk, "ownerAsk", OWNER_ASK_KEYS);
	const targetFeatureId = nonEmpty(ownerAsk.targetFeatureId as string | undefined, "ownerAsk.targetFeatureId");
	const targetOwnerProfileId = nonEmpty(
		ownerAsk.targetOwnerProfileId as string | undefined,
		"ownerAsk.targetOwnerProfileId",
	);
	if (targetFeatureId !== entry.handoffTargetResolver.featureId) {
		throw new ControlError(
			"invalid_input",
			"ownerAsk.targetFeatureId must match registry handoffTargetResolver.featureId",
		);
	}
	if (targetOwnerProfileId !== entry.handoffTargetResolver.ownerProfileId) {
		throw new ControlError(
			"invalid_input",
			"ownerAsk.targetOwnerProfileId must match registry handoffTargetResolver.ownerProfileId",
		);
	}
	nonEmpty(ownerAsk.requestedAction as string | undefined, "ownerAsk.requestedAction");
	if (packet.governance !== undefined) {
		const governance = assertObject(packet.governance, "governance", GOVERNANCE_KEYS);
		if (typeof governance.cvoAcceptRequired !== "boolean") {
			throw new ControlError("invalid_input", "governance.cvoAcceptRequired must be a boolean");
		}
		if (packet.verdict === "delete_sunset" && !governance.cvoAcceptRequired) {
			throw new ControlError("invalid_input", "delete_sunset requires cvoAcceptRequired=true");
		}
		if (packet.verdict !== "delete_sunset" && governance.cvoAcceptRequired) {
			throw new ControlError("invalid_input", "only delete_sunset may declare cvoAcceptRequired=true");
		}
	} else if (packet.verdict === "delete_sunset") {
		throw new ControlError("invalid_input", "delete_sunset requires governance.cvoAcceptRequired=true");
	}
	const plan = assertObject(packet.acceptanceReevalPlan, "acceptanceReevalPlan", REEVAL_KEYS);
	const nextEvalAt = assertIso(plan.nextEvalAt, "acceptanceReevalPlan.nextEvalAt");
	if (Date.parse(nextEvalAt) <= Date.parse(packet.createdAt)) {
		throw new ControlError("invalid_input", "acceptanceReevalPlan.nextEvalAt must follow packet.createdAt");
	}
	nonEmpty(plan.closureCondition as string | undefined, "acceptanceReevalPlan.closureCondition");
	assertStringList(packet.counterarguments, "counterarguments", 0);
}

function validateMeasurement(
	packet: VerdictHandoffPacketV1,
	measurement: EvalMeasurementResultV1,
	sampleTraceLimit: number,
): EvalMeasurementStatus {
	const raw = assertObject(measurement, "measurement", MEASUREMENT_KEYS);
	if (raw.v !== 1 || raw.kind !== "eval_measurement_result") {
		throw new ControlError("invalid_input", "measurement must be EvalMeasurementResultV1");
	}
	nonEmpty(measurement.resultId, "measurement.resultId");
	if (!EVAL_BUNDLE_ID_PATTERN.test(measurement.bundleId)) {
		throw new ControlError("invalid_input", `invalid measurement.bundleId ${measurement.bundleId}`);
	}
	if (measurement.domainId !== packet.domainId)
		throw new ControlError("invalid_input", "measurement.domainId must match packet");
	assertIso(measurement.generatedAt, "measurement.generatedAt");
	if (!EVAL_MEASUREMENT_STATUSES.includes(measurement.status)) {
		throw new ControlError("invalid_input", `invalid measurement status ${String(measurement.status)}`);
	}
	nonEmpty(measurement.method, "measurement.method");
	nonEmpty(measurement.measurementRef, "measurement.measurementRef");
	const cohort = assertObject(measurement.cohort, "measurement.cohort", COHORT_KEYS);
	nonEmpty(cohort.ref as string | undefined, "measurement.cohort.ref");
	const sha = nonEmpty(cohort.sha256 as string | undefined, "measurement.cohort.sha256");
	if (!/^[a-f0-9]{64}$/.test(sha)) throw new ControlError("invalid_input", "measurement.cohort.sha256 must be 64 hex");
	const window = assertObject(cohort.window, "measurement.cohort.window", COHORT_WINDOW_KEYS);
	const startMs = assertInteger(window.startMs, "measurement.cohort.window.startMs");
	const endMs = assertInteger(window.endMs, "measurement.cohort.window.endMs", 1);
	if (endMs <= startMs) throw new ControlError("invalid_input", "measurement cohort window end must follow start");
	if (!Array.isArray(measurement.metrics))
		throw new ControlError("invalid_input", "measurement.metrics must be an array");
	for (const [index, metric] of measurement.metrics.entries()) {
		const metricRaw = assertObject(metric, `measurement.metrics[${index}]`, METRIC_KEYS);
		nonEmpty(metricRaw.metricId as string | undefined, `measurement.metrics[${index}].metricId`);
		if (!["primary_loss", "guardrail"].includes(String(metricRaw.role))) {
			throw new ControlError("invalid_input", `measurement.metrics[${index}].role is invalid`);
		}
		assertInteger(metricRaw.n, `measurement.metrics[${index}].n`);
		if (metricRaw.pointEstimate !== null && typeof metricRaw.pointEstimate !== "number") {
			throw new ControlError("invalid_input", `measurement.metrics[${index}].pointEstimate must be number or null`);
		}
		if (!["sufficient", "insufficient"].includes(String(metricRaw.evidenceStatus))) {
			throw new ControlError("invalid_input", `measurement.metrics[${index}].evidenceStatus is invalid`);
		}
	}
	const decision = assertObject(measurement.decision, "measurement.decision", DECISION_KEYS);
	const decisionStatus = nonEmpty(decision.status as string | undefined, "measurement.decision.status");
	const reasons = assertStringList(decision.reasons, "measurement.decision.reasons", 0);
	assertStringList(decision.withdrawalConditions, "measurement.decision.withdrawalConditions", 0);
	if (measurement.status === "ok" && decisionStatus !== "usable") {
		throw new ControlError("invalid_input", "measurement status ok requires decision usable");
	}
	if (measurement.status !== "ok" && decisionStatus !== "insufficient") {
		throw new ControlError("invalid_input", "non-ok measurement requires decision insufficient");
	}
	if (measurement.status !== "ok" && reasons.length === 0) {
		throw new ControlError("invalid_input", "non-ok measurement requires decision reasons");
	}
	const actionProposal = assertObject(measurement.actionProposal, "measurement.actionProposal", ACTION_PROPOSAL_KEYS);
	if (actionProposal.action !== packet.verdict) {
		throw new ControlError("invalid_input", "measurement.actionProposal.action must match packet verdict");
	}
	nonEmpty(actionProposal.rationale as string | undefined, "measurement.actionProposal.rationale");
	if (packet.evidencePacket.sampleTraceRefs.length > sampleTraceLimit) {
		throw new ControlError(
			"invalid_input",
			`sampleTraceRefs exceeds CODETEAM_EVAL_SAMPLE_TRACE_LIMIT (${sampleTraceLimit})`,
		);
	}
	if (measurement.status !== "ok" && packet.verdict !== "keep_observe") {
		throw new ControlError("invalid_input", `measurement status ${measurement.status} only supports keep_observe`);
	}
	return measurement.status;
}

function renderVerdictMessage(options: {
	readonly packet: VerdictHandoffPacketV1;
	readonly measurement: EvalMeasurementResultV1;
	readonly caseId: string | null;
	readonly lifecycleRootDigest: string;
	readonly manifestDigest: string;
	readonly sla: EvalDomainSla;
}): string {
	const { packet, measurement, caseId, lifecycleRootDigest, manifestDigest, sla } = options;
	const lines = [
		`## Eval verdict ${packet.id}`,
		"",
		`- Domain: ${packet.domainId}`,
		`- Verdict: ${packet.verdict}`,
		`- Measurement: ${measurement.status} (${measurement.cohort.window.startMs}..${measurement.cohort.window.endMs})`,
		`- Case: ${caseId ?? "observation report · no case tracking"}`,
	];
	if (measurement.decision.reasons.length > 0) {
		lines.push(`- Reasons: ${measurement.decision.reasons.join("; ")}`);
	}
	if (packet.findingKey) lines.push(`- Finding key: ${packet.findingKey}`);
	lines.push(
		"",
		"### Owner ask",
		`- Feature: ${packet.ownerAsk.targetFeatureId}`,
		`- Owner: ${packet.ownerAsk.targetOwnerProfileId}`,
		`- Action: ${packet.ownerAsk.requestedAction}`,
		"",
		"### SLA",
		`- Acknowledge within: ${sla.acknowledgeHours}h`,
		`- Re-evaluate within: ${sla.reevalWithinHours}h`,
		`- Next eval at: ${packet.acceptanceReevalPlan.nextEvalAt}`,
		`- Closure condition: ${packet.acceptanceReevalPlan.closureCondition}`,
		"",
		"### Counterarguments",
		...(packet.counterarguments.length === 0
			? ["- none recorded"]
			: packet.counterarguments.map((item) => `- ${item}`)),
		"",
		"### Evidence",
		`- Lifecycle root sha256: ${lifecycleRootDigest}`,
		`- Artifact manifest sha256: ${manifestDigest}`,
	);
	if (packet.verdict === "delete_sunset") {
		lines.push("", "This verdict is awaiting operator accept; W6b did not delete any harness.");
	}
	return lines.join("\n");
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, child]) => child !== undefined)
			.sort(([left], [right]) => left.localeCompare(right));
		return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

function samePacket(left: VerdictHandoffPacketV1, right: VerdictHandoffPacketV1): boolean {
	return canonicalJson(left) === canonicalJson(right);
}

function sameMeasurement(left: EvalMeasurementResultV1, right: EvalMeasurementResultV1): boolean {
	return canonicalJson(left) === canonicalJson(right);
}

function artifactRefs(refs: readonly EvalArtifactRef[]): string[] {
	return refs.map((ref) => `artifact:${ref.artifactId}`);
}

function replayResult(store: ControlStore, record: Eval): PublishEvalVerdictResult {
	const metrics = readEvalVerdictMetrics(record);
	const message = store.messages.get(metrics.messageId);
	if (!message) throw new ControlError("invalid_state", `eval verdict ${record.id} lost its verdict message`);
	const lifecycleRef = metrics.artifacts.find((ref) => ref.kind === "eval-lifecycle-root");
	if (!lifecycleRef) throw new ControlError("invalid_state", `eval verdict ${record.id} has no lifecycle root`);
	const artifacts: EvalArtifactSet = {
		refs: metrics.artifacts,
		lifecycleRoot: JSON.parse(readEvalArtifact(store, lifecycleRef)) as EvalArtifactSet["lifecycleRoot"],
		lifecycleRootDigest: metrics.lifecycleRootDigest,
		manifestDigest: digestEvalArtifactManifest(metrics.artifacts),
		totalBytes: metrics.artifacts.reduce((sum, ref) => sum + ref.bytes, 0),
	};
	return {
		eval: record,
		artifacts,
		message,
		case: metrics.caseId ? getEvalCase(store, metrics.caseId) : null,
		replayed: true,
	};
}

export function publishEvalVerdict(
	store: ControlStore,
	input: PublishEvalVerdictInput,
	now = Date.now,
): PublishEvalVerdictResult {
	const { entry, packet, measurement, actor } = input;
	assertNoEvalSecrets({ packet, measurement }, "verdict_packet");
	validateVerdictPacket(packet, entry);
	const sampleTraceLimit = input.sampleTraceLimit ?? 20;
	const status = validateMeasurement(packet, measurement, sampleTraceLimit);
	const resolved = resolveEvalDomain({ entry, store });
	if (actor.kind !== "agent" || actor.id !== resolved.profile.id) {
		throw new ControlError("forbidden", `publish requires the domain eval agent ${resolved.profile.id}`);
	}
	const existing = store.evals.get(packet.id);
	if (existing) {
		const metrics = readEvalVerdictMetrics(existing);
		if (!samePacket(metrics.packet, packet) || !sameMeasurement(metrics.measurement, measurement)) {
			throw new ControlError("conflict", `eval verdict ${packet.id} already exists with different content`);
		}
		return replayResult(store, existing);
	}
	const caseId = packet.findingKey ? deriveEvalCaseId(packet.domainId, packet.findingKey) : null;
	let cycle = false;
	if (caseId) {
		const existingCase = store.database
			.prepare("SELECT 1 AS present FROM eval_lifecycle_events WHERE case_id = ? LIMIT 1")
			.get(caseId) as { present?: number } | undefined;
		if (existingCase?.present) {
			const projection = getEvalCase(store, caseId, now());
			if (projection.status !== "resolved") {
				throw new ControlError(
					"conflict",
					`eval case ${caseId} is ${projection.status}; a new verdict cycle requires resolved`,
				);
			}
			cycle = true;
		}
	}
	const written = writeEvalArtifacts({
		store,
		packet,
		measurement,
		maxBytes: input.maxBytes ?? 5 * 1024 * 1024,
	});
	const bodyMd = renderVerdictMessage({
		packet,
		measurement,
		caseId,
		lifecycleRootDigest: written.lifecycleRootDigest,
		manifestDigest: written.manifestDigest,
		sla: entry.sla,
	});
	assertNoEvalSecrets(bodyMd, "verdict_message");
	try {
		return store.transaction.run(() => {
			const message = store.messages.append({
				threadId: entry.systemThreadId,
				authorKind: "agent",
				authorId: resolved.profile.id,
				kind: "verdict",
				bodyMd,
			});
			const metrics: EvalVerdictMetricsV1 = {
				v: 1,
				kind: "eval_verdict",
				packet,
				measurement,
				evalAgentProfileId: resolved.profile.id,
				systemThreadId: entry.systemThreadId,
				sla: entry.sla,
				messageId: message.id,
				artifacts: written.refs,
				lifecycleRootDigest: written.lifecycleRootDigest,
				...(packet.findingKey ? { findingKey: packet.findingKey } : {}),
				...(caseId ? { caseId } : {}),
			};
			const evalRecord = store.evals.create({
				id: packet.id,
				taskId: null,
				provider: resolved.profile.provider,
				model: resolved.profile.model,
				role: resolved.profile.role,
				metrics: metrics as unknown as Record<string, unknown>,
				domainId: entry.domainId,
				bundleId: measurement.bundleId,
				verdictId: packet.id,
				windowStartMs: measurement.cohort.window.startMs,
				windowEndMs: measurement.cohort.window.endMs,
				measurementRef: measurement.measurementRef,
				status,
				reasons: measurement.decision.reasons,
				createdAt: Date.parse(packet.createdAt),
			});
			let caseProjection: EvalCaseProjection | null = null;
			if (caseId) {
				const refs = artifactRefs(written.refs);
				const occurredAt = packet.createdAt;
				if (cycle) {
					appendVerdictCycleEvent(
						store,
						{
							verdictId: packet.id,
							eventId: `eval-cycle:${packet.id}`,
							refs,
							occurredAt,
						},
						now,
					);
				} else {
					appendVerdictOpenedEvent(
						store,
						{
							verdictId: packet.id,
							eventId: `eval-opened:${packet.id}`,
							refs,
							occurredAt,
						},
						now,
					);
				}
				caseProjection = getEvalCase(store, caseId, now());
			}
			return {
				eval: evalRecord,
				artifacts: written,
				message,
				case: caseProjection,
				replayed: false,
			};
		});
	} catch (error) {
		if (error instanceof ControlError && error.code === "conflict") {
			const raced = store.evals.get(packet.id);
			if (raced) {
				const metrics = readEvalVerdictMetrics(raced);
				if (samePacket(metrics.packet, packet) && sameMeasurement(metrics.measurement, measurement)) {
					return replayResult(store, raced);
				}
			}
		}
		throw error;
	}
}
