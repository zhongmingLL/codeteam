import { ControlError } from "../control/errors.ts";
import { DEVELOPMENT_SOP_DEFINITION, DEVELOPMENT_SOP_STAGE_IDS } from "../control/sop-definition.generated.ts";
import type { ControlStore } from "../control/store.ts";
import { validateSubjectRevision } from "../control/stores/sop-check-evidence.ts";
import type {
	BacklogItem,
	Message,
	RecordSopCheckEvidenceInput,
	SopCheckEvidence,
	SopCheckName,
	SopEvidenceKind,
	UpsertWorkflowSopInput,
	WorkflowSopView,
} from "../control/stores/types.ts";

export const SOP_CATALOG = DEVELOPMENT_SOP_DEFINITION;
export const SOP_STAGE_IDS = DEVELOPMENT_SOP_STAGE_IDS;

export interface SopViewOptions {
	currentRevisions?: Partial<Record<SopCheckName, string>>;
}

export interface ResolveBacklogInput {
	backlogItemId?: string;
	threadId?: string;
	featureId?: string;
}

export class SopService {
	private readonly store: ControlStore;

	constructor(store: ControlStore) {
		this.store = store;
	}

	catalog(): typeof SOP_CATALOG {
		return SOP_CATALOG;
	}

	view(backlogItemId: string, options: SopViewOptions = {}): WorkflowSopView | null {
		const sop = this.store.sops.get(backlogItemId);
		if (!sop) return null;
		const evidence = this.store.sopEvidence.list(backlogItemId);
		const currentRevisions = { ...this.defaultRevisions(backlogItemId), ...options.currentRevisions };
		const effectiveChecks = { ...sop.checks } as WorkflowSopView["effectiveChecks"];
		const staleEvidence: SopCheckName[] = [];
		for (const checkName of Object.keys(sop.checks) as SopCheckName[]) {
			const latest = evidence.find((entry) => entry.checkName === checkName);
			if (!latest) continue;
			const revision = currentRevisions[checkName];
			const matchesRevision =
				revision !== undefined &&
				(latest.subjectRevision === revision ||
					(checkName === "visionGuardDone" &&
						(latest.subjectRevision === currentRevisions.reviewApproved ||
							latest.subjectRevision === currentRevisions.qualityGatePassed)));
			if (matchesRevision) {
				effectiveChecks[checkName] = "verified";
			} else {
				effectiveChecks[checkName] = "unknown";
				staleEvidence.push(checkName);
			}
		}
		return { sop, effectiveChecks, evidence, staleEvidence, currentRevisions };
	}

	update(input: UpsertWorkflowSopInput) {
		return this.store.sops.upsert(input);
	}

	recordEvidence(input: RecordSopCheckEvidenceInput): SopCheckEvidence {
		const backlog = this.store.backlog.get(input.backlogItemId);
		if (!backlog) throw new ControlError("not_found", `backlog item ${input.backlogItemId} not found`);
		const subjectRevision = validateSubjectRevision(input.subjectRevision);
		this.assertEvidenceRef(
			input.backlogItemId,
			input.checkName,
			input.evidenceKind,
			input.evidenceRef,
			subjectRevision,
		);
		return this.store.sopEvidence.record({ ...input, subjectRevision });
	}

	resolveBacklogItem(input: ResolveBacklogInput): BacklogItem | null {
		if (input.backlogItemId) {
			const item = this.store.backlog.get(input.backlogItemId);
			if (!item) throw new ControlError("not_found", `backlog item ${input.backlogItemId} not found`);
			return item;
		}
		if (input.threadId) {
			const thread = this.store.threads.get(input.threadId);
			if (!thread) throw new ControlError("not_found", `thread ${input.threadId} not found`);
			return thread.backlogItemId ? this.store.backlog.get(thread.backlogItemId) : null;
		}
		if (input.featureId) {
			const tag = `feature:${input.featureId}`;
			const matches = this.store.backlog.list().filter((item) => item.tags.includes(tag));
			if (matches.length === 0) return null;
			if (matches.length > 1) throw new ControlError("invalid_input", "ambiguous_feature");
			return matches[0]!;
		}
		return null;
	}

	private defaultRevisions(backlogItemId: string): Partial<Record<SopCheckName, string>> {
		const merge = this.store.merges.latestSucceededByBacklog(backlogItemId);
		if (!merge) return {};
		return {
			remoteMainSynced: merge.baseSha,
			qualityGatePassed: merge.headSha,
			reviewApproved: merge.headSha,
			visionGuardDone: merge.mergeSha,
		};
	}

