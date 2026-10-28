import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import type {
	CreateTaskInput,
	ManagedWorkRunPreflight,
	Task,
	TaskStatus,
	WorkTaskBinding,
} from "../control/stores/types.ts";

export interface RegisterPrTrackingTaskInput {
	readonly id?: string;
	readonly threadId: string;
	readonly subjectKey: string;
	readonly title: string;
	readonly why: string;
	readonly ownerProfileId?: string | null;
	readonly status?: TaskStatus;
	readonly createdBy: string;
	readonly userId?: string | null;
	readonly sourceMessageId?: string | null;
	readonly relatedFeatureId?: string | null;
	readonly repo?: string | null;
	readonly risk?: string | null;
	readonly riskAxes?: unknown[];
}

export interface RegisterPrTrackingInput {
	readonly task: RegisterPrTrackingTaskInput;
	readonly binding?: { readonly workId: string; readonly attemptId: string } | null;
}

export interface RegisterPrTrackingResult {
	readonly task: Task;
	readonly binding: WorkTaskBinding | null;
	readonly created: boolean;
}

export type ManagedWorkAttribution =
	| { readonly kind: "managed_attributed"; readonly workId: string; readonly attemptId: string }
	| { readonly kind: "managed_unattributed"; readonly reason: string }
	| { readonly kind: "unmanaged_not_applicable"; readonly reason: string };

export interface LifecycleEvidenceInput {
	readonly taskId: string;
	readonly evidenceKind: "merge" | "revert";
	readonly evidenceRef: string;
	readonly actorRef: string;
}

export type StickyRetryDecision =
	| { readonly kind: "unmanaged"; readonly profileId: string; readonly reason: string }
	| { readonly kind: "managed"; readonly profileId: string; readonly workId: string; readonly attemptId: string }
	| {
			readonly kind: "conflict";
			readonly workId: string;
			readonly attemptId: string;
			readonly boundProfileId: string;
			readonly requestedProfileId: string;
	  };

export class ManagedWorkService {
	private readonly store: ControlStore;

	constructor(store: ControlStore) {
		this.store = store;
	}

	registerPrTracking(input: RegisterPrTrackingInput): RegisterPrTrackingResult {
		const subjectKey = input.task.subjectKey.trim();
		if (subjectKey === "") throw new ControlError("invalid_input", "pr_tracking subjectKey is required");
		try {
			return this.store.transaction.run(() => {
				const existing = this.store.tasks.findBySubjectKey("pr_tracking", subjectKey);
				if (existing) return this.reconcileExisting(existing, input.binding);

				const binding = input.binding ?? null;
				const create: CreateTaskInput = {
					id: input.task.id,
					kind: "pr_tracking",
					threadId: input.task.threadId,
					subjectKey,
					title: input.task.title,
					why: input.task.why,
					ownerProfileId: input.task.ownerProfileId ?? null,
					status: input.task.status ?? "todo",
					createdBy: input.task.createdBy,
					userId: input.task.userId ?? null,
					sourceMessageId: input.task.sourceMessageId ?? null,
					relatedFeatureId: input.task.relatedFeatureId ?? null,
					repo: input.task.repo ?? null,
					risk: input.task.risk ?? null,
					riskAxes: input.task.riskAxes ?? [],
				};
				const task = this.store.tasks.create(create);
				let taskBinding: WorkTaskBinding | null = null;
				if (binding) {
					taskBinding = this.store.work.bindTask({
						taskId: task.id,
						workId: binding.workId,
						attemptId: binding.attemptId,
					});
					this.auditBinding("work_binding_created", task.id, taskBinding);
				}
				this.store.audit.append({
					actor: "system:managed-work",
					action: "pr_tracking_registered",
					subject: `task:${task.id}`,
					args: { subjectKey, bound: taskBinding !== null },
				});
				return { task, binding: taskBinding, created: true };
			});
		} catch (error) {
			if (error instanceof ControlError && error.code === "conflict" && input.binding) {
				const existing = this.store.tasks.findBySubjectKey("pr_tracking", subjectKey);
				const existingBinding = existing ? this.store.work.getTaskBinding(existing.id) : null;
				if (existing && existingBinding) {
					try {
						this.store.audit.append({
							actor: "system:managed-work",
							action: "work_binding_conflict",
							subject: `task:${existing.id}`,
							args: {
								existingWorkId: existingBinding.workId,
								existingAttemptId: existingBinding.attemptId,
								requestedWorkId: input.binding.workId,
								requestedAttemptId: input.binding.attemptId,
							},
						});
					} catch {
						// Conflict evidence is best-effort; never let audit failure mask the
						// original conflict error the caller must see.
					}
				}
			}
			throw error;
		}
	}

