import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type ControlDatabase, type OpenControlDatabaseOptions, openControlDatabase } from "./database.ts";
import { ControlError } from "./errors.ts";
import { ArtifactStore } from "./stores/artifacts.ts";
import { AuditStore } from "./stores/audit.ts";
import { BacklogStore } from "./stores/backlog.ts";
import type { Clock } from "./stores/helpers.ts";
import { InboxStore } from "./stores/inbox.ts";
import { InvocationCredentialStore } from "./stores/invocation-credentials.ts";
import { MessageStore } from "./stores/messages.ts";
import { AgentProfileStore } from "./stores/profiles.ts";
import { QueueStore } from "./stores/queue.ts";
import { RoleStore } from "./stores/roles.ts";
import { RunStore } from "./stores/runs.ts";
import { AgentSessionStore } from "./stores/sessions.ts";
import { StageStore } from "./stores/stages.ts";
import { TaskStore } from "./stores/tasks.ts";
import { ThreadEventStore } from "./stores/thread-events.ts";
import { ThreadStore } from "./stores/threads.ts";
import type {
	CutoverQueueEntryInput,
	CutoverQueueEntryResult,
	DispatchBacklogInput,
	DispatchBacklogResult,
	ProfileSeed,
} from "./stores/types.ts";
import { WorkAdmissionStore } from "./stores/work-admissions.ts";
import { WorkflowSopStore } from "./stores/workflow-sops.ts";
import { ControlTransaction } from "./transaction.ts";

export interface ControlStoreOptions extends OpenControlDatabaseOptions {
	readonly clock?: Clock;
}

export interface SeedIdentityConfig {
	readonly eval: ProfileSeed;
	readonly compress: ProfileSeed;
}

export class ControlStore {
	readonly control: ControlDatabase;
	readonly transaction: ControlTransaction;
	readonly roles: RoleStore;
	readonly profiles: AgentProfileStore;
	readonly sessions: AgentSessionStore;
	readonly threads: ThreadStore;
	readonly messages: MessageStore;
	readonly queue: QueueStore;
	readonly tasks: TaskStore;
	readonly stages: StageStore;
	readonly runs: RunStore;
	readonly threadEvents: ThreadEventStore;
	readonly credentials: InvocationCredentialStore;
	readonly audit: AuditStore;
	readonly backlog: BacklogStore;
	readonly sops: WorkflowSopStore;
	readonly work: WorkAdmissionStore;
	readonly artifacts: ArtifactStore;
	readonly inbox: InboxStore;
	private readonly clock: Clock;

	constructor(control: ControlDatabase, clock: Clock = Date.now) {
		this.control = control;
		this.clock = clock;
		this.transaction = new ControlTransaction(control.database);
		this.roles = new RoleStore(control.database, clock);
		this.profiles = new AgentProfileStore(control.database, clock);
		this.sessions = new AgentSessionStore(control.database, this.transaction, clock);
		this.threads = new ThreadStore(control.database, this.transaction, clock);
		this.messages = new MessageStore(control.database, this.transaction, clock);
		this.queue = new QueueStore(control.database, this.transaction, clock);
		this.tasks = new TaskStore(control.database, this.transaction, clock);
		this.stages = new StageStore(control.database, this.transaction, clock);
		this.runs = new RunStore(control.database, this.transaction, clock);
		this.threadEvents = new ThreadEventStore(control.database, this.transaction, clock);
		this.credentials = new InvocationCredentialStore(control.database, this.transaction, clock);
		this.audit = new AuditStore(control.database, clock);
		this.backlog = new BacklogStore(control.database, this.transaction, clock, this.audit);
		this.sops = new WorkflowSopStore(control.database, this.transaction, clock, this.audit);
		this.work = new WorkAdmissionStore(control.database, this.transaction, clock);
		this.artifacts = new ArtifactStore(
			control.database,
			this.transaction,
			clock,
			join(dirname(control.path), "artifacts"),
		);
		this.inbox = new InboxStore(control.database, this.transaction, clock);
	}

	get database(): DatabaseSync {
		return this.control.database;
	}