	private assertEvidenceRef(
		backlogItemId: string,
		checkName: SopCheckName,
		evidenceKind: SopEvidenceKind,
		evidenceRef: string,
		subjectRevision: string,
	): void {
		const separator = evidenceRef.indexOf(":");
		if (separator <= 0 || separator === evidenceRef.length - 1) {
			throw new ControlError("invalid_input", "evidenceRef must be <kind>:<id>");
		}
		const prefix = evidenceRef.slice(0, separator);
		const id = evidenceRef.slice(separator + 1);
		if (prefix === "git") {
			if (checkName !== "remoteMainSynced" || evidenceKind !== "git_sync") {
				throw new ControlError("invalid_input", "git evidence is only valid for remoteMainSynced");
			}
			if (id !== subjectRevision) {
				throw new ControlError("invalid_input", "git evidence subjectRevision must match the git sha");
			}
			return;
		}
		if (prefix === "review") {
			if (checkName !== "reviewApproved" || evidenceKind !== "review") {
				throw new ControlError("invalid_input", "review evidence is only valid for reviewApproved");
			}
			const review = this.store.reviews.get(id);
			if (!review) throw new ControlError("not_found", `review ${id} not found`);
			if (review.verdict !== "approve") {
				throw new ControlError("invalid_input", "reviewApproved evidence requires an approve verdict");
			}
			if (review.headSha !== subjectRevision) {
				throw new ControlError("invalid_input", "review evidence subjectRevision must match review headSha");
			}
			this.assertTaskBelongsToBacklog(review.taskId, backlogItemId);
			return;
		}
		if (prefix === "merge") {
			const merge = this.store.merges.get(id);
			if (!merge) throw new ControlError("not_found", `merge ${id} not found`);
			if (merge.status !== "succeeded") {
				throw new ControlError("invalid_input", "merge evidence requires a succeeded receipt");
			}
			if (subjectRevision !== merge.headSha && subjectRevision !== merge.mergeSha) {
				throw new ControlError("invalid_input", "merge evidence subjectRevision must match headSha or mergeSha");
			}
			this.assertTaskBelongsToBacklog(merge.taskId, backlogItemId);
			return;
		}
		if (prefix === "verification") {
			if (checkName !== "qualityGatePassed" || evidenceKind !== "quality_gate") {
				throw new ControlError("invalid_input", "verification evidence is only valid for qualityGatePassed");
			}
			const verification = this.findVerification(id);
			if (!verification) throw new ControlError("not_found", `verification ${id} not found`);
			if (verification.status !== "rejected") {
				throw new ControlError(
					"invalid_input",
					"qualityGatePassed verification evidence must be a closed/rejected falsifier",
				);
			}
			if (verification.headSha !== subjectRevision) {
				throw new ControlError("invalid_input", "verification evidence subjectRevision must match headSha");
			}
			const finding = this.store.reviews.getFinding(verification.findingId);
			const review = finding ? this.store.reviews.get(finding.reviewId) : null;
			if (!review) throw new ControlError("not_found", `review for verification ${id} not found`);
			this.assertTaskBelongsToBacklog(review.taskId, backlogItemId);
			return;
		}
		if (prefix === "artifact") {
			if (checkName !== "qualityGatePassed" && checkName !== "visionGuardDone") {
				throw new ControlError(
					"invalid_input",
					"artifact evidence is only valid for qualityGatePassed or visionGuardDone",
				);
			}
			const artifact = this.store.artifacts.get(id);
			if (!artifact) throw new ControlError("not_found", `artifact ${id} not found`);
			if (artifact.sha256 !== subjectRevision) {
				throw new ControlError("invalid_input", "artifact evidence subjectRevision must match sha256");
			}
			if (artifact.taskId === null) {
				throw new ControlError("invalid_input", "eval artifacts cannot satisfy SOP task evidence");
			}
			this.assertTaskBelongsToBacklog(artifact.taskId, backlogItemId);
			if (checkName === "qualityGatePassed" && artifact.kind !== "test-report" && artifact.kind !== "verification") {
				throw new ControlError("invalid_input", "quality gate artifact must be a test-report or verification");
			}
			return;
		}
		if (prefix === "message") {
			if (checkName !== "visionGuardDone" || evidenceKind !== "vision_guard") {
				throw new ControlError("invalid_input", "message evidence is only valid for visionGuardDone");
			}
			const message = this.store.messages.get(id);
			if (!message) throw new ControlError("not_found", `message ${id} not found`);
			if (message.kind !== "verdict") {
				throw new ControlError("invalid_input", "vision guard evidence message must be a verdict");
			}
			if (message.authorKind !== "agent" && message.authorKind !== "user") {
				throw new ControlError("invalid_input", "vision guard evidence must be authored by a person or agent");
			}
			const thread = this.store.threads.get(message.threadId);
			if (!thread || thread.backlogItemId !== backlogItemId) {
				throw new ControlError("invalid_input", "vision guard message thread is not bound to the backlog item");
			}
			this.assertVisionGuardIndependence(backlogItemId, message);
			return;
		}
		throw new ControlError("invalid_input", `unsupported evidenceRef kind ${prefix}`);
	}

	private assertTaskBelongsToBacklog(taskId: string, backlogItemId: string): void {
		const task = this.store.tasks.get(taskId);
		if (!task) throw new ControlError("not_found", `task ${taskId} not found`);
		if (task.backlogItemId !== backlogItemId) {
			throw new ControlError("invalid_input", "evidence task is not bound to the backlog item");
		}
	}

	private assertVisionGuardIndependence(backlogItemId: string, message: Message): void {
		const tasks = this.store.tasks.list().filter((task) => task.backlogItemId === backlogItemId);
		if (tasks.length === 0) {
			throw new ControlError("invalid_input", "vision guard evidence requires a task bound to the backlog item");
		}
		for (const task of tasks) {
			if (task.ownerProfileId && task.ownerProfileId === message.authorId) {
				throw new ControlError("invalid_input", "vision guard author must not be the task owner");
			}
			const reviews = this.store.reviews.listByTask(task.id);
			if (reviews.some((review) => review.reviewerProfileId === message.authorId)) {
				throw new ControlError("invalid_input", "vision guard author must not be a reviewer of the task");
			}
		}
	}

	private findVerification(id: string): ReturnType<ControlStore["reviews"]["listVerifications"]>[number] | null {
		const findings = this.store.database
			.prepare("SELECT DISTINCT finding_id FROM verifications WHERE id = ?")
			.get(id) as { finding_id?: string } | undefined;
		if (!findings?.finding_id) return null;
		return (
			this.store.reviews.listVerifications(findings.finding_id).find((verification) => verification.id === id) ??
			null
		);
	}
}
