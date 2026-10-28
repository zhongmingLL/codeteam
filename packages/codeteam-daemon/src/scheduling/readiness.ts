import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import type { Task } from "../control/stores/types.ts";
import type { BudgetService } from "./budget.ts";
import { BudgetService as BudgetServiceImpl } from "./budget.ts";
import {
	type CapacityProvider,
	type CapacitySnapshot,
	decideCapacity,
	LocalCapacityProvider,
	WorkerRegistryCapacityProvider,
} from "./capacity.ts";
import { dependencyState } from "./dependencies.ts";
import { backlogQueuePriority, queuePriorityRank } from "./priority.ts";

export type ReadinessReasonCode =
	| "task_missing"
	| "task_terminal"
	| "task_blocked"
	| "backlog_missing"
	| "backlog_not_approved"
	| "backlog_done"
	| "dependency_unmet"
	| "dependency_missing"
	| "dependency_cycle"
	| "budget_paused"
	| "capacity_unknown"
	| "capacity_exhausted"
	| "worktree_capacity_exhausted"
	| "worktree_disk_low"
	| "worktree_disk_unknown";

export interface ReadinessReason {
	readonly code: ReadinessReasonCode;
	readonly message: string;
	readonly refs?: readonly string[];
}

export interface ReadinessDecision {
	readonly subject: "task" | "backlog";
	readonly id: string;
	readonly ready: boolean;
	readonly priority: "urgent" | "normal";
	readonly orderKey: string;
	readonly role: string;
	readonly reasons: readonly ReadinessReason[];
	readonly capacity: CapacitySnapshot | null;
}

export interface WorktreeCapacityProbe {
	checkCapacity(): { readonly ok: boolean; readonly code?: string; readonly message?: string };
}

export interface TaskReadinessOptions {
	readonly now?: number;
	readonly role?: string;
	readonly requireWorktree?: boolean;
}

export interface TaskReadinessServiceOptions {
	readonly capacity?: CapacityProvider;
	readonly budget?: BudgetService;
	readonly worktree?: WorktreeCapacityProbe;
}

function taskRole(store: ControlStore, task: Task, fallback: string | undefined): string {
	if (task.ownerProfileId) {
		const profile = store.profiles.get(task.ownerProfileId);
		if (profile) return profile.role;
	}
	return fallback ?? "coder";
}

export class TaskReadinessService {
	private readonly store: ControlStore;
	private readonly capacity: CapacityProvider | null;
	private readonly budget: BudgetService;
	private readonly worktree: WorktreeCapacityProbe | undefined;

	constructor(store: ControlStore, options: TaskReadinessServiceOptions = {}) {
		this.store = store;
		this.capacity = options.capacity ?? null;
		this.budget = options.budget ?? new BudgetServiceImpl(store);
		this.worktree = options.worktree;
	}

	evaluateTask(taskId: string, options: TaskReadinessOptions = {}): ReadinessDecision {
		const now = options.now ?? Date.now();
		const task = this.store.tasks.get(taskId);
		if (!task) {
			return this.decision(
				"task",
				taskId,
				"normal",
				`${taskId}`,
				options.role ?? "coder",
				[{ code: "task_missing", message: `task ${taskId} not found` }],
				this.capacitySnapshot(now),
			);
		}
		const backlog = task.backlogItemId ? this.store.backlog.get(task.backlogItemId) : null;
		const priority = backlog ? backlogQueuePriority(backlog.priority) : "normal";
		const orderKey = backlog
			? `${queuePriorityRank(priority)}:${backlog.createdAt}:${backlog.id}`
			: `${queuePriorityRank(priority)}:${task.createdAt}:${task.id}`;
		const reasons: ReadinessReason[] = [];
		if (task.status === "done") reasons.push({ code: "task_terminal", message: `task ${task.id} is done` });
		if (task.status === "blocked") reasons.push({ code: "task_blocked", message: `task ${task.id} is blocked` });
		if (task.backlogItemId) this.appendDependencyReasons(task.backlogItemId, reasons);
		this.appendBudgetReasons(task.id, reasons);
		const role = taskRole(this.store, task, options.role);
		const snapshot = this.capacitySnapshot(now);
		const capacity = decideCapacity(snapshot, role, now);
		if (!capacity.ok) {
			reasons.push({ code: capacity.code, message: capacity.message });
		}
		if (options.requireWorktree !== false && !task.worktree && this.worktree) {
			const probe = this.worktree.checkCapacity();
			if (!probe.ok) {
				const code =
					probe.code === "worktree_disk_low"
						? "worktree_disk_low"
						: probe.code === "worktree_disk_unknown"
							? "worktree_disk_unknown"
							: "worktree_capacity_exhausted";
				reasons.push({ code, message: probe.message ?? "worktree capacity is unavailable" });
			}
		}
		return this.decision("task", task.id, priority, orderKey, role, reasons, snapshot);
	}

