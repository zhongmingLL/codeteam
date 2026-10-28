import { observeMissingA2AToolCall } from "../a2a/observation.ts";
import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import { newId } from "../control/stores/helpers.ts";
import type { ManagedWorkRunPreflight, Run } from "../control/stores/types.ts";
import type { ManagedWorkService } from "../managed-work/service.ts";
import type { BudgetService } from "../scheduling/budget.ts";
import { routeParallel } from "./route.ts";
import { settleRunTerminal } from "./settle.ts";
import type {
	AgentExecutor,
	DispatchDrainOptions,
	DispatchDrainResult,
	DispatchEntryError,
	DispatchRoute,
	DispatchRunOutcome,
	DispatchServiceHooks,
	DispatchSettleInput,
	GuideRunInput,
	InterruptRunResult,
} from "./types.ts";
import { InterruptedExecutionError, RetryableExecutionError } from "./types.ts";

const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_QUEUE_CLAIM_TTL_MS = 5 * 60 * 1000;
const MAX_DEFERRED_ENTRIES = 500;
const TERMINAL_STATUSES = new Set(["completed", "canceled", "interrupted", "failed"]);
const POISON_DISPATCH_ERRORS = new Set([
	"invalid_state",
	"not_found",
	"invalid_input",
	"forbidden",
	"schema_incomplete",
]);
// Admission gates that only affect one task. Defer the entry and keep draining so a
// budget-paused or deployment-waiting head entry cannot starve every entry behind it.
const DEFERRABLE_DISPATCH_ERRORS = new Set(["budget_paused", "deployment_wait_pending"]);

export interface DispatchServiceOptions {
	readonly budget?: BudgetService;
	readonly managedWork?: ManagedWorkService;
	readonly deploymentWaitGuard?: { assertCanStart(taskId: string): void };
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function chainMetadataFor(entryIntent: unknown, fallback: Record<string, unknown>): Record<string, unknown> {
	const intent = objectOrEmpty(entryIntent);
	const nested = objectOrEmpty(intent.chainMetadata);
	return { ...fallback, ...nested };
}

function positiveAttempt(value: unknown): number {
	const attempt = typeof value === "number" ? value : Number(value);
	return Number.isSafeInteger(attempt) && attempt >= 1 ? attempt : 1;
}

export class DispatchService {
	readonly store: ControlStore;
	readonly executor: AgentExecutor;
	private readonly budget: BudgetService | undefined;
	private readonly managedWork: ManagedWorkService | undefined;
	private readonly deploymentWaitGuard: { assertCanStart(taskId: string): void } | undefined;
	private readonly clock: () => number;
	private readonly hooks: DispatchServiceHooks;
	private readonly controllers = new Map<string, AbortController>();
	private draining: Promise<DispatchDrainResult> | null = null;
	private dirty = false;

	constructor(
		store: ControlStore,
		executor: AgentExecutor,
		clock: () => number = Date.now,
		hooks: DispatchServiceHooks = {},
		options: DispatchServiceOptions = {},
	) {
		this.store = store;
		this.executor = executor;
		this.clock = clock;
		this.hooks = hooks;
		this.budget = options.budget;
		this.managedWork = options.managedWork;
		this.deploymentWaitGuard = options.deploymentWaitGuard;
	}

	requestDrain(): void {
		this.dirty = true;
	}

	pendingWake(): number {
		return this.store.queue.pendingCount();
	}

	resolveRoute(taskId: string, targetProfileId: string, chainMetadata: Record<string, unknown> = {}): DispatchRoute {
		const task = this.store.tasks.get(taskId);
		if (!task) throw new ControlError("not_found", `task ${taskId} not found`);
		const profile = this.store.profiles.get(targetProfileId);
		if (!profile) throw new ControlError("not_found", `agent profile ${targetProfileId} not found`);
		if (profile.status !== "active") {
			throw new ControlError("invalid_state", `agent profile ${targetProfileId} is disabled`);
		}
		const sessions = this.store.sessions.list({ taskId, profileId: targetProfileId, status: "active" });
		if (sessions.length === 0) {
			throw new ControlError("invalid_state", `target ${targetProfileId} has no active session for task ${taskId}`);
		}
		if (sessions.length > 1) {
			throw new ControlError("invalid_state", `target ${targetProfileId} has ambiguous active sessions`);
		}
		const session = sessions[0]!;
		if (session.threadId !== task.threadId) {
			throw new ControlError("invalid_state", `target ${targetProfileId} session is not bound to the task thread`);
		}
		return {
			targetProfileId,
			taskId,
			role: session.role,
			agentSessionId: session.id,
			provider: session.provider,
			model: session.model,
			modelFamily: session.modelFamily,
			l0Revision: null,
			attempt: positiveAttempt(chainMetadata.attempt),
			chainMetadata,
		};
	}

