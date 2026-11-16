import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ControlError } from "../errors.ts";
import { DEVELOPMENT_SOP_STAGE_IDS } from "../sop-definition.generated.ts";
import type { ControlTransaction } from "../transaction.ts";
import type { AuditStore } from "./audit.ts";
import { type Clock, changesOf, jsonObject, mapStoreError, nonEmpty, parseJsonObject } from "./helpers.ts";
import type { ResumeCapsule, SopCheckName, SopChecks, SopStage, UpsertWorkflowSopInput, WorkflowSop } from "./types.ts";

export const SOP_RESUME_CAPSULE_MAX_BYTES = 16_384;
export const SOP_NEXT_SKILL_MAX = 128;
export const SOP_RESUME_DONE_MAX = 100;

interface WorkflowSopRow {
	backlog_item_id: string;
	feature_id: string;
	sop_definition_id: string;
	stage: SopStage;
	baton_holder: string;
	next_skill: string | null;
	resume_capsule_json: string;
	checks_json: string;
	version: number;
	updated_at: number;
	updated_by: string;
}

const SOP_CHECK_KEYS: readonly SopCheckName[] = [
	"remoteMainSynced",
	"qualityGatePassed",
	"reviewApproved",
	"visionGuardDone",
];

const SOP_STAGE_IDS: readonly SopStage[] = DEVELOPMENT_SOP_STAGE_IDS;

function mapSop(row: WorkflowSopRow): WorkflowSop {
	const capsule = parseJsonObject(row.resume_capsule_json) as unknown as ResumeCapsule;
	const checks = parseJsonObject(row.checks_json) as unknown as SopChecks;
	return {
		backlogItemId: row.backlog_item_id,
		featureId: row.feature_id,
		sopDefinitionId: row.sop_definition_id,
		stage: row.stage,
		batonHolder: row.baton_holder,
		nextSkill: row.next_skill,
		resumeCapsule: capsule,
		checks,
		version: row.version,
		updatedAt: row.updated_at,
		updatedBy: row.updated_by,
	};
}

function validateChecks(checks: SopChecks): void {
	if (!checks || typeof checks !== "object" || Array.isArray(checks)) {
		throw new ControlError("invalid_input", "checks must be an object");
	}
	const keys = Object.keys(checks);
	if (keys.length !== SOP_CHECK_KEYS.length || SOP_CHECK_KEYS.some((key) => !keys.includes(key))) {
		throw new ControlError("invalid_input", `checks must contain exactly: ${SOP_CHECK_KEYS.join(", ")}`);
	}
	for (const [key, value] of Object.entries(checks)) {
		if (value === "verified") throw new ControlError("invalid_input", "verified_requires_evidence");
		if (value !== "attested" && value !== "unknown") {
			throw new ControlError("invalid_input", `invalid SOP check status for ${key}`);
		}
	}
}

function validateResumeCapsule(capsule: ResumeCapsule): ResumeCapsule {
	if (!capsule || typeof capsule !== "object" || Array.isArray(capsule)) {
		throw new ControlError("invalid_input", "resumeCapsule must be an object");
	}
	if (
		typeof capsule.goal !== "string" ||
		capsule.goal.trim() === "" ||
		typeof capsule.currentFocus !== "string" ||
		capsule.currentFocus.trim() === ""
	) {
		throw new ControlError("invalid_input", "resumeCapsule.goal and currentFocus are required");
	}
	if (!Array.isArray(capsule.done) || !capsule.done.every((item) => typeof item === "string")) {
		throw new ControlError("invalid_input", "resumeCapsule.done must be a string array");
	}
	if (capsule.done.length > SOP_RESUME_DONE_MAX) {
		throw new ControlError("invalid_input", `resumeCapsule.done supports at most ${SOP_RESUME_DONE_MAX} entries`);
	}
	if (Buffer.byteLength(JSON.stringify(capsule), "utf8") > SOP_RESUME_CAPSULE_MAX_BYTES) {
		throw new ControlError("invalid_input", `resumeCapsule exceeds ${SOP_RESUME_CAPSULE_MAX_BYTES} bytes`);
	}
	return capsule;
}

function validateNextSkill(nextSkill: string | null | undefined): string | null {
	if (nextSkill === null || nextSkill === undefined) return null;
	const value = nonEmpty(nextSkill, "nextSkill");
	if (value.length > SOP_NEXT_SKILL_MAX) {
		throw new ControlError("invalid_input", `nextSkill must be at most ${SOP_NEXT_SKILL_MAX} characters`);
	}
	return value;
}

function validateStage(stage: SopStage): SopStage {
	if (!SOP_STAGE_IDS.includes(stage)) {
		throw new ControlError("invalid_input", `unsupported SOP stage ${String(stage)}`);
	}
	return stage;
}

function validateDefinitionId(value: string | undefined, fallback: string): string {
	const definitionId = value ?? fallback;
	if (definitionId !== "development") {
		throw new ControlError("invalid_input", `unsupported sopDefinitionId ${definitionId}`);
	}
	return definitionId;
}

