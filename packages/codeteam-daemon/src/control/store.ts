import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type ControlDatabase, type OpenControlDatabaseOptions, openControlDatabase } from "./database.ts";
import { ControlError } from "./errors.ts";
import { ArtifactStore } from "./stores/artifacts.ts";
import { AuditStore } from "./stores/audit.ts";
import { BacklogStore } from "./stores/backlog.ts";
import type { Clock } from "./stores/helpers.ts";
import { InboxStore } from "./stores/inbox.ts";
import { MessageStore } from "./stores/messages.ts";
import { AgentProfileStore } from "./stores/profiles.ts";
import { QueueStore } from "./stores/queue.ts";
import { RoleStore } from "./stores/roles.ts";
import { AgentSessionStore } from "./stores/sessions.ts";
import { ThreadStore } from "./stores/threads.ts";
import type { DispatchBacklogInput, DispatchBacklogResult, ProfileSeed } from "./stores/types.ts";
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