	async drain(options: DispatchDrainOptions = {}): Promise<DispatchDrainResult> {
		if (this.draining) {
			this.dirty = true;
			return this.draining;
		}
		this.draining = this.drainLoop(options);
		try {
			return await this.draining;
		} finally {
			this.draining = null;
		}
	}

	async stopRun(runId: string, actorRef: string, reason = "operator_stop"): Promise<Run> {
		const run = this.store.runs.get(runId);
		if (!run) throw new ControlError("not_found", `run ${runId} not found`);
		this.controllers.get(runId)?.abort();
		return this.settleRun(runId, { status: "canceled", reason, actorRef });
	}

	async interruptRun(runId: string, actorRef: string, reason = "operator_interrupt"): Promise<InterruptRunResult> {
		const run = this.store.runs.get(runId);
		if (!run) throw new ControlError("not_found", `run ${runId} not found`);
		if (run.status !== "running") {
			throw new ControlError("invalid_state", `run ${runId} is ${run.status}`);
		}
		this.controllers.get(runId)?.abort();
		const canceledRun = await this.settleRun(runId, { status: "canceled", reason, actorRef });
		const source = this.store.messages.append({
			threadId: this.store.tasks.get(run.taskId)!.threadId,
			taskId: run.taskId,
			authorKind: "system",
			authorId: actorRef,
			kind: "status",
			bodyMd: `Interrupt requested for run ${run.id}; a retry was queued.`,
		});
		const queueEntry = this.store.queue.admit({
			threadId: source.threadId,
			sourceId: source.id,
			sourceRecordId: run.id,
			sourceKind: "message_wake",
			targets: [run.recipientProfileId],
			authorIntent: {
				[run.recipientProfileId]: { intent: "next_work", chainMetadata: run.chainMetadata },
			},
			priority: "urgent",
			sourceCategory: "interrupt_retry",
			orderKey: `${run.startedAt}:${source.seq}`,
		});
		this.requestDrain();
		return { canceledRun, retryQueueEntryId: queueEntry.id };
	}

	guideRun(input: GuideRunInput) {
		const run = this.store.runs.get(input.runId);
		if (!run) throw new ControlError("not_found", `run ${input.runId} not found`);
		if (run.status !== "running") {
			throw new ControlError("invalid_state", `run ${input.runId} is ${run.status}`);
		}
		const inbox = this.store.inbox.create({
			taskId: run.taskId,
			runId: run.id,
			kind: input.kind,
			payload: input.payload,
		});
		this.store.runs.appendEvent(run.id, "message", {
			phase: "guide",
			inboxId: inbox.id,
			guideKind: input.kind,
		});
		this.store.audit.append({
			actor: input.actorRef,
			action: "run_guided",
			subject: `run:${run.id}`,
			args: { inboxId: inbox.id, kind: input.kind },
		});
		return inbox;
	}

	cancelQueued(queueEntryId: string, actorRef: string, targetProfileId?: string, reason = "operator_cancel") {
		return this.store.queue.withdrawTarget(queueEntryId, { targetProfileId, actorRef, reason });
	}

	settleRun(runId: string, input: DispatchSettleInput): Run {
		const existing = this.store.runs.get(runId);
		if (!existing) throw new ControlError("not_found", `run ${runId} not found`);
		if (TERMINAL_STATUSES.has(existing.status)) {
			this.chargeBudget(existing);
			return existing;
		}
		const result = settleRunTerminal(this.store, runId, input, this.clock);
		if (result.changed) this.hooks.onRunTerminal?.(result.run, input);
		this.chargeBudget(result.run);
		return result.run;
	}