	evaluateBacklog(backlogId: string, options: TaskReadinessOptions = {}): ReadinessDecision {
		const now = options.now ?? Date.now();
		const backlog = this.store.backlog.get(backlogId);
		if (!backlog) {
			return this.decision(
				"backlog",
				backlogId,
				"normal",
				backlogId,
				options.role ?? "coder",
				[{ code: "backlog_missing", message: `backlog item ${backlogId} not found` }],
				this.capacitySnapshot(now),
			);
		}
		const priority = backlogQueuePriority(backlog.priority);
		const orderKey = `${queuePriorityRank(priority)}:${backlog.createdAt}:${backlog.id}`;
		const reasons: ReadinessReason[] = [];
		if (backlog.status === "done")
			reasons.push({ code: "backlog_done", message: `backlog item ${backlog.id} is done` });
		else if (backlog.status !== "approved") {
			reasons.push({
				code: "backlog_not_approved",
				message: `backlog item ${backlog.id} is ${backlog.status}, not approved`,
			});
		}
		this.appendDependencyReasons(backlog.id, reasons);
		const workTask = this.store.tasks.findWorkByBacklog(backlog.id);
		if (workTask) this.appendBudgetReasons(workTask.id, reasons);
		const role = workTask ? taskRole(this.store, workTask, options.role) : (options.role ?? "coder");
		const snapshot = this.capacitySnapshot(now);
		const capacity = decideCapacity(snapshot, role, now);
		if (!capacity.ok) reasons.push({ code: capacity.code, message: capacity.message });
		if (options.requireWorktree !== false && !workTask?.worktree && this.worktree) {
			const probe = this.worktree.checkCapacity();
			if (!probe.ok) {
				const code =
					probe.code === "worktree_disk_low"
						? "worktree_disk_low"
						: probe.code === "worktree_disk_unknown"
							? "worktree_disk_unknown"
							: "worktree_capacity_exhausted";
				reasons.push({ code, message: probe.message ?? "worktree capacity is unavailable" });
			}
		}
		return this.decision("backlog", backlog.id, priority, orderKey, role, reasons, snapshot);
	}

	listReadyBacklog(options: TaskReadinessOptions = {}): ReadinessDecision[] {
		return this.store.backlog
			.list({ status: "approved" })
			.map((item) => this.evaluateBacklog(item.id, options))
			.filter((decision) => decision.ready)
			.sort((left, right) => left.orderKey.localeCompare(right.orderKey));
	}

	assertBacklogDispatchable(backlogId: string, options: TaskReadinessOptions = {}): ReadinessDecision {
		const decision = this.evaluateBacklog(backlogId, options);
		if (!decision.ready) {
			throw new ControlError("admission_blocked", decision.reasons.map((reason) => reason.code).join(","), {
				details: { reasons: decision.reasons },
			});
		}
		return decision;
	}

	assertTaskDispatchable(taskId: string, options: TaskReadinessOptions = {}): ReadinessDecision {
		const decision = this.evaluateTask(taskId, options);
		if (!decision.ready) {
			throw new ControlError("admission_blocked", decision.reasons.map((reason) => reason.code).join(","), {
				details: { reasons: decision.reasons },
			});
		}
		return decision;
	}

	private appendDependencyReasons(backlogId: string, reasons: ReadinessReason[]): void {
		const deps = dependencyState(this.store, backlogId);
		if (deps.unmet.length > 0) {
			reasons.push({
				code: "dependency_unmet",
				message: `dependencies not done: ${deps.unmet.join(", ")}`,
				refs: deps.unmet,
			});
		}
		if (deps.missing.length > 0) {
			reasons.push({
				code: "dependency_missing",
				message: `missing dependencies: ${deps.missing.join(", ")}`,
				refs: deps.missing,
			});
		}
		if (deps.cycle.length > 0) {
			reasons.push({
				code: "dependency_cycle",
				message: `dependency cycle: ${deps.cycle.join(" -> ")}`,
				refs: deps.cycle,
			});
		}
	}

	private appendBudgetReasons(taskId: string, reasons: ReadinessReason[]): void {
		const status = this.budget.status(taskId);
		if (status.paused) {
			reasons.push({
				code: "budget_paused",
				message: `budget paused: ${status.limitsHit.join(", ") || "operator approval open"}`,
				refs: status.pauseApprovalId ? [status.pauseApprovalId] : [],
			});
		}
	}

	private capacitySnapshot(now: number): CapacitySnapshot | null {
		if (this.capacity) return this.capacity.snapshot(now);
		if (this.store.workers.list().length > 0) {
			return new WorkerRegistryCapacityProvider(this.store).snapshot(now);
		}
		return new LocalCapacityProvider(this.store).snapshot(now);
	}

	private decision(
		subject: "task" | "backlog",
		id: string,
		priority: "urgent" | "normal",
		orderKey: string,
		role: string,
		reasons: readonly ReadinessReason[],
		capacity: CapacitySnapshot | null,
	): ReadinessDecision {
		return { subject, id, ready: reasons.length === 0, priority, orderKey, role, reasons, capacity };
	}
}
