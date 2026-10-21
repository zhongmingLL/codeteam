import { type Clock, systemClock } from "./clock.ts";
import { ControlPlaneError } from "./errors.ts";
import type { ControlSnapshot, ControlStore } from "./store.ts";
import type {
	ClaimResult,
	ControlPlaneOptions,
	CreateHandoffInput,
	Handoff,
	Role,
	Run,
	RunStatus,
	Stage,
	StageChangeKind,
	Task,
	TaskStatus,
} from "./types.ts";
import { Workflow } from "./workflow.ts";

const DEFAULT_DEADLINE_MS = 60_000;
const DEFAULT_LOOP_LIMIT = 2;

export class ControlPlane {
	private readonly tasks = new Map<string, Task>();
	private readonly runs = new Map<string, Run>();
	private readonly handoffs = new Map<string, Handoff>();
	private readonly loopCounts = new Map<string, number>();
	private readonly clock: Clock;
	private readonly loopLimit: number;
	private readonly defaultDeadlineMs: number;
	private readonly store?: ControlStore;
	private sequence = 0;
	private dirty = false;

	constructor(options: ControlPlaneOptions = {}) {
		this.clock = options.clock ?? systemClock;
		this.loopLimit = options.loopLimit ?? DEFAULT_LOOP_LIMIT;
		this.defaultDeadlineMs = options.defaultDeadlineMs ?? DEFAULT_DEADLINE_MS;
		this.store = options.store;
		if (this.store) this.hydrate(this.store.loadSnapshot());
	}

	createTask(id: string, stage: Stage = "intake", status: TaskStatus = "running"): Task {
		const existing = this.tasks.get(id);
		if (existing) return existing;
		const task: Task = { id, stage, status };
		this.tasks.set(id, task);
		this.store?.saveTask(task);
		return task;
	}

	getTask(id: string): Task {
		const task = this.tasks.get(id);
		if (!task) throw new ControlPlaneError("unknown_task", `unknown task: ${id}`);
		return task;
	}

	createRun(id: string, taskId: string, role: Role): Run {
		const existing = this.runs.get(id);
		if (existing) return existing;
		this.getTask(taskId);
		const run: Run = { id, taskId, role, status: "running" };
		this.runs.set(id, run);
		this.store?.saveRun(run);
		return run;
	}

	getRun(id: string): Run {
		const run = this.runs.get(id);
		if (!run) throw new ControlPlaneError("unknown_run", `unknown run: ${id}`);
		return run;
	}

	createHandoff(input: CreateHandoffInput): Handoff {
		this.getTask(input.taskId);
		if (!input.expectedArtifact.trim()) {
			throw new ControlPlaneError(
				"missing_expected_artifact",
				"handoff must declare the artifact expected from the receiver",
			);
		}
		const deadlineMs = input.deadlineMs ?? this.defaultDeadlineMs;
		if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
			throw new ControlPlaneError("invalid_deadline", `invalid handoff deadline: ${deadlineMs}`);
		}

		const loopKey = `${input.subject}::${input.actionPair}`;
		const count = this.loopCounts.get(loopKey) ?? 0;
		if (count >= this.loopLimit) {
			throw new ControlPlaneError("loop_guard", `loop guard: ${loopKey} repeated ${count} times; escalate to human`);
		}
		this.loopCounts.set(loopKey, count + 1);

