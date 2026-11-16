import type { ControlStore } from "../control/store.ts";
import type { Run } from "../control/stores/types.ts";

export const DEFAULT_WORKER_MAX_ATTEMPTS = 3;

const RETRYABLE_REASONS = new Set([
	"worker_crashed",
	"worker_start_failed",
	"worker_timeout",
	"worker_protocol_error",
	"worker_aborted",
	"worker_liveness_lost",
	"worker_stale",
	"drain_timeout",
	"worker_capacity",
	"daemon_restarted",
	"model_error",
]);

export interface WorkerFailurePolicyOptions {
	readonly store: ControlStore;
	readonly maxAttempts?: number;
	readonly clock?: () => number;
}

export interface WorkerFailureDisposition {
	readonly kind: "none" | "retry_queued" | "dead_lettered" | "already_handled";
	readonly attempt?: number;
	readonly queueEntryId?: string;
}

export class WorkerFailurePolicy {
	readonly store: ControlStore;
	readonly maxAttempts: number;
	private readonly clock: () => number;

	constructor(options: WorkerFailurePolicyOptions) {
		this.store = options.store;
		this.maxAttempts = options.maxAttempts ?? DEFAULT_WORKER_MAX_ATTEMPTS;
		if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1) {
			throw new Error("maxAttempts must be a positive integer");
		}
		this.clock = options.clock ?? Date.now;
	}

	onRunTerminal(run: Run, reason?: string): WorkerFailureDisposition {
		if (run.status === "completed" || run.status === "canceled") return { kind: "none" };
		const terminalReason = reason ?? terminalReasonOf(this.store, run.id) ?? run.status;
		if (run.status === "failed" && !RETRYABLE_REASONS.has(terminalReason)) return { kind: "none" };
		if (
			run.status === "interrupted" &&
			!RETRYABLE_REASONS.has(terminalReason) &&
			terminalReason !== "startup_recovery"
		) {
			return { kind: "none" };
		}
		return this.handleRetryable(run, terminalReason);
	}

	onInterrupted(run: Run, reason: string): WorkerFailureDisposition {
		if (run.status !== "interrupted") return { kind: "none" };
		return this.handleRetryable(run, reason);
	}

	private handleRetryable(run: Run, reason: string): WorkerFailureDisposition {
		const subject = `run:${run.id}`;
		if (
			this.store.audit.latest(subject, "run_retry_queued") ||
			this.store.audit.latest(subject, "run_dead_lettered")
		) {
			return { kind: "already_handled" };
		}
		if (run.attempt >= this.maxAttempts) return this.deadLetter(run, reason);
		return this.queueRetry(run, reason);
	}

	private queueRetry(run: Run, reason: string): WorkerFailureDisposition {
		const task = this.store.tasks.get(run.taskId);
		if (!task) return { kind: "none" };
		const attempt = run.attempt + 1;
		return this.store.transaction.run(() => {
			const source = this.store.messages.append({
				threadId: task.threadId,
				taskId: task.id,
				authorKind: "system",
				authorId: "system:worker",
				kind: "status",
				bodyMd: `Run ${run.id} ended ${run.status} (${reason}). Retry ${attempt}/${this.maxAttempts} queued.`,
			});
			const entry = this.store.queue.admit({
				threadId: task.threadId,
				sourceId: source.id,
				sourceRecordId: run.id,
				sourceKind: "message_wake",
				targets: [run.recipientProfileId],
				authorIntent: {
					[run.recipientProfileId]: {
						intent: "next_work",
						chainMetadata: { ...run.chainMetadata, retryOf: run.id, attempt },
					},
				},
				priority: "normal",
				sourceCategory: "worker_retry",
				orderKey: `${run.startedAt}:${source.seq}`,
			});
			this.store.audit.append({
				actor: "system:worker",
				action: "run_retry_queued",
				subject: `run:${run.id}`,
				args: { reason, attempt, queueEntryId: entry.id, sourceMessageId: source.id, at: this.clock() },
			});
			return { kind: "retry_queued" as const, attempt, queueEntryId: entry.id };
		});
	}

	private deadLetter(run: Run, reason: string): WorkerFailureDisposition {
		const task = this.store.tasks.get(run.taskId);
		if (!task) return { kind: "none" };
		return this.store.transaction.run(() => {
			const source = this.store.messages.append({
				threadId: task.threadId,
				taskId: task.id,
				authorKind: "system",
				authorId: "system:worker",
				kind: "status",
				bodyMd: `Run ${run.id} exhausted ${this.maxAttempts} attempts (${reason}). Human escalation is pending in the inbox.`,
			});
			const inbox = this.store.inbox.create({
				taskId: task.id,
				runId: run.id,
				kind: "humanGuidance",
				payload: { kind: "dead_letter", reason, attempts: run.attempt, sourceMessageId: source.id },
			});
			this.store.audit.append({
				actor: "system:worker",
				action: "run_dead_lettered",
				subject: `run:${run.id}`,
				args: { reason, attempts: run.attempt, inboxId: inbox.id, at: this.clock() },
			});
			return { kind: "dead_lettered" as const, attempt: run.attempt };
		});
	}
}

function terminalReasonOf(store: ControlStore, runId: string): string | null {
	const events = store.runs.listEvents(runId, 500);
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index]!;
		if (event.kind !== "message") continue;
		const payload = event.payload;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
		const record = payload as { phase?: unknown; reason?: unknown };
		if (record.phase === "terminal" && typeof record.reason === "string") return record.reason;
	}
	return null;
}
