import { dirname } from "node:path";
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
	type EvalMeasurementStatus,
	type EvalVerdictMetricsV1,
	type VerdictFindingV1,
	type VerdictHandoffPacketV1,
} from "./contract.ts";
import { appendVerdictOpenedEvent, deriveEvalCaseId, getEvalCase, readEvalVerdictMetrics } from "./lifecycle.ts";
import { assertNoEvalSecrets } from "./redaction.ts";
import { resolveEvalDomain } from "./registry.ts";

export interface PublishEvalVerdictInput {
	readonly entry: EvalDomainRegistryEntry;
	readonly packet: VerdictHandoffPacketV1;
	readonly actor: EvalLifecycleActor;
	readonly dataDir: string;
}

export interface PublishEvalVerdictResult {
	readonly eval: Eval;
	readonly artifacts: EvalArtifactSet;
	readonly message: Message;
	readonly case: EvalCaseProjection | null;
	readonly replayed: boolean;
}

function nonEmpty(value: string | undefined, label: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new ControlError("invalid_input", `${label} must be a non-empty string`);
	}
	return value.trim();
}

function assertInteger(value: number, label: string, options: { min?: number } = {}): void {
	if (!Number.isSafeInteger(value) || value < (options.min ?? 0)) {
		throw new ControlError("invalid_input", `${label} must be a safe integer >= ${options.min ?? 0}`);
	}
}

function assertStringList(value: readonly string[] | undefined, label: string, minItems: number): string[] {
	if (!Array.isArray(value) || value.length < minItems) {
		throw new ControlError("invalid_input", `${label} must contain at least ${minItems} item(s)`);
	}
	return value.map((item, index) => nonEmpty(item, `${label}[${index}]`));
}

function validateMeasurement(packet: VerdictHandoffPacketV1): EvalMeasurementStatus {
	const measurement = packet.evidencePacket?.measurement;
	if (!measurement) throw new ControlError("invalid_input", "evidencePacket.measurement is required");
	if (!EVAL_MEASUREMENT_STATUSES.includes(measurement.status)) {
		throw new ControlError("invalid_input", `invalid measurement status ${String(measurement.status)}`);
	}
	nonEmpty(measurement.method, "measurement.method");
	nonEmpty(measurement.measurementRef, "measurement.measurementRef");
	assertInteger(measurement.windowStartMs, "measurement.windowStartMs");
	assertInteger(measurement.windowEndMs, "measurement.windowEndMs");
	if (measurement.windowEndMs <= measurement.windowStartMs) {
		throw new ControlError("invalid_input", "measurement.windowEndMs must be greater than windowStartMs");
	}
	const reasons = assertStringList(measurement.reasons ?? [], "measurement.reasons", 0);
	if (measurement.status !== "ok" && reasons.length === 0) {
		throw new ControlError("invalid_input", `measurement status ${measurement.status} requires reasons`);
	}
	return measurement.status;
}

function validateFinding(finding: VerdictFindingV1, index: number): void {
	if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
		throw new ControlError("invalid_input", `findings[${index}] must be an object`);
	}
	if (!["P1", "P2", "P3"].includes(finding.severity)) {
		throw new ControlError("invalid_input", `findings[${index}].severity is invalid`);
	}
	nonEmpty(finding.claim, `findings[${index}].claim`);
	assertStringList(finding.evidenceRefs, `findings[${index}].evidenceRefs`, 1);
	if (finding.falsifier !== undefined) nonEmpty(finding.falsifier, `findings[${index}].falsifier`);
	if (finding.requiredAction !== undefined) nonEmpty(finding.requiredAction, `findings[${index}].requiredAction`);
}