		const now = this.clock.now();
		const handoff: Handoff = {
			id: `handoff-${++this.sequence}`,
			taskId: input.taskId,
			kind: input.kind,
			fromRole: input.fromRole,
			toRole: input.toRole,
			status: "pending",
			subject: input.subject,
			actionPair: input.actionPair,
			expectedArtifact: input.expectedArtifact,
			payload: input.payload ?? {},
			deadline: now + deadlineMs,
			attempt: 0,
			createdAt: now,
		};
		this.handoffs.set(handoff.id, handoff);
		this.store?.saveHandoff(handoff);
		this.wake();
		return handoff;
	}

	getHandoff(id: string): Handoff {
		const handoff = this.handoffs.get(id);
		if (!handoff) throw new ControlPlaneError("unknown_handoff", `unknown handoff: ${id}`);
		return handoff;
	}

	listHandoffs(taskId?: string): Handoff[] {
		const all = [...this.handoffs.values()];
		return taskId ? all.filter((handoff) => handoff.taskId === taskId) : all;
	}

	claim(handoffId: string, runId: string): ClaimResult {
		const handoff = this.getHandoff(handoffId);
		const run = this.getRun(runId);
		if (run.taskId !== handoff.taskId) {
			throw new ControlPlaneError("task_mismatch", `run ${run.id} belongs to ${run.taskId}, not ${handoff.taskId}`);
		}
		if (run.status !== "running") {
			throw new ControlPlaneError("run_terminal", `run ${run.id} is already ${run.status}`);
		}
		if (handoff.status === "consumed" || handoff.status === "expired") {
			throw new ControlPlaneError("terminal_handoff", `handoff ${handoff.id} is already ${handoff.status}`);
		}
		if (handoff.status === "claimed") {
			if (handoff.claimedByRunId === runId) {
				return { handoff, replayed: true };
			}
			throw new ControlPlaneError(
				"safe_wait",
				`handoff ${handoff.id} is already claimed by ${handoff.claimedByRunId}`,
			);
		}

		handoff.status = "claimed";
		handoff.claimedByRunId = runId;
		handoff.claimedAt = this.clock.now();
		handoff.attempt += 1;
		run.handoffId = handoff.id;
		this.store?.saveHandoff(handoff);
		this.store?.saveRun(run);
		this.wake();
		return { handoff, replayed: false };
	}

	complete(handoffId: string, runId: string, result: Record<string, unknown> = {}): Handoff {
		const handoff = this.getHandoff(handoffId);
		const run = this.getRun(runId);
		if (handoff.status === "consumed") {
			return handoff;
		}
		if (handoff.status === "expired") {
			throw new ControlPlaneError("terminal_handoff", `handoff ${handoff.id} is expired`);
		}
		if (handoff.status !== "claimed" || handoff.claimedByRunId !== runId) {
			throw new ControlPlaneError("not_claimed", `run ${runId} does not own handoff ${handoffId}`);
		}

		const now = this.clock.now();
		handoff.status = "consumed";
		handoff.result = result;
		handoff.terminalAt = now;
		run.status = "completed";
		run.terminalAt = now;
		this.store?.saveHandoff(handoff);
		this.store?.saveRun(run);
		this.wake();
		return handoff;
	}

	finishRun(runId: string, status: Extract<RunStatus, "completed" | "interrupted"> = "completed"): Run {
		const run = this.getRun(runId);
		if (run.status !== "running") {
			return run;
		}
		run.status = status;
		run.terminalAt = this.clock.now();
		let handoffChanged: Handoff | undefined;
		if (status === "interrupted" && run.handoffId) {
			const handoff = this.handoffs.get(run.handoffId);
			if (handoff && handoff.status === "claimed") {
				handoff.status = "pending";
				handoff.claimedByRunId = undefined;
				handoff.claimedAt = undefined;
				handoffChanged = handoff;
			}
		}
		this.store?.saveRun(run);
		if (handoffChanged) this.store?.saveHandoff(handoffChanged);
		this.wake();
		return run;
	}

	recoverInterruptedRuns(activeRunIds: ReadonlySet<string>): Run[] {
		const interrupted: Run[] = [];
		for (const run of this.runs.values()) {
			if (run.status === "running" && !activeRunIds.has(run.id)) {
				interrupted.push(this.finishRun(run.id, "interrupted"));
			}
		}
		return interrupted;
	}

	expire(now = this.clock.now()): Handoff[] {
		const expired: Handoff[] = [];
		for (const handoff of this.handoffs.values()) {
			if ((handoff.status === "pending" || handoff.status === "claimed") && handoff.deadline <= now) {
				handoff.status = "expired";
				handoff.terminalAt = now;
				if (handoff.claimedByRunId) {
					const run = this.runs.get(handoff.claimedByRunId);
					if (run && run.status === "running") {
						run.status = "interrupted";
						run.terminalAt = now;
						this.store?.saveRun(run);
					}
				}
				this.store?.saveHandoff(handoff);
				expired.push(handoff);
			}
		}
		if (expired.length > 0) this.wake();
		return expired;
	}

	wake(): void {
		this.dirty = true;
	}

	drain(): Handoff[] {
		if (!this.dirty) return [];
		this.dirty = false;
		return this.expire();
	}

	advanceTask(taskId: string, to: Stage): Task {
		const task = this.getTask(taskId);
		const workflow = new Workflow(task.stage);
		task.stage = workflow.advance(to);
		if (task.stage === "done") task.status = "done";
		this.store?.saveTask(task);
		this.wake();
		return task;
	}

	requestStageChange(taskId: string, kind: StageChangeKind): Task {
		const task = this.getTask(taskId);
		const workflow = new Workflow(task.stage);
		task.stage = workflow.requestChange(kind);
		this.store?.saveTask(task);
		this.wake();
		return task;
	}

	hydrate(snapshot: ControlSnapshot): void {
		this.tasks.clear();
		this.runs.clear();
		this.handoffs.clear();
		this.loopCounts.clear();
		this.sequence = 0;

		for (const task of snapshot.tasks) this.tasks.set(task.id, { ...task });
		for (const run of snapshot.runs) this.runs.set(run.id, { ...run });
		for (const handoff of snapshot.handoffs) {
			this.handoffs.set(handoff.id, {
				...handoff,
				payload: { ...handoff.payload },
				...(handoff.result ? { result: { ...handoff.result } } : {}),
			});
			const loopKey = `${handoff.subject}::${handoff.actionPair}`;
			this.loopCounts.set(loopKey, (this.loopCounts.get(loopKey) ?? 0) + 1);
			const sequence = Number.parseInt(handoff.id.replace(/^handoff-/, ""), 10);
			if (Number.isFinite(sequence)) this.sequence = Math.max(this.sequence, sequence);
		}
		this.wake();
	}

	snapshot(): ControlSnapshot {
		return {
			tasks: [...this.tasks.values()].map((task) => ({ ...task })),
			runs: [...this.runs.values()].map((run) => ({ ...run })),
			handoffs: [...this.handoffs.values()].map((handoff) => ({
				...handoff,
				payload: { ...handoff.payload },
				...(handoff.result ? { result: { ...handoff.result } } : {}),
			})),
		};
	}
}