	attributeTask(taskId: string): ManagedWorkAttribution {
		const task = this.store.tasks.get(taskId);
		if (!task) throw new ControlError("not_found", `task ${taskId} not found`);
		if (task.kind !== "pr_tracking") {
			return { kind: "unmanaged_not_applicable", reason: "not_pr_tracking" };
		}
		const binding = this.store.work.getTaskBinding(task.id);
		if (!binding) {
			this.store.audit.append({
				actor: "system:managed-work",
				action: "work_attribution_unattributed",
				subject: `task:${task.id}`,
				args: { reason: "pr_tracking_binding_missing" },
			});
			return { kind: "managed_unattributed", reason: "pr_tracking_binding_missing" };
		}
		return { kind: "managed_attributed", workId: binding.workId, attemptId: binding.attemptId };
	}

	attributeRun(runId: string): ManagedWorkAttribution {
		const run = this.store.runs.get(runId);
		if (!run) throw new ControlError("not_found", `run ${runId} not found`);
		const binding = this.store.work.getRunBinding(run.id);
		if (binding) {
			return { kind: "managed_attributed", workId: binding.workId, attemptId: binding.attemptId };
		}
		const task = this.store.tasks.get(run.taskId);
		if (!task) throw new ControlError("not_found", `task ${run.taskId} not found`);
		if (task.kind !== "work" || run.role !== "coder" || !task.backlogItemId) {
			return { kind: "unmanaged_not_applicable", reason: "participant_phase_b" };
		}
		const admission = this.store.work.getAdmissionByProducer(task.backlogItemId);
		if (!admission) return { kind: "unmanaged_not_applicable", reason: "no_admission" };
		this.store.audit.append({
			actor: "system:managed-work",
			action: "work_attribution_unattributed",
			subject: `run:${run.id}`,
			args: { reason: "primary_implementer_binding_missing" },
		});
		return { kind: "managed_unattributed", reason: "primary_implementer_binding_missing" };
	}

	recordLifecycleEvidence(input: LifecycleEvidenceInput): ManagedWorkAttribution {
		const attribution = this.attributeTask(input.taskId);
		const args: Record<string, unknown> = {
			evidenceKind: input.evidenceKind,
			evidenceRef: input.evidenceRef,
			attribution: attribution.kind,
		};
		if (attribution.kind === "managed_attributed") {
			args.workId = attribution.workId;
			args.attemptId = attribution.attemptId;
		} else {
			args.reason = attribution.reason;
		}
		this.store.audit.append({
			actor: input.actorRef,
			action: "work_lifecycle_evidence",
			subject: `task:${input.taskId}`,
			args,
		});
		return attribution;
	}

	preflightRun(input: { taskId: string; role: string; profileId: string }): ManagedWorkRunPreflight {
		return this.store.work.preflightRunBinding(input);
	}

	stickyRetryDecision(input: { runId: string; requestedProfileId: string }): StickyRetryDecision {
		const run = this.store.runs.get(input.runId);
		if (!run) throw new ControlError("not_found", `run ${input.runId} not found`);
		const binding = this.store.work.getRunBinding(run.id);
		if (!binding) {
			return { kind: "unmanaged", profileId: input.requestedProfileId, reason: "run_binding_missing" };
		}
		const attempt = this.store.work.getAttempt(binding.attemptId);
		if (!attempt || attempt.workId !== binding.workId) {
			throw new ControlError("invalid_state", `managed work attempt ${binding.attemptId} is partial`);
		}
		if (attempt.executorProfileId === null) {
			return {
				kind: "managed",
				profileId: input.requestedProfileId,
				workId: binding.workId,
				attemptId: binding.attemptId,
			};
		}
		if (attempt.executorProfileId === input.requestedProfileId) {
			return {
				kind: "managed",
				profileId: attempt.executorProfileId,
				workId: binding.workId,
				attemptId: binding.attemptId,
			};
		}
		return {
			kind: "conflict",
			workId: binding.workId,
			attemptId: binding.attemptId,
			boundProfileId: attempt.executorProfileId,
			requestedProfileId: input.requestedProfileId,
		};
	}

	private reconcileExisting(task: Task, inputBinding: RegisterPrTrackingInput["binding"]): RegisterPrTrackingResult {
		const existingBinding = this.store.work.getTaskBinding(task.id);
		if (!inputBinding) return { task, binding: existingBinding, created: false };
		if (existingBinding) {
			if (existingBinding.workId === inputBinding.workId && existingBinding.attemptId === inputBinding.attemptId) {
				return { task, binding: existingBinding, created: false };
			}
			throw new ControlError("conflict", `task ${task.id} is bound to another work attempt`);
		}
		const binding = this.store.work.bindTask({ taskId: task.id, ...inputBinding });
		this.auditBinding("work_binding_created", task.id, binding);
		return { task, binding, created: false };
	}

	private auditBinding(action: string, taskId: string, binding: WorkTaskBinding): void {
		this.store.audit.append({
			actor: "system:managed-work",
			action,
			subject: `task:${taskId}`,
			args: { workId: binding.workId, attemptId: binding.attemptId },
		});
	}
}
