import type { ControlStore } from "./store.ts";
import type {
	Approval,
	Artifact,
	Merge,
	Message,
	Review,
	Task,
	Thread,
	ThreadEvent,
	ThreadStatus,
} from "./stores/types.ts";

export interface ThreadSummaryOptions {
	readonly status?: ThreadStatus;
}

export interface ThreadSummary {
	readonly thread: Thread;
	readonly messageCount: number;
	readonly lastMessageSeq: number;
	readonly lastMessageAt: number | null;
	readonly openTaskCount: number;
	readonly pendingQueueEntries: number;
}

export interface ThreadTimelineOptions {
	readonly limit?: number;
	readonly beforeSeq?: number;
}

export interface ThreadTimeline {
	readonly thread: Thread;
	readonly messages: readonly Message[];
	readonly events: readonly ThreadEvent[];
}

export interface TaskEvidence {
	readonly task: Task;
	readonly artifacts: readonly Artifact[];
	readonly reviews: readonly Review[];
	readonly merges: readonly Merge[];
	readonly approvals: readonly Approval[];
}

interface MessageStatsRow {
	thread_id: string;
	count: number;
	last_seq: number;
	last_at: number | null;
}

interface CountRow {
	thread_id: string;
	count: number;
}

export class ControlReadModels {
	private readonly store: ControlStore;

	constructor(store: ControlStore) {
		this.store = store;
	}

	threadSummaries(options: ThreadSummaryOptions = {}): ThreadSummary[] {
		const messages = new Map<string, MessageStatsRow>();
		for (const row of this.store.database
			.prepare(
				"SELECT thread_id, COUNT(*) AS count, COALESCE(MAX(seq), 0) AS last_seq, MAX(created_at) AS last_at FROM messages GROUP BY thread_id",
			)
			.all() as unknown as MessageStatsRow[]) {
			messages.set(row.thread_id, row);
		}
		const openTasks = this.countByThread(
			"SELECT thread_id, COUNT(*) AS count FROM tasks WHERE status IN ('todo', 'doing', 'blocked') GROUP BY thread_id",
		);
		const queued = this.countByThread(
			"SELECT thread_id, COUNT(*) AS count FROM queue_entries WHERE status = 'queued' GROUP BY thread_id",
		);
		return this.store.threads.list({ status: options.status }).map((thread) => {
			const stats = messages.get(thread.id);
			return {
				thread,
				messageCount: stats?.count ?? 0,
				lastMessageSeq: stats?.last_seq ?? 0,
				lastMessageAt: stats?.last_at ?? null,
				openTaskCount: openTasks.get(thread.id) ?? 0,
				pendingQueueEntries: queued.get(thread.id) ?? 0,
			};
		});
	}

	threadTimeline(threadId: string, options: ThreadTimelineOptions = {}): ThreadTimeline | null {
		const thread = this.store.threads.get(threadId);
		if (!thread) return null;
		const limit = options.limit ?? 100;
		return {
			thread,
			messages: this.store.messages.listThread(threadId, { limit, beforeSeq: options.beforeSeq }),
			events: this.store.threadEvents.list(threadId, limit),
		};
	}

	taskEvidence(taskId: string): TaskEvidence | null {
		const task = this.store.tasks.get(taskId);
		if (!task) return null;
		return {
			task,
			artifacts: this.store.artifacts.listByTask(taskId),
			reviews: this.store.reviews.listByTask(taskId),
			merges: this.store.merges.listByTask(taskId),
			approvals: this.store.approvals.list({ taskId }),
		};
	}

	private countByThread(sql: string): Map<string, number> {
		const counts = new Map<string, number>();
		for (const row of this.store.database.prepare(sql).all() as unknown as CountRow[]) {
			counts.set(row.thread_id, row.count);
		}
		return counts;
	}
}
