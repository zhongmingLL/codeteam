import type { DatabaseSync } from "node:sqlite";
import { ControlError } from "../errors.ts";
import type { ControlTransaction } from "../transaction.ts";
import type { AuditStore } from "./audit.ts";
import { type Clock, mapStoreError, newId, nonEmpty } from "./helpers.ts";
import type { RecordSopCheckEvidenceInput, SopCheckEvidence, SopCheckName, SopEvidenceKind } from "./types.ts";

interface SopCheckEvidenceRow {
	id: string;
	backlog_item_id: string;
	check_name: SopCheckName;
	evidence_kind: SopEvidenceKind;
	evidence_ref: string;
	subject_revision: string;
	recorded_by: string;
	recorded_at: number;
}

export const SOP_CHECK_EVIDENCE_KIND: Readonly<Record<SopCheckName, SopEvidenceKind>> = {
	remoteMainSynced: "git_sync",
	qualityGatePassed: "quality_gate",
	reviewApproved: "review",
	visionGuardDone: "vision_guard",
};

export const SOP_CHECK_NAME_VALUES: readonly SopCheckName[] = [
	"remoteMainSynced",
	"qualityGatePassed",
	"reviewApproved",
	"visionGuardDone",
];

function mapEvidence(row: SopCheckEvidenceRow): SopCheckEvidence {
	return {
		id: row.id,
		backlogItemId: row.backlog_item_id,
		checkName: row.check_name,
		evidenceKind: row.evidence_kind,
		evidenceRef: row.evidence_ref,
		subjectRevision: row.subject_revision,
		recordedBy: row.recorded_by,
		recordedAt: row.recorded_at,
	};
}

export function validateSubjectRevision(value: string): string {
	const revision = nonEmpty(value, "subjectRevision");
	if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(revision)) {
		throw new ControlError("invalid_input", "subjectRevision must be 40 or 64 lowercase hex characters");
	}
	return revision;
}

export class SopCheckEvidenceStore {
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

	list(backlogItemId: string): SopCheckEvidence[] {
		const rows = this.database
			.prepare("SELECT * FROM sop_check_evidence WHERE backlog_item_id = ? ORDER BY recorded_at DESC, id DESC")
			.all(backlogItemId) as unknown as SopCheckEvidenceRow[];
		return rows.map(mapEvidence);
	}

	latest(backlogItemId: string, checkName: SopCheckName): SopCheckEvidence | null {
		const row = this.database
			.prepare(
				"SELECT * FROM sop_check_evidence WHERE backlog_item_id = ? AND check_name = ? ORDER BY recorded_at DESC, id DESC LIMIT 1",
			)
			.get(backlogItemId, checkName) as SopCheckEvidenceRow | undefined;
		return row ? mapEvidence(row) : null;
	}

	record(input: RecordSopCheckEvidenceInput): SopCheckEvidence {
		const checkName = input.checkName;
		if (!SOP_CHECK_NAME_VALUES.includes(checkName)) {
			throw new ControlError("invalid_input", `unknown SOP check ${String(checkName)}`);
		}
		const expectedKind = SOP_CHECK_EVIDENCE_KIND[checkName];
		if (input.evidenceKind !== expectedKind) {
			throw new ControlError("invalid_input", `SOP check ${checkName} requires evidence kind ${expectedKind}`);
		}
		const backlogItemId = nonEmpty(input.backlogItemId, "backlogItemId");
		const evidenceRef = nonEmpty(input.evidenceRef, "evidenceRef");
		const subjectRevision = validateSubjectRevision(input.subjectRevision);
		const recordedBy = nonEmpty(input.recordedBy, "recordedBy");
		const id = input.id ?? newId();
		try {
			return this.transaction.run(() => {
				const backlog = this.database.prepare("SELECT id FROM backlog_items WHERE id = ?").get(backlogItemId);
				if (!backlog) throw new ControlError("not_found", `backlog item ${backlogItemId} not found`);
				const existing = this.database
					.prepare(
						"SELECT * FROM sop_check_evidence WHERE backlog_item_id = ? AND check_name = ? AND subject_revision = ? AND evidence_ref = ?",
					)
					.get(backlogItemId, checkName, subjectRevision, evidenceRef) as SopCheckEvidenceRow | undefined;
				if (existing) return mapEvidence(existing);
				const now = this.clock();
				this.database
					.prepare(
						"INSERT INTO sop_check_evidence (id, backlog_item_id, check_name, evidence_kind, evidence_ref, subject_revision, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(id, backlogItemId, checkName, expectedKind, evidenceRef, subjectRevision, recordedBy, now);
				this.audit.append({
					actor: recordedBy,
					action: "check_verified",
					subject: `workflow_sop:${backlogItemId}`,
					args: {
						checkName,
						evidenceKind: expectedKind,
						evidenceRef,
						subjectRevision,
					},
				});
				return this.getById(id)!;
			});
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
	}

	private getById(id: string): SopCheckEvidence | null {
		const row = this.database.prepare("SELECT * FROM sop_check_evidence WHERE id = ?").get(id) as
			| SopCheckEvidenceRow
			| undefined;
		return row ? mapEvidence(row) : null;
	}
}