	private chargeBudget(run: Run): void {
		if (!this.budget) return;
		try {
			this.budget.chargeRun(run.id);
		} catch (error) {
			try {
				this.store.audit.append({
					actor: "system:dispatch",
					action: "budget_charge_failed",
					subject: `run:${run.id}`,
					args: { message: error instanceof Error ? error.message : String(error) },
				});
			} catch {
				// Budget accounting failure must not overwrite a committed run terminal.
			}
		}
	}

	private async drainLoop(options: DispatchDrainOptions): Promise<DispatchDrainResult> {
		const maxEntries = Math.min(Math.max(options.maxEntries ?? DEFAULT_MAX_ENTRIES, 1), 500);
		const claimTtlMs = options.claimTtlMs ?? DEFAULT_QUEUE_CLAIM_TTL_MS;
		const claimedQueueEntryIds: string[] = [];
		const runs: Run[] = [];
		const outcomes: DispatchRunOutcome[] = [];
		const errors: DispatchEntryError[] = [];
		const deferredIds = new Set<string>();
		let processed = 0;

		do {
			this.dirty = false;
			while (processed < maxEntries) {
				if (deferredIds.size >= MAX_DEFERRED_ENTRIES) break;
				const claimId = `dispatch:${newId()}`;
				const entry = this.store.queue.claimNext({ claimId, ttlMs: claimTtlMs, excludeIds: [...deferredIds] });
				if (!entry) break;
				claimedQueueEntryIds.push(entry.id);
				try {
					const cutover = this.cutoverEntry(entry.id, claimId);
					runs.push(...cutover.runs);
					errors.push(...cutover.failures);
					if (cutover.runs.length > 0) {
						const settled = await routeParallel(cutover.runs, (run) => this.executeRun(run));
						for (const result of settled) {
							if (result.status === "fulfilled") outcomes.push(result.value);
							else {
								const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
								errors.push({ queueEntryId: entry.id, code: "executor_error", message });
							}
						}
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					const code = error instanceof ControlError ? error.code : "dispatch_error";
					errors.push({ queueEntryId: entry.id, code, message });
					if (POISON_DISPATCH_ERRORS.has(code)) {
						this.deadLetterEntry(entry.id, claimId, code, message);
					} else if (DEFERRABLE_DISPATCH_ERRORS.has(code)) {
						const current = this.store.queue.get(entry.id);
						if (current?.status === "claimed" && current.claimId) {
							this.store.queue.release(entry.id, current.claimId);
						}
						this.store.audit.append({
							actor: "system:dispatch",
							action: "dispatch_deferred",
							subject: `queue:${entry.id}`,
							args: { code, message },
						});
						deferredIds.add(entry.id);
						continue;
					} else {
						const current = this.store.queue.get(entry.id);
						if (current?.status === "claimed" && current.claimId) {
							this.store.queue.release(entry.id, current.claimId);
						}
						this.store.audit.append({
							actor: "system:dispatch",
							action: "dispatch_deferred",
							subject: `queue:${entry.id}`,
							args: { code, message },
						});
						break;
					}
				}
				processed += 1;
			}
		} while (this.dirty && processed < maxEntries);

		return { claimedQueueEntryIds, runs, outcomes, errors };
	}

	private cutoverEntry(queueEntryId: string, claimId: string): { runs: Run[]; failures: DispatchEntryError[] } {
		const entry = this.store.queue.get(queueEntryId);
		if (!entry) throw new ControlError("not_found", `queue entry ${queueEntryId} not found`);
		const source = this.store.messages.get(entry.sourceId);
		if (!source) throw new ControlError("not_found", `queue source message ${entry.sourceId} not found`);
		if (!source.taskId) {
			throw new ControlError("invalid_state", `queue source message ${source.id} has no task`);
		}
		this.assertBudgetAdmission(source.taskId);
		this.deploymentWaitGuard?.assertCanStart(source.taskId);
		const targets = [...entry.targets];
		return this.store.transaction.run(() => {
			let activeClaimId = claimId;
			const runs: Run[] = [];
			const failures: DispatchEntryError[] = [];
			for (const target of targets) {
				const current = this.store.queue.get(entry.id);
				if (!current || current.status === "withdrawn") break;
				if (current.status === "queued") {
					activeClaimId = `dispatch:${newId()}`;
					this.store.queue.claim(entry.id, { claimId: activeClaimId, ttlMs: DEFAULT_QUEUE_CLAIM_TTL_MS });
				} else if (current.status === "claimed" && current.claimId) {
					activeClaimId = current.claimId;
				} else {
					throw new ControlError("invalid_state", `queue entry ${entry.id} is ${current.status} during cutover`);
				}
				let route: DispatchRoute;
				try {
					route = this.resolveRoute(
						source.taskId!,
						target,
						chainMetadataFor(entry.authorIntent[target], {
							sourceKind: entry.sourceKind,
							queueEntryId: entry.id,
						}),
					);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					const code = error instanceof ControlError ? error.code : "dispatch_route_error";
					failures.push({ queueEntryId: entry.id, targetProfileId: target, code, message });
					this.store.queue.withdrawTarget(entry.id, {
						targetProfileId: target,
						actorRef: "system:dispatch",
						reason: `dispatch_route_${code}`,
						expectedClaimId: activeClaimId,
					});
					continue;
				}
				const managed = this.managedWork?.preflightRun({
					taskId: source.taskId!,
					role: route.role,
					profileId: route.targetProfileId,
				});
				if (managed?.kind === "conflict") {
					this.consumeManagedConflict({
						queueEntryId: entry.id,
						claimId: activeClaimId,
						targetProfileId: route.targetProfileId,
						taskId: source.taskId!,
						preflight: managed,
					});
					failures.push({
						queueEntryId: entry.id,
						targetProfileId: route.targetProfileId,
						code: "managed_work_executor_conflict",
						message: `managed work conflict: ${managed.reason}`,
					});
					continue;
				}
				const result = this.store.cutoverQueueEntry({
					queueEntryId: entry.id,
					claimId: activeClaimId,
					targetProfileId: route.targetProfileId,
					taskId: route.taskId,
					role: route.role,
					agentSessionId: route.agentSessionId,
					provider: route.provider,
					model: route.model,
					modelFamily: route.modelFamily,
					l0Revision: route.l0Revision,
					attempt: route.attempt,
					responseBody: "",
					chainMetadata: route.chainMetadata,
				});
				runs.push(result.run);
			}
			return { runs, failures };
		});
	}

	private assertBudgetAdmission(taskId: string): void {
		if (!this.budget) return;
		const status = this.budget.status(taskId);
		if (status.paused) {
			throw new ControlError(
				"budget_paused",
				`budget for task ${taskId} is paused: ${status.limitsHit.join(", ") || "operator approval open"}`,
			);
		}
	}

	private consumeManagedConflict(input: {
		queueEntryId: string;
		claimId: string;
		targetProfileId: string;
		taskId: string;
		preflight: Extract<ManagedWorkRunPreflight, { kind: "conflict" }>;
	}): void {
		this.store.queue.withdrawTarget(input.queueEntryId, {
			targetProfileId: input.targetProfileId,
			actorRef: "system:dispatch",
			reason: `managed_work_${input.preflight.reason}`,
			expectedClaimId: input.claimId,
		});
		const inbox = this.store.inbox.create({
			taskId: input.taskId,
			kind: "humanGuidance",
			payload: {
				kind: "managed_work_binding_conflict",
				workId: input.preflight.workId,
				attemptId: input.preflight.attemptId,
				boundProfileId: input.preflight.executorProfileId,
				requestedProfileId: input.preflight.requestedProfileId,
				reason: input.preflight.reason,
			},
		});
		this.store.audit.append({
			actor: "system:dispatch",
			action: "work_binding_conflict",
			subject: `task:${input.taskId}`,
			args: {
				workId: input.preflight.workId,
				attemptId: input.preflight.attemptId,
				boundProfileId: input.preflight.executorProfileId,
				requestedProfileId: input.preflight.requestedProfileId,
				reason: input.preflight.reason,
				queueEntryId: input.queueEntryId,
				inboxId: inbox.id,
			},
		});
	}

	private deadLetterEntry(queueEntryId: string, claimId: string, code: string, message: string): void {
		const current = this.store.queue.get(queueEntryId);
		if (current && current.status !== "withdrawn") {
			try {
				this.store.queue.withdrawTarget(queueEntryId, {
					actorRef: "system:dispatch",
					reason: `dispatch_poison_${code}`,
					expectedClaimId: current.status === "claimed" ? (current.claimId ?? claimId) : undefined,
				});
			} catch {
				if (current.status === "claimed" && current.claimId) {
					this.store.queue.release(queueEntryId, current.claimId);
				}
			}
		}
		this.store.audit.append({
			actor: "system:dispatch",
			action: "dispatch_dead_lettered",
			subject: `queue:${queueEntryId}`,
			args: { code, message },
		});
	}

	private async executeRun(run: Run): Promise<DispatchRunOutcome> {
		const task = this.store.tasks.get(run.taskId);
		const session = this.store.sessions.get(run.agentSessionId);
		const target = this.store.profiles.get(run.recipientProfileId);
		const sourceMessage = this.store.messages.get(run.sourceId);
		const responseMessage = run.responseMessageId ? this.store.messages.get(run.responseMessageId) : null;
		if (!task || !session || !target || !sourceMessage || !responseMessage) {
			const failed = this.settleRun(run.id, {
				status: "failed",
				bodyMd: `Dispatch context missing for run ${run.id}.`,
				reason: "dispatch_context_missing",
				actorRef: "system:dispatch",
			});
			return {
				runId: run.id,
				targetProfileId: run.recipientProfileId,
				status: "failed",
				responseMessageId: failed.responseMessageId,
				error: "dispatch_context_missing",
			};
		}
		const controller = new AbortController();
		this.controllers.set(run.id, controller);
		try {
			const result = await this.executor.execute(
				{
					run,
					task,
					session,
					target,
					sourceMessage,
					responseMessage,
					route: this.resolveRoute(run.taskId, run.recipientProfileId, run.chainMetadata),
				},
				controller.signal,
			);
			if (controller.signal.aborted) {
				const settled = this.settleRun(run.id, {
					status: "canceled",
					reason: "aborted",
					actorRef: "system:dispatch",
				});
				return {
					runId: settled.id,
					targetProfileId: settled.recipientProfileId,
					status: settled.status as DispatchRunOutcome["status"],
					responseMessageId: settled.responseMessageId,
				};
			}
			let schemaCorrection: string | undefined;
			try {
				schemaCorrection = observeMissingA2AToolCall(this.store, {
					runId: run.id,
					bodyMd: result.bodyMd,
					toolCalls: result.toolCalls ?? [],
				})?.correction;
			} catch (error) {
				schemaCorrection = undefined;
				try {
					this.store.audit.append({
						actor: "system:dispatch",
						action: "a2a_observation_failed",
						subject: `run:${run.id}`,
						args: { message: error instanceof Error ? error.message : String(error) },
					});
				} catch {
					// Observation is best-effort and must not change run terminal state.
				}
			}
			const settled = this.settleRun(run.id, {
				status: "completed",
				bodyMd: result.bodyMd,
				usage: result.usage ?? null,
				actorRef: "system:dispatch",
			});
			return {
				runId: settled.id,
				targetProfileId: settled.recipientProfileId,
				status: settled.status as DispatchRunOutcome["status"],
				responseMessageId: settled.responseMessageId,
				schemaCorrection,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const interrupted = error instanceof InterruptedExecutionError;
			const retryable = error instanceof RetryableExecutionError;
			const terminalStatus: "canceled" | "interrupted" | "failed" = controller.signal.aborted
				? "canceled"
				: interrupted
					? "interrupted"
					: "failed";
			const settled = this.settleRun(run.id, {
				status: terminalStatus,
				bodyMd: `Execution ${terminalStatus}: ${message}`,
				reason: controller.signal.aborted ? "aborted" : interrupted || retryable ? error.code : "executor_failed",
				actorRef: "system:dispatch",
			});
			return {
				runId: settled.id,
				targetProfileId: settled.recipientProfileId,
				status: settled.status as DispatchRunOutcome["status"],
				responseMessageId: settled.responseMessageId,
				error: message,
			};
		} finally {
			this.controllers.delete(run.id);
		}
	}
}