export function validateVerdictPacket(packet: VerdictHandoffPacketV1, entry: EvalDomainRegistryEntry): void {
	if (!packet || typeof packet !== "object" || Array.isArray(packet)) {
		throw new ControlError("invalid_input", "verdict packet must be an object");
	}
	if (packet.v !== 1) throw new ControlError("invalid_input", "verdict packet version must be 1");
	nonEmpty(packet.id, "packet.id");
	if (packet.domainId !== entry.domainId) {
		throw new ControlError(
			"invalid_input",
			`packet domainId ${packet.domainId} does not match registry ${entry.domainId}`,
		);
	}
	if (!EVAL_BUNDLE_ID_PATTERN.test(packet.bundleId)) {
		throw new ControlError("invalid_input", `invalid bundleId ${packet.bundleId}`);
	}
	assertInteger(packet.createdAt, "packet.createdAt", { min: 1 });
	nonEmpty(packet.phenomenon, "packet.phenomenon");
	if (!packet.harnessUnderEval || typeof packet.harnessUnderEval !== "object") {
		throw new ControlError("invalid_input", "harnessUnderEval is required");
	}
	if (!packet.evidencePacket || typeof packet.evidencePacket !== "object") {
		throw new ControlError("invalid_input", "evidencePacket is required");
	}
	if (!packet.ownerAsk || typeof packet.ownerAsk !== "object") {
		throw new ControlError("invalid_input", "ownerAsk is required");
	}
	if (!packet.acceptanceReevalPlan || typeof packet.acceptanceReevalPlan !== "object") {
		throw new ControlError("invalid_input", "acceptanceReevalPlan is required");
	}
	if (!packet.governance || typeof packet.governance !== "object") {
		throw new ControlError("invalid_input", "governance is required");
	}
	nonEmpty(packet.harnessUnderEval.featureId, "harnessUnderEval.featureId");
	nonEmpty(packet.harnessUnderEval.componentId, "harnessUnderEval.componentId");
	nonEmpty(packet.harnessUnderEval.name, "harnessUnderEval.name");
	assertStringList(packet.evidencePacket.sourceRefs, "evidencePacket.sourceRefs", 1);
	nonEmpty(packet.evidencePacket.summary, "evidencePacket.summary");
	const status = validateMeasurement(packet);
	nonEmpty(packet.rootCauseHypothesis, "packet.rootCauseHypothesis");
	if (!EVAL_VERDICT_KINDS.includes(packet.verdict)) {
		throw new ControlError("invalid_input", `invalid verdict ${String(packet.verdict)}`);
	}
	if (packet.findingKey !== undefined && !EVAL_FINDING_KEY_PATTERN.test(packet.findingKey)) {
		throw new ControlError("invalid_input", `invalid findingKey ${packet.findingKey}`);
	}
	if (!Array.isArray(packet.findings)) throw new ControlError("invalid_input", "findings must be an array");
	for (const [index, finding] of packet.findings.entries()) validateFinding(finding, index);
	if (packet.verdict !== "keep_observe" && packet.findings.length === 0) {
		throw new ControlError("invalid_input", `verdict ${packet.verdict} requires at least one finding`);
	}
	nonEmpty(packet.ownerAsk.targetFeatureId, "ownerAsk.targetFeatureId");
	nonEmpty(packet.ownerAsk.targetOwnerProfileId, "ownerAsk.targetOwnerProfileId");
	nonEmpty(packet.ownerAsk.requestedAction, "ownerAsk.requestedAction");
	assertInteger(packet.acceptanceReevalPlan.nextEvalAt, "acceptanceReevalPlan.nextEvalAt", { min: 1 });
	if (packet.acceptanceReevalPlan.nextEvalAt <= packet.createdAt) {
		throw new ControlError("invalid_input", "acceptanceReevalPlan.nextEvalAt must follow packet.createdAt");
	}
	nonEmpty(packet.acceptanceReevalPlan.closureCondition, "acceptanceReevalPlan.closureCondition");
	assertStringList(packet.counterarguments, "counterarguments", 0);
	if (
		typeof packet.governance?.cvoAcceptRequired !== "boolean" ||
		typeof packet.governance?.cvoSuppressed !== "boolean"
	) {
		throw new ControlError("invalid_input", "governance flags must be booleans");
	}
	if (packet.governance.cvoSuppressed) {
		throw new ControlError("forbidden", "cvoSuppressed is operator-only and cannot be published by an eval agent");
	}
	const expectedCvoAccept = packet.verdict === "delete_sunset";
	if (packet.governance.cvoAcceptRequired !== expectedCvoAccept) {
		throw new ControlError(
			"invalid_input",
			`cvoAcceptRequired must be ${expectedCvoAccept} for verdict ${packet.verdict}`,
		);
	}
	if (status !== "ok" && packet.verdict !== "keep_observe") {
		throw new ControlError("invalid_input", `measurement status ${status} only supports keep_observe`);
	}
}

