import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ControlError } from "../errors.ts";
import type { ControlTransaction } from "../transaction.ts";
import type { AuditStore } from "./audit.ts";
import { type Clock, changesOf, jsonObject, mapStoreError, nonEmpty, parseJsonObject } from "./helpers.ts";
import type { ResumeCapsule, SopChecks, SopStage, UpsertWorkflowSopInput, WorkflowSop } from "./types.ts";

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
		typeof capsule.currentFocus !== "string" ||
		capsule.currentFocus.trim() === ""
	) {
		throw new ControlError("invalid_input", "resumeCapsule.goal and currentFocus are required");
	}
	if (!Array.isArray(capsule.done) || !capsule.done.every((item) => typeof item === "string")) {
		throw new ControlError("invalid_input", "resumeCapsule.done must be a string array");
	}
	return capsule;
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
		const checks = input.checks;
		validateChecks(checks);
		const capsule = validateResumeCapsule(input.resumeCapsule);
		try {
			return this.transaction.run(() => {
				const backlog = this.database
					.prepare("SELECT * FROM backlog_items WHERE id = ?")
					.get(input.backlogItemId) as
					| { id?: string; user_id?: string; tags_json?: string; status?: string }
					| undefined;
				if (!backlog?.id) throw new ControlError("not_found", `backlog item ${input.backlogItemId} not found`);
				const tags = JSON.parse(backlog.tags_json ?? "[]") as unknown;
				if (!Array.isArray(tags) || !tags.includes(`feature:${featureId}`)) {
					throw new ControlError("invalid_input", "feature_anchor_required");
				}
				if (input.stage === "completion" && backlog.status !== "done") {
					throw new ControlError("invalid_state", "completion requires a done backlog item");
				}
				const now = this.clock();
				const existing = this.get(input.backlogItemId);
				if (existing) {
					if (input.expectedVersion === undefined) {
						throw new ControlError("invalid_input", "expectedVersion is required to update a workflow SOP");
					}
					if (existing.version !== input.expectedVersion) {
						throw new ControlError("version_conflict", `workflow SOP version is ${existing.version}`);
					}
					const result = this.database
						.prepare(
							"UPDATE workflow_sops SET feature_id = ?, sop_definition_id = ?, stage = ?, baton_holder = ?, next_skill = ?, resume_capsule_json = ?, checks_json = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE backlog_item_id = ? AND version = ?",
						)
						.run(
							featureId,
							input.sopDefinitionId ?? existing.sopDefinitionId,
							input.stage,
							nonEmpty(input.batonHolder, "batonHolder"),
							input.nextSkill ?? null,
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
						actor: `profile:${input.updatedBy}`,
						action: "workflow_sop_updated",
						subject: `workflow_sop:${input.backlogItemId}`,
						args: { fromStage: existing.stage, toStage: input.stage, version: existing.version + 1 },
					});
					return this.get(input.backlogItemId)!;
				}
				this.database
					.prepare(
						"INSERT INTO workflow_sops (backlog_item_id, feature_id, sop_definition_id, stage, baton_holder, next_skill, resume_capsule_json, checks_json, version, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
					)
					.run(
						input.backlogItemId,
						featureId,
						input.sopDefinitionId ?? "development",
						input.stage,
						nonEmpty(input.batonHolder, "batonHolder"),
						input.nextSkill ?? null,
						jsonObject(capsule, "resumeCapsule"),
						jsonObject(checks, "checks"),
						now,
						nonEmpty(input.updatedBy, "updatedBy"),
					);
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
					actor: `profile:${input.updatedBy}`,
					action: "workflow_sop_created",
					subject: `workflow_sop:${input.backlogItemId}`,
					args: { featureId, stage: input.stage, version: 1 },
				});
				this.audit.append({
					actor: "system:workflow-sop",
					action: "work_admitted",
					subject: `work:${identity.workId}`,
					args: { backlogItemId: input.backlogItemId, attemptId: identity.attemptId },
				});
				return this.get(input.backlogItemId)!;
			});
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
	}
}
