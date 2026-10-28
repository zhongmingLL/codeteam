import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import type { Task } from "../control/stores/types.ts";
import { DeploymentObservationService } from "./observation.ts";
import {
	type DeploymentObservation,
	type DeploymentObserver,
	type DeploymentWaitOutcome,
	type DeploymentWaitPredicate,
	type DeploymentWaitRegisterInput,
	type DeploymentWaitStateV1,
	parseDeploymentWaitState,
	validateDeploymentPredicate,
} from "./types.ts";

export interface DeploymentWaitServiceOptions {
	readonly observer?: DeploymentObserver;
	readonly clock?: () => number;
}

export interface DeploymentWaitSweepResult {
	readonly matched: string[];
	readonly delivered: string[];
	readonly errors: { taskId: string; message: string }[];
}

export class DeploymentWaitService {
	private readonly store: ControlStore;
	private readonly observer: DeploymentObserver;
	private readonly clock: () => number;

	constructor(store: ControlStore, options: DeploymentWaitServiceOptions = {}) {
		this.store = store;
		this.observer =
			options.observer ??
			new DeploymentObservationService({
				dataDir: dirname(store.control.path),
				clock: options.clock,
			});
		this.clock = options.clock ?? Date.now;
	}

	register(input: DeploymentWaitRegisterInput): DeploymentWaitStateV1 {
		const now = this.clock();
		const task = this.store.tasks.get(input.taskId);
		if (!task) throw new ControlError("not_found", `task ${input.taskId} not found`);
		const predicate = validateDeploymentPredicate(input.predicate);
		const targets = [
			...new Set(input.targetProfileIds.filter((target) => typeof target === "string" && target.trim() !== "")),
		];
		if (targets.length === 0 || targets.length !== input.targetProfileIds.length) {
			throw new ControlError("deployment_wait_invalid", "deployment wait targets must be unique non-empty strings");
		}
		const existing = parseDeploymentWaitState(task.deploymentWait);
		if (existing) {
			if (sameWait(existing, predicate, targets)) return existing;
			throw new ControlError("deployment_wait_conflict", `task ${task.id} already has a different deployment wait`);
		}
		const subjectRef = this.observer.subjectRef();
		const observation = this.observer.observe();
		const state: DeploymentWaitStateV1 = {
			v: 1,
			generation: 1,
			subjectRef,
			ownerFence: { kind: "containing_task", taskId: task.id },
			baseline: {
				bootSequence: observation?.bootSequence ?? 0,
				bootId: observation?.bootId ?? null,
				capturedAt: now,
			},
			continuation: {
				when: predicate,
				deliver: { kind: "queue_entry", targetProfileIds: targets },
				autoRenew: false,
			},
			status: "waiting",
			registeredAt: now,
			updatedAt: now,
		};
		const updated = this.store.transaction.run(() => {
			const next = this.store.tasks.setDeploymentWait(task.id, state as unknown as Record<string, unknown>, {
				expectedUpdatedAt: task.updatedAt,
			});
			this.store.audit.append({
				actor: input.actorRef,
				action: "deployment_wait_registered",
				subject: `task:${task.id}`,
				args: { subjectRef, predicate, targets, baseline: state.baseline },
			});
			return next;
		});
		return this.evaluate(task.id, now) ?? parseDeploymentWaitState(updated.deploymentWait)!;
	}

	evaluate(taskId: string, now = this.clock()): DeploymentWaitStateV1 | null {
		const task = this.store.tasks.get(taskId);
		if (!task) throw new ControlError("not_found", `task ${taskId} not found`);
		const state = parseDeploymentWaitState(task.deploymentWait);
		if (!state || state.status !== "waiting") return state;
		const observation = this.observer.observe();
		if (!observation || observation.subjectRef !== state.subjectRef) return state;
		if (!matches(state, observation)) return state;
		const outcome: DeploymentWaitOutcome = {
			outcomeId: `dwo_${randomUUID()}`,
			generation: state.generation,
			subjectRef: state.subjectRef,
			ownerFence: state.ownerFence,
			reason: "predicate_matched",
			at: now,
			delivery: "pending",
			deploymentMatch: observation,
			registeredAt: state.registeredAt,
		};
		const next: DeploymentWaitStateV1 = { ...state, status: "matched", outcome, updatedAt: now };
		this.store.tasks.setDeploymentWait(task.id, next as unknown as Record<string, unknown>, {
			expectedUpdatedAt: task.updatedAt,
		});
		this.store.audit.append({
			actor: "system:deployment-wait",
			action: "deployment_wait_matched",
			subject: `task:${task.id}`,
			args: { outcomeId: outcome.outcomeId, bootSequence: observation.bootSequence, bootId: observation.bootId },
		});
		return next;
	}