function renderVerdictMessage(options: {
	readonly packet: VerdictHandoffPacketV1;
	readonly caseId: string | null;
	readonly lifecycleRootDigest: string;
	readonly manifestDigest: string;
	readonly sla: EvalDomainSla;
}): string {
	const { packet, caseId, lifecycleRootDigest, manifestDigest, sla } = options;
	const lines = [
		`## Eval verdict ${packet.id}`,
		"",
		`- Domain: ${packet.domainId}`,
		`- Verdict: ${packet.verdict}`,
		`- Measurement: ${packet.evidencePacket.measurement.status} (${packet.evidencePacket.measurement.windowStartMs}..${packet.evidencePacket.measurement.windowEndMs})`,
		`- Case: ${caseId ?? "observation report · no case tracking"}`,
	];
	if (packet.evidencePacket.measurement.reasons.length > 0) {
		lines.push(`- Reasons: ${packet.evidencePacket.measurement.reasons.join("; ")}`);
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
		`- Acknowledge within: ${sla.acknowledgementHours}h`,
		`- Re-evaluate within: ${sla.reevaluationHours}h`,
		`- Next eval at: ${packet.acceptanceReevalPlan.nextEvalAt} (epoch ms)`,
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

function artifactRefs(refs: readonly EvalArtifactRef[]): string[] {
	return refs.map((ref) => `eval-artifact:${ref.kind}:${ref.sha256}`);
}

export function publishEvalVerdict(
	store: ControlStore,
	input: PublishEvalVerdictInput,
	now = Date.now,
): PublishEvalVerdictResult {
	const { entry, packet, actor, dataDir } = input;
	assertNoEvalSecrets(packet, "verdict_packet");
	validateVerdictPacket(packet, entry);
	const resolved = resolveEvalDomain({ entry, store });
	if (actor.kind !== "eval" || actor.id !== resolved.profile.id) {
		throw new ControlError("forbidden", `publish requires the domain eval agent ${resolved.profile.id}`);
	}
	const owner = store.profiles.get(packet.ownerAsk.targetOwnerProfileId);
	if (!owner) {
		throw new ControlError("not_found", `verdict owner profile ${packet.ownerAsk.targetOwnerProfileId} not found`);
	}
	if (owner.status !== "active") {
		throw new ControlError(
			"invalid_state",
			`verdict owner profile ${packet.ownerAsk.targetOwnerProfileId} is disabled`,
		);
	}
	const existing = store.evals.get(packet.id);
	if (existing) {
		const metrics = readEvalVerdictMetrics(existing);
		if (!samePacket(metrics.packet, packet)) {
			throw new ControlError("conflict", `eval verdict ${packet.id} already exists with different content`);
		}
		const message = store.messages.get(metrics.messageId);
		if (!message) throw new ControlError("invalid_state", `eval verdict ${packet.id} lost its verdict message`);
		const lifecycleRef = metrics.artifacts.find((ref) => ref.kind === "lifecycle-root");
		if (!lifecycleRef) throw new ControlError("invalid_state", `eval verdict ${packet.id} has no lifecycle root`);
		const artifacts: EvalArtifactSet = {
			rootDir: dirname(lifecycleRef.path),
			refs: metrics.artifacts,
			lifecycleRoot: JSON.parse(readEvalArtifact(lifecycleRef)) as EvalArtifactSet["lifecycleRoot"],
			lifecycleRootDigest: metrics.lifecycleRootDigest,
			manifestDigest: digestEvalArtifactManifest(metrics.artifacts),
		};
		const caseProjection = metrics.caseId ? getEvalCase(store, metrics.caseId) : null;
		return {
			eval: existing,
			artifacts: { ...artifacts, lifecycleRootDigest: metrics.lifecycleRootDigest },
			message,
			case: caseProjection,
			replayed: true,
		};
	}
	const caseId = packet.findingKey ? deriveEvalCaseId(packet.domainId, packet.findingKey) : null;
	if (caseId) {
		const existingCase = store.database
			.prepare("SELECT verdict_id FROM eval_lifecycle_events WHERE case_id = ? ORDER BY seq LIMIT 1")
			.get(caseId) as { verdict_id?: string } | undefined;
		if (existingCase?.verdict_id && existingCase.verdict_id !== packet.id) {
			throw new ControlError(
				"conflict",
				`eval case ${caseId} is already tracked by verdict ${existingCase.verdict_id}`,
			);
		}
	}
	const written = writeEvalArtifacts({ dataDir, packet });
	const bodyMd = renderVerdictMessage({
		packet,
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
				evalAgent: resolved.profile.id,
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
				bundleId: packet.bundleId,
				verdictId: packet.id,
				windowStartMs: packet.evidencePacket.measurement.windowStartMs,
				windowEndMs: packet.evidencePacket.measurement.windowEndMs,
				measurementRef: packet.evidencePacket.measurement.measurementRef,
				status: packet.evidencePacket.measurement.status,
				reasons: packet.evidencePacket.measurement.reasons,
				createdAt: packet.createdAt,
			});
			let caseProjection: EvalCaseProjection | null = null;
			if (caseId) {
				appendVerdictOpenedEvent(
					store,
					{
						verdictId: packet.id,
						eventId: `eval-opened:${packet.id}`,
						actor,
						refs: artifactRefs(written.refs),
						createdAt: packet.createdAt,
					},
					now,
				);
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
				if (samePacket(metrics.packet, packet)) {
					const message = store.messages.get(metrics.messageId);
					if (!message)
						throw new ControlError("invalid_state", `eval verdict ${packet.id} lost its verdict message`);
					return {
						eval: raced,
						artifacts: written,
						message,
						case: metrics.caseId ? getEvalCase(store, metrics.caseId) : null,
						replayed: true,
					};
				}
			}
		}
		throw error;
	}
}