	seedIdentity(config?: SeedIdentityConfig): void {
		this.transaction.run(() => {
			this.roles.seedBuiltInRoles();
			if (config) this.profiles.seedDefaultProfiles(config);
		});
	}

	dispatchBacklog(input: DispatchBacklogInput): DispatchBacklogResult {
		const targets = [...new Set(input.targets)];
		if (targets.length === 0 || targets.length !== input.targets.length) {
			throw new ControlError("invalid_input", "dispatch targets must be a non-empty unique array");
		}
		const dispatchAttemptId = input.dispatchAttemptId ?? `dispatch:${input.backlogItemId}:${this.clock()}`;
		return this.transaction.run(() => {
			const backlog = this.backlog.get(input.backlogItemId);
			if (!backlog) throw new ControlError("not_found", `backlog item ${input.backlogItemId} not found`);
			if (backlog.status === "dispatched") {
				if (backlog.dispatchAttemptId !== dispatchAttemptId) {
					throw new ControlError(
						"conflict",
						`backlog item ${input.backlogItemId} was dispatched by another attempt`,
					);
				}
				const thread = backlog.dispatchedThreadId ? this.threads.get(backlog.dispatchedThreadId) : null;
				const message = backlog.kickoffMessageId ? this.messages.get(backlog.kickoffMessageId) : null;
				const queueEntry = message ? this.queue.get(`queue:${message.id}`) : null;
				if (!thread || !message || !queueEntry) {
					throw new ControlError(
						"conflict",
						`dispatched backlog item ${input.backlogItemId} is missing its resources`,
					);
				}
				const sameTargets =
					queueEntry.targets.length === targets.length &&
					targets.every((target) => queueEntry.targets.includes(target));
				if (!sameTargets) {
					throw new ControlError(
						"conflict",
						`dispatch replay targets differ for backlog item ${input.backlogItemId}`,
					);
				}
				return {
					backlog,
					thread,
					message,
					queueEntry,
					audit: this.audit.latest(`backlog:${input.backlogItemId}`, "backlog_dispatched"),
				};
			}
			if (backlog.status !== "approved") {
				throw new ControlError("invalid_state", `backlog item ${input.backlogItemId} is ${backlog.status}`);
			}
			for (const target of targets) {
				if (!this.profiles.get(target)) {
					throw new ControlError("not_found", `dispatch target profile ${target} not found`);
				}
			}
			const thread = this.threads.create({
				title: input.title ?? backlog.title,
				repo: input.repo ?? null,
				backlogItemId: backlog.id,
				phase: input.threadPhase,
			});
			const message = this.messages.append({
				threadId: thread.id,
				authorKind: "system",
				authorId: "system:dispatch",
				kind: "backlog_kickoff",
				bodyMd: input.kickoffBody ?? backlog.summary,
			});
			const queueEntry = this.queue.admit({
				threadId: thread.id,
				sourceId: message.id,
				sourceRecordId: backlog.id,
				sourceKind: "backlog_dispatch",
				targets,
				authorIntent: Object.fromEntries(targets.map((target) => [target, "next_work"])),
				priority: "normal",
				sourceCategory: "backlog_dispatch",
				orderKey: `${backlog.createdAt}:${backlog.id}`,
			});
			const updated = this.backlog.markDispatched(backlog.id, {
				threadId: thread.id,
				phase: input.threadPhase,
				dispatchAttemptId,
				kickoffMessageId: message.id,
			});
			const audit = this.audit.append({
				actor: "system:dispatch",
				action: "backlog_dispatched",
				subject: `backlog:${backlog.id}`,
				args: {
					threadId: thread.id,
					messageId: message.id,
					queueEntryId: queueEntry.id,
					dispatchAttemptId,
				},
			});
			return { backlog: updated, thread, message, queueEntry, audit };
		});
	}

