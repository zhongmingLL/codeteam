import { observeMissingA2AToolCall } from "../a2a/observation.ts";
import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import { newId } from "../control/stores/helpers.ts";
import type { Run } from "../control/stores/types.ts";
import { routeParallel } from "./route.ts";
import type {
	AgentExecutor,
	DispatchDrainOptions,
	DispatchDrainResult,
	DispatchEntryError,
	DispatchRoute,
	DispatchRunOutcome,
	DispatchSettleInput,
	GuideRunInput,
	InterruptRunResult,
} from "./types.ts";

const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_QUEUE_CLAIM_TTL_MS = 5 * 60 * 1000;
const TERMINAL_STATUSES = new Set(["completed", "canceled", "interrupted", "failed"]);

function objectOrEmpty(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function chainMetadataFor(entryIntent: unknown, fallback: Record<string, unknown>): Record<string, unknown> {
	const intent = objectOrEmpty(entryIntent);
	const nested = objectOrEmpty(intent.chainMetadata);
	return { ...fallback, ...nested };
}

function isTerminal(run: Run): boolean {
	return TERMINAL_STATUSES.has(run.status);
}

export class DispatchService {
	readonly store: ControlStore;
	readonly executor: AgentExecutor;
	private readonly clock: () => number;
	private readonly controllers = new Map<string, AbortController>();
	private draining: Promise<DispatchDrainResult> | null = null;
	private dirty = false;

	constructor(store: ControlStore, executor: AgentExecutor, clock: () => number = Date.now) {
		this.store = store;
		this.executor = executor;
		this.clock = clock;
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
		return this.store.transaction.run(() => {
			const current = this.store.runs.get(runId);
			if (!current) throw new ControlError("not_found", `run ${runId} not found`);
			if (isTerminal(current)) return current;
			if (current.status !== "running") {
				throw new ControlError("invalid_state", `run ${runId} is ${current.status}`);
			}
			if (current.responseMessageId) {
				const finalBody =
					input.bodyMd ??
					(input.status === "completed"
						? ""
						: `Execution ${input.status}${input.reason ? `: ${input.reason}` : ""}`);
				this.store.messages.setBody(current.responseMessageId, finalBody);
			}
			this.store.runs.terminal(current.id, {
				status: input.status,
				usage: input.usage ?? null,
			});
			this.store.runs.appendEvent(current.id, "message", {
				phase: "terminal",
				status: input.status,
				reason: input.reason ?? null,
				responseMessageId: current.responseMessageId,
			});
			if (current.responseMessageId) {
				this.store.messages.settleDispatchRef(current.sourceId, {
					targetId: current.recipientProfileId,
					statusMessageId: current.responseMessageId,
					patch: {
						status: input.status,
						reason: input.reason ?? null,
						settledAt: this.clock(),
					},
				});
			}
			this.store.audit.append({
				actor: input.actorRef ?? "system:dispatch",
				action: "run_terminal",
				subject: `run:${current.id}`,
				args: { status: input.status, reason: input.reason ?? null },
			});
			if (input.status !== "completed") {
				for (const claim of this.store.handoffs.listActiveClaimsByRun(current.id)) {
					this.store.handoffs.releaseClaim(claim.handoffId, claim.profileId, input.reason ?? input.status);
				}
			}
			return this.store.runs.get(current.id)!;
		});
	}

	private async drainLoop(options: DispatchDrainOptions): Promise<DispatchDrainResult> {
		const maxEntries = Math.min(Math.max(options.maxEntries ?? DEFAULT_MAX_ENTRIES, 1), 500);
		const claimTtlMs = options.claimTtlMs ?? DEFAULT_QUEUE_CLAIM_TTL_MS;
		const claimedQueueEntryIds: string[] = [];
		const runs: Run[] = [];
		const outcomes: DispatchRunOutcome[] = [];
		const errors: DispatchEntryError[] = [];
		let processed = 0;

		do {
			this.dirty = false;
			while (processed < maxEntries) {
				const claimId = `dispatch:${newId()}`;
				const entry = this.store.queue.claimNext({ claimId, ttlMs: claimTtlMs });
				if (!entry) break;
				claimedQueueEntryIds.push(entry.id);
				try {
					const created = this.cutoverEntry(entry.id, claimId);
					runs.push(...created);
					const settled = await routeParallel(created, (run) => this.executeRun(run));
					for (const result of settled) {
						if (result.status === "fulfilled") outcomes.push(result.value);
						else {
							const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
							errors.push({ queueEntryId: entry.id, code: "executor_error", message });
						}
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					errors.push({
						queueEntryId: entry.id,
						code: error instanceof ControlError ? error.code : "dispatch_error",
						message,
					});
					const current = this.store.queue.get(entry.id);
					if (current?.status === "claimed" && current.claimId) {
						this.store.queue.release(entry.id, current.claimId);
					}
				}
				processed += 1;
			}
		} while (this.dirty && processed < maxEntries);

		return { claimedQueueEntryIds, runs, outcomes, errors };
	}

	private cutoverEntry(queueEntryId: string, claimId: string): Run[] {
		const entry = this.store.queue.get(queueEntryId);
		if (!entry) throw new ControlError("not_found", `queue entry ${queueEntryId} not found`);
		const source = this.store.messages.get(entry.sourceId);
		if (!source) throw new ControlError("not_found", `queue source message ${entry.sourceId} not found`);
		if (!source.taskId) {
			throw new ControlError("invalid_state", `queue source message ${source.id} has no task`);
		}
		const routes = entry.targets.map((target) =>
			this.resolveRoute(
				source.taskId!,
				target,
				chainMetadataFor(entry.authorIntent[target], {
					sourceKind: entry.sourceKind,
					queueEntryId: entry.id,
				}),
			),
		);
		return this.store.transaction.run(() => {
			let activeClaimId = claimId;
			return routes.map((route) => {
				const current = this.store.queue.get(entry.id);
				if (!current) {
					throw new ControlError("claim_conflict", `queue entry ${entry.id} disappeared during cutover`);
				}
				if (current.status === "queued") {
					activeClaimId = `dispatch:${newId()}`;
					this.store.queue.claim(entry.id, { claimId: activeClaimId, ttlMs: DEFAULT_QUEUE_CLAIM_TTL_MS });
				} else if (current.status === "claimed" && current.claimId) {
					activeClaimId = current.claimId;
				} else {
					throw new ControlError("invalid_state", `queue entry ${entry.id} is ${current.status} during cutover`);
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
					responseBody: "",
					chainMetadata: route.chainMetadata,
				});
				return result.run;
			});
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
			} catch {
				schemaCorrection = undefined;
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
			const settled = this.settleRun(run.id, {
				status: controller.signal.aborted ? "canceled" : "failed",
				bodyMd: `Execution ${controller.signal.aborted ? "canceled" : "failed"}: ${message}`,
				reason: controller.signal.aborted ? "aborted" : "executor_failed",
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