export class WorkflowSopStore {
	private readonly database: DatabaseSync;
	private readonly transaction: ControlTransaction;
	private readonly clock: Clock;
	private readonly audit: AuditStore;

	constructor(database: DatabaseSync, transaction: ControlTransaction, clock: Clock, audit: AuditStore) {
		this.database = database;
		this.transaction = transaction;
		this.clock = clock;
		this.audit = audit;
	}

	get(backlogItemId: string): WorkflowSop | null {
		const row = this.database.prepare("SELECT * FROM workflow_sops WHERE backlog_item_id = ?").get(backlogItemId) as
			| WorkflowSopRow
			| undefined;
		return row ? mapSop(row) : null;
	}

	listByFeature(featureId: string): WorkflowSop[] {
		const rows = this.database
			.prepare("SELECT * FROM workflow_sops WHERE feature_id = ? ORDER BY updated_at DESC")
			.all(featureId) as unknown as WorkflowSopRow[];
		return rows.map(mapSop);
	}

	workIdentity(backlogItemId: string, ownerUserId: string): { workId: string; attemptId: string } {
		const workId = createHash("sha256").update(`${ownerUserId}:workflow_sop_v1:${backlogItemId}`).digest("hex");
		return { workId, attemptId: `attempt:${workId}:1` };
	}