	cutoverQueueEntry(input: CutoverQueueEntryInput): CutoverQueueEntryResult {
		return this.transaction.run(() => {
			const entry = this.queue.get(input.queueEntryId);
			if (!entry) throw new ControlError("not_found", `queue entry ${input.queueEntryId} not found`);
			if (entry.status !== "claimed" || entry.claimId !== input.claimId) {
				throw new ControlError(
					"claim_conflict",
					`queue entry ${input.queueEntryId} is not claimed by ${input.claimId}`,
				);
			}
			if (!entry.targets.includes(input.targetProfileId)) {
				throw new ControlError("invalid_input", `target ${input.targetProfileId} is not queued`);
			}
			const task = this.tasks.get(input.taskId);
			if (!task) throw new ControlError("not_found", `task ${input.taskId} not found`);
			const thread = this.threads.get(task.threadId);
			if (!thread) throw new ControlError("schema_incomplete", `task ${task.id} has no thread`);
			if (!this.profiles.get(input.targetProfileId)) {
				throw new ControlError("not_found", `agent profile ${input.targetProfileId} not found`);
			}
			const session = this.sessions.get(input.agentSessionId);
			if (!session) throw new ControlError("not_found", `agent session ${input.agentSessionId} not found`);
			if (
				session.taskId !== task.id ||
				session.threadId !== thread.id ||
				session.profileId !== input.targetProfileId
			) {
				throw new ControlError("invalid_input", "agent session is not bound to the cutover task/thread/profile");
			}
			const responseMessage = this.messages.append({
				threadId: thread.id,
				taskId: task.id,
				authorKind: "agent",
				authorId: input.targetProfileId,
				kind: "agent_response",
				bodyMd: input.responseBody ?? "",
			});
			const run = this.runs.create({
				taskId: task.id,
				queueEntryId: entry.id,
				stageId: input.stageId ?? null,
				attempt: input.attempt ?? 1,
				role: input.role,
				agentSessionId: input.agentSessionId,
				parentRunId: input.parentRunId ?? null,
				sourceId: entry.sourceId,
				recipientProfileId: input.targetProfileId,
				chainMetadata: input.chainMetadata,
				provider: input.provider,
				model: input.model,
				modelFamily: input.modelFamily,
				l0Revision: input.l0Revision ?? null,
				responseMessageId: responseMessage.id,
				executionKind: input.executionKind ?? "ordinary",
				handoffId: input.handoffId ?? null,
				approvalId: input.approvalId ?? null,
			});
			const runEvent = this.runs.appendEvent(run.id, "message", { messageId: responseMessage.id });
			this.messages.appendDispatchRef(entry.sourceId, {
				targetId: input.targetProfileId,
				phase: "dispatched",
				statusMessageId: responseMessage.id,
				dispatchedAt: this.clock(),
			});
			if (task.kind === "work" && input.role === "coder" && task.backlogItemId) {
				const backlog = this.backlog.get(task.backlogItemId);
				if (backlog) {
					const identity = this.sops.workIdentity(backlog.id, backlog.userId);
					const admission = this.work.getAdmission(identity.workId);
					if (admission) {
						const attempt = this.work.getAttempt(admission.initialAttemptId);
						if (attempt) {
							if (attempt.executorProfileId !== null && attempt.executorProfileId !== input.targetProfileId) {
								throw new ControlError("conflict", "work attempt is bound to another executor");
							}
							if (attempt.executorProfileId === null) {
								this.work.bindAttempt(admission.initialAttemptId, input.targetProfileId);
							}
						}
						this.work.bindRun({
							runId: run.id,
							workId: identity.workId,
							attemptId: admission.initialAttemptId,
						});
					}
				}
			}
			const cutover = this.queue.cutoverTarget(entry.id, input.claimId, input.targetProfileId);
			return {
				run: this.runs.get(run.id)!,
				responseMessage,
				queueEntry: cutover.entry,
				runEvent,
			};
		});
	}

	close(): void {
		this.control.close();
	}
}

export function openControlStore(options: ControlStoreOptions = {}): ControlStore {
	const { clock, ...databaseOptions } = options;
	const control = openControlDatabase(databaseOptions);
	try {
		return new ControlStore(control, clock);
	} catch (error) {
		control.close();
		throw error;
	}
}
