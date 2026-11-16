import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import type { AgentSession, Task, WorktreeLease } from "../control/stores/types.ts";
import { WorktreePoolService } from "./worktree-pool.ts";

export interface PrepareTaskInput {
	readonly taskId: string;
	readonly profileIds: readonly string[];
	readonly role?: string | null;
	readonly worktree?: string | null;
	readonly actorRef: string;
}

export interface PrepareTaskResult {
	readonly task: Task;
	readonly sessions: readonly AgentSession[];
	readonly lease: WorktreeLease | null;
	readonly reusedWorktree: boolean;
}

export interface TaskProvisioningOptions {
	readonly worktreeRootDir: string;
	readonly worktreePool?: WorktreePoolService;
}

export class TaskProvisioningService {
	private readonly store: ControlStore;
	private readonly worktreeRootDir: string;
	private readonly worktreePool: WorktreePoolService;

	constructor(store: ControlStore, options: TaskProvisioningOptions) {
		this.store = store;
		this.worktreeRootDir = options.worktreeRootDir;
		this.worktreePool = options.worktreePool ?? new WorktreePoolService(store, { rootDir: options.worktreeRootDir });
	}

	prepare(input: PrepareTaskInput): PrepareTaskResult {
		const profileIds = [...new Set(input.profileIds)];
		if (profileIds.length === 0 || profileIds.length !== input.profileIds.length) {
			throw new ControlError("invalid_input", "profile ids must be a non-empty unique array");
		}
		if (input.role && profileIds.length !== 1) {
			throw new ControlError("invalid_input", "--role requires exactly one --profile");
		}
		const task = this.store.tasks.get(input.taskId);
		if (!task) throw new ControlError("not_found", `task ${input.taskId} not found`);
		const prepared = this.prepareWorktree(task, input);
		const sessions = profileIds.map((profileId) => this.prepareSession(prepared.task, profileId, input.role ?? null));
		this.store.audit.append({
			actor: input.actorRef,
			action: "task_prepared",
			subject: `task:${prepared.task.id}`,
			args: {
				worktree: prepared.task.worktree,
				leaseId: prepared.lease?.id ?? null,
				sessionIds: sessions.map((session) => session.id),
			},
		});
		return {
			task: prepared.task,
			sessions,
			lease: prepared.lease,
			reusedWorktree: prepared.reused,
		};
	}

	private prepareWorktree(
		task: Task,
		input: PrepareTaskInput,
	): { task: Task; lease: WorktreeLease | null; reused: boolean } {
		if (input.worktree) {
			const requested = resolve(input.worktree);
			this.assertDirectory(requested);
			if (task.worktree && resolve(task.worktree) !== requested) {
				throw new ControlError("invalid_state", `task ${task.id} is already bound to ${task.worktree}`);
			}
			const updated = this.store.tasks.bindWorktree(task.id, { worktree: requested });
			const lease = this.activeLease(task.id, requested);
			return { task: updated, lease, reused: Boolean(task.worktree) };
		}
		if (task.worktree) {
			const existing = resolve(task.worktree);
			this.assertDirectory(existing);
			return { task, lease: this.activeLease(task.id, existing), reused: true };
		}
		const lease = this.worktreePool.acquire({ taskId: task.id });
		const updated = this.store.tasks.bindWorktree(task.id, { worktree: lease.path });
		return { task: updated, lease, reused: false };
	}

	private prepareSession(task: Task, profileId: string, requestedRole: string | null): AgentSession {
		const profile = this.store.profiles.get(profileId);
		if (!profile) throw new ControlError("not_found", `agent profile ${profileId} not found`);
		if (profile.status !== "active") {
			throw new ControlError("invalid_state", `agent profile ${profileId} is disabled`);
		}
		const role = requestedRole ?? profile.role;
		const roleRecord = this.store.roles.get(role);
		if (!roleRecord || roleRecord.status !== "active") {
			throw new ControlError("invalid_input", `role ${role} is not active`);
		}
		const existing = this.store.sessions.list({ taskId: task.id, profileId, status: "active" });
		if (existing.length > 1) {
			throw new ControlError("invalid_state", `profile ${profileId} has ambiguous active sessions`);
		}
		if (existing.length === 1) {
			const session = existing[0]!;
			if (session.role !== role) {
				throw new ControlError(
					"invalid_state",
					`profile ${profileId} already has an active ${session.role} session; seal it before ${role}`,
				);
			}
			return session;
		}
		const seq =
			this.store.sessions.list({ taskId: task.id }).reduce((maximum, session) => Math.max(maximum, session.seq), 0) +
			1;
		return this.store.sessions.create({
			threadId: task.threadId,
			taskId: task.id,
			profileId,
			role,
			effectiveToolPolicy: profile.toolPolicyProfile ?? "default",
			provider: profile.provider,
			model: profile.model,
			modelFamily: profile.modelFamily,
			seq,
			workingDirectory: task.worktree,
			userId: task.userId,
		});
	}

	private activeLease(taskId: string, path: string): WorktreeLease | null {
		return (
			this.store.worktreeLeases
				.list({ taskId, status: "leased" })
				.find((lease) => resolve(lease.path) === resolve(path)) ?? null
		);
	}

	private assertDirectory(path: string): void {
		if (!existsSync(path) || !statSync(path).isDirectory()) {
			throw new ControlError("invalid_input", `worktree ${path} is not an existing directory`);
		}
	}
}

export function defaultWorktreeRoot(dataDir: string): string {
	return join(dataDir, "worktrees");
}