	upsert(input: UpsertWorkflowSopInput): WorkflowSop {
		const featureId = nonEmpty(input.featureId, "featureId");
		const stage = validateStage(input.stage);
		const checks = input.checks;
		validateChecks(checks);
		const capsule = validateResumeCapsule(input.resumeCapsule);
		const nextSkill = validateNextSkill(input.nextSkill);
		try {
			return this.transaction.run(() => {
				const backlog = this.database
					.prepare("SELECT * FROM backlog_items WHERE id = ?")
					.get(input.backlogItemId) as
					| { id?: string; user_id?: string; title?: string; tags_json?: string; status?: string }
					| undefined;
				if (!backlog?.id) throw new ControlError("not_found", `backlog item ${input.backlogItemId} not found`);
				const tags = JSON.parse(backlog.tags_json ?? "[]") as unknown;
				if (!Array.isArray(tags) || !tags.includes(`feature:${featureId}`)) {
					throw new ControlError("invalid_input", "feature_anchor_required");
				}
				const batonHolder = this.validateBatonHolder(input.batonHolder);
				const now = this.clock();
				const existing = this.get(input.backlogItemId);
				if (existing) {
					const definitionId = validateDefinitionId(input.sopDefinitionId, existing.sopDefinitionId);
					if (existing.sopDefinitionId !== definitionId) {
						throw new ControlError("invalid_input", "sopDefinitionId is immutable once created");
					}
					if (input.expectedVersion === undefined) {
						throw new ControlError("invalid_input", "expectedVersion is required to update a workflow SOP");
					}
					if (existing.version !== input.expectedVersion) {
						throw new ControlError("version_conflict", `workflow SOP version is ${existing.version}`);
					}
					if (stage === "completion") {
						this.assertCompletionGate(input.backlogItemId, input, backlog.status);
					}
					const result = this.database
						.prepare(
							"UPDATE workflow_sops SET sop_definition_id = ?, stage = ?, baton_holder = ?, next_skill = ?, resume_capsule_json = ?, checks_json = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE backlog_item_id = ? AND version = ?",
						)
						.run(
							definitionId,
							stage,
							batonHolder,
							nextSkill,
							jsonObject(capsule, "resumeCapsule"),
							jsonObject(checks, "checks"),
							now,
							nonEmpty(input.updatedBy, "updatedBy"),
							input.backlogItemId,
							input.expectedVersion,
						);
					if (changesOf(result) === 0) {
						throw new ControlError("version_conflict", `workflow SOP ${input.backlogItemId} changed`);
					}
					this.audit.append({
						actor: actorRef(input.updatedBy),
						action: "workflow_sop_updated",
						subject: `workflow_sop:${input.backlogItemId}`,
						args: {
							fromStage: existing.stage,
							toStage: stage,
							version: existing.version + 1,
							featureAnchor: existing.featureId,
							featureRequested: featureId,
						},
					});
					return this.get(input.backlogItemId)!;
				}
				if (stage === "completion") {
					this.assertCompletionGate(input.backlogItemId, input, backlog.status);
				}
				const definitionId = validateDefinitionId(input.sopDefinitionId, "development");
				this.database
					.prepare(
						"INSERT INTO workflow_sops (backlog_item_id, feature_id, sop_definition_id, stage, baton_holder, next_skill, resume_capsule_json, checks_json, version, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
					)
					.run(
						input.backlogItemId,
						featureId,
						definitionId,
						stage,
						batonHolder,
						nextSkill,
						jsonObject(capsule, "resumeCapsule"),
						jsonObject(checks, "checks"),
						now,
						nonEmpty(input.updatedBy, "updatedBy"),
					);
				if (stage !== "completion") {
					const ownerUserId =
						typeof backlog.user_id === "string" && backlog.user_id.trim() !== "" ? backlog.user_id : null;
					if (!ownerUserId) throw new ControlError("schema_incomplete", "backlog item has no owner user id");
					const identity = this.workIdentity(input.backlogItemId, ownerUserId);
					this.database
						.prepare(
							"INSERT INTO work_admissions (work_id, owner_user_id, producer_kind, producer_ref, initial_attempt_id, admitted_at) VALUES (?, ?, 'workflow_sop_v1', ?, ?, ?) ON CONFLICT(work_id) DO NOTHING",
						)
						.run(identity.workId, ownerUserId, input.backlogItemId, identity.attemptId, now);
					const admission = this.database
						.prepare("SELECT * FROM work_admissions WHERE work_id = ?")
						.get(identity.workId) as
						| { owner_user_id?: string; producer_ref?: string; initial_attempt_id?: string }
						| undefined;
					if (
						admission?.owner_user_id !== ownerUserId ||
						admission?.producer_ref !== input.backlogItemId ||
						admission?.initial_attempt_id !== identity.attemptId
					) {
						throw new ControlError("conflict", `work admission ${identity.workId} does not match the SOP`);
					}
					this.database
						.prepare(
							"INSERT INTO work_attempts (attempt_id, work_id, attempt_number, created_at) VALUES (?, ?, 1, ?) ON CONFLICT(attempt_id) DO NOTHING",
						)
						.run(identity.attemptId, identity.workId, now);
					const attempt = this.database
						.prepare("SELECT work_id, attempt_number FROM work_attempts WHERE attempt_id = ?")
						.get(identity.attemptId) as { work_id?: string; attempt_number?: number } | undefined;
					if (attempt?.work_id !== identity.workId || attempt?.attempt_number !== 1) {
						throw new ControlError("conflict", `work attempt ${identity.attemptId} does not match the SOP`);
					}
					this.audit.append({
						actor: "system:workflow-sop",
						action: "work_admitted",
						subject: `work:${identity.workId}`,
						args: { backlogItemId: input.backlogItemId, attemptId: identity.attemptId },
					});
				}
				this.audit.append({
					actor: actorRef(input.updatedBy),
					action: "workflow_sop_created",
					subject: `workflow_sop:${input.backlogItemId}`,
					args: { featureId, stage, version: 1 },
				});
				return this.get(input.backlogItemId)!;
			});
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
	}

	private validateBatonHolder(value: string): string {
		const batonHolder = nonEmpty(value, "batonHolder");
		if (batonHolder === "operator") return batonHolder;
		const profile = this.database.prepare("SELECT status FROM agent_profiles WHERE id = ?").get(batonHolder) as
			| { status?: string }
			| undefined;
		if (!profile || profile.status !== "active") {
			throw new ControlError("invalid_input", "batonHolder must be an active agent profile or operator");
		}
		return batonHolder;
	}

	private assertCompletionGate(
		backlogItemId: string,
		input: UpsertWorkflowSopInput,
		backlogStatus: string | undefined,
	): void {
		if (backlogStatus !== "done") {
			throw new ControlError("invalid_state", "completion_gate_required: backlog item is not done");
		}
		const actor = nonEmpty(input.updatedBy, "updatedBy");
		if (!actor.startsWith("operator:")) {
			throw new ControlError(
				"invalid_state",
				"completion_gate_required: completion must be written by an operator actor",
			);
		}
		const merge = this.database
			.prepare(
				"SELECT m.head_sha, m.merge_sha FROM merges m JOIN tasks t ON t.id = m.task_id WHERE t.backlog_item_id = ? AND m.status = 'succeeded' AND m.executed_by = 'service:merge-owner' AND m.gate_evidence_ref IS NOT NULL ORDER BY m.created_at DESC, m.id DESC LIMIT 1",
			)
			.get(backlogItemId) as { head_sha?: string; merge_sha?: string } | undefined;
		if (!merge?.head_sha || !merge.merge_sha) {
			throw new ControlError("invalid_state", "completion_gate_required: a succeeded merge receipt is required");
		}
		const requestedRevision = input.completionSubjectRevision ?? merge.head_sha;
		if (requestedRevision !== merge.head_sha && requestedRevision !== merge.merge_sha) {
			throw new ControlError(
				"invalid_input",
				"completion_subject_revision_mismatch: subject must match the latest merge head or merge sha",
			);
		}
		const evidence = this.database
			.prepare(
				"SELECT id FROM sop_check_evidence WHERE backlog_item_id = ? AND check_name = 'visionGuardDone' AND evidence_kind = 'vision_guard' AND subject_revision IN (?, ?) ORDER BY recorded_at DESC, id DESC LIMIT 1",
			)
			.get(backlogItemId, merge.head_sha, merge.merge_sha) as { id?: string } | undefined;
		if (!evidence?.id) {
			throw new ControlError(
				"invalid_state",
				"completion_gate_required: fresh visionGuardDone evidence is required",
			);
		}
	}
}

function actorRef(value: string): string {
	return value.includes(":") ? value : `profile:${value}`;
}