	deliver(taskId: string, now = this.clock()): DeploymentWaitStateV1 | null {
		return this.store.transaction.run(() => {
			const task = this.store.tasks.get(taskId);
			if (!task) throw new ControlError("not_found", `task ${taskId} not found`);
			const state = parseDeploymentWaitState(task.deploymentWait);
			if (!state || state.status !== "matched" || !state.outcome) return state;
			if (state.outcome.delivery === "delivered") return state;
			const message = this.store.messages.append({
				threadId: task.threadId,
				taskId: task.id,
				authorKind: "system",
				authorId: "system:deployment-wait",
				kind: "status",
				bodyMd: `Deployment wait matched for ${state.subjectRef} at boot ${state.outcome.deploymentMatch?.bootSequence ?? "unknown"}.`,
			});
			const queueEntry = this.store.queue.admit({
				threadId: task.threadId,
				sourceId: message.id,
				sourceRecordId: task.id,
				sourceKind: "message_wake",
				targets: [...state.continuation.deliver.targetProfileIds],
				authorIntent: Object.fromEntries(
					state.continuation.deliver.targetProfileIds.map((target) => [
						target,
						{ intent: "next_work", deploymentWaitTaskId: task.id },
					]),
				),
				priority: "normal",
				sourceCategory: "deployment_wait",
				orderKey: state.outcome.outcomeId,
			});
			const outcome: DeploymentWaitOutcome = {
				...state.outcome,
				delivery: "delivered",
				queueEntryId: queueEntry.id,
				sourceMessageId: message.id,
			};
			const next: DeploymentWaitStateV1 = { ...state, outcome, updatedAt: now };
			this.store.tasks.setDeploymentWait(task.id, next as unknown as Record<string, unknown>, {
				expectedUpdatedAt: task.updatedAt,
			});
			this.store.audit.append({
				actor: "system:deployment-wait",
				action: "deployment_wait_delivered",
				subject: `task:${task.id}`,
				args: { outcomeId: outcome.outcomeId, queueEntryId: queueEntry.id, sourceMessageId: message.id },
			});
			return next;
		});
	}

	sweep(now = this.clock()): DeploymentWaitSweepResult {
		const matched: string[] = [];
		const delivered: string[] = [];
		const errors: { taskId: string; message: string }[] = [];
		for (const task of this.store.tasks.listWithDeploymentWait()) {
			try {
				const state = this.evaluate(task.id, now);
				if (!state) continue;
				if (state.status === "matched") {
					matched.push(task.id);
					if (state.outcome?.delivery === "pending") {
						this.deliver(task.id, now);
						delivered.push(task.id);
					}
				}
			} catch (error) {
				errors.push({ taskId: task.id, message: error instanceof Error ? error.message : String(error) });
			}
		}
		return { matched, delivered, errors };
	}

	assertCanStart(taskId: string): void {
		const task = this.store.tasks.get(taskId);
		if (!task) throw new ControlError("not_found", `task ${taskId} not found`);
		const state = parseDeploymentWaitState(task.deploymentWait);
		if (!state) return;
		if (state.status === "waiting") {
			throw new ControlError("deployment_wait_pending", `deployment wait is still pending for task ${taskId}`);
		}
		if (state.status === "matched" && state.outcome?.delivery === "pending") {
			throw new ControlError(
				"deployment_wait_outcome_pending",
				`deployment wait outcome is not delivered for task ${taskId}`,
			);
		}
	}

	projection(taskId: string): { task: Task; state: DeploymentWaitStateV1 | null } {
		const task = this.store.tasks.get(taskId);
		if (!task) throw new ControlError("not_found", `task ${taskId} not found`);
		return { task, state: parseDeploymentWaitState(task.deploymentWait) };
	}
}

function sameWait(
	state: DeploymentWaitStateV1,
	predicate: DeploymentWaitPredicate,
	targets: readonly string[],
): boolean {
	const currentTargets = state.continuation.deliver.targetProfileIds;
	return (
		JSON.stringify(state.continuation.when) === JSON.stringify(predicate) &&
		currentTargets.length === targets.length &&
		currentTargets.every((target, index) => target === targets[index])
	);
}

function matches(state: DeploymentWaitStateV1, observation: DeploymentObservation): boolean {
	const ready = new Set(observation.readyServices);
	if (!state.continuation.when.services.every((service) => ready.has(service))) return false;
	if (state.continuation.when.kind === "revision_included") {
		return observation.runningRevision !== null && observation.runningRevision === state.continuation.when.revision;
	}
	return observation.bootSequence > state.baseline.bootSequence;
}
