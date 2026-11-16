import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import type {
	CreateScheduleSpecInput,
	ScheduleAdmission,
	ScheduleRun,
	ScheduleRunSpec,
	ScheduleSpec,
	ScheduleState,
} from "../control/stores/types.ts";
import { TaskReadinessService } from "./readiness.ts";

export const TASK_WAKE_FACTORY_ID = "task_wake";

export interface ScheduleFactoryContext {
	readonly spec: ScheduleSpec;
	readonly occurrenceKey: string;
	readonly scheduledFor: number;
}

export interface ScheduleMaterialization {
	readonly bodyMd: string;
	readonly targets: readonly string[];
	readonly priority: "urgent" | "normal";
	readonly sourceCategory: string;
	readonly orderKey: string;
	readonly messageKind: ScheduleRunSpec["messageKind"];
	readonly authorKind: ScheduleRunSpec["authorKind"];
	readonly authorId: string;
}

export interface ScheduleFactory {
	readonly id: string;
	materialize(context: ScheduleFactoryContext): ScheduleMaterialization;
}

export class ScheduleFactoryRegistry {
	private readonly factories = new Map<string, ScheduleFactory>();

	register(factory: ScheduleFactory): void {
		if (factory.id.trim() === "") throw new ControlError("invalid_input", "schedule factory id is required");
		if (this.factories.has(factory.id)) {
			throw new ControlError("conflict", `schedule factory ${factory.id} is already registered`);
		}
		this.factories.set(factory.id, factory);
	}

	get(id: string): ScheduleFactory | null {
		return this.factories.get(id) ?? null;
	}

	require(id: string): ScheduleFactory {
		const factory = this.get(id);
		if (!factory) throw new ControlError("schedule_unknown_factory", `schedule factory ${id} is not registered`);
		return factory;
	}

	ids(): string[] {
		return [...this.factories.keys()].sort();
	}
}

export class TaskWakeScheduleFactory implements ScheduleFactory {
	readonly id = TASK_WAKE_FACTORY_ID;

	materialize(context: ScheduleFactoryContext): ScheduleMaterialization {
		const admission: ScheduleAdmission = context.spec.admission;
		const runSpec: ScheduleRunSpec = context.spec.runSpec;
		return {
			bodyMd: runSpec.bodyMd,
			targets: admission.targets,
			priority: admission.priority,
			sourceCategory: `proactive_schedule:${context.spec.factoryId}`,
			orderKey: `${context.scheduledFor}:${context.occurrenceKey}`,
			messageKind: runSpec.messageKind ?? "status",
			authorKind: runSpec.authorKind ?? "system",
			authorId: runSpec.authorId ?? "system:schedule",
		};
	}
}

export function createDefaultScheduleFactoryRegistry(): ScheduleFactoryRegistry {
	const registry = new ScheduleFactoryRegistry();
	registry.register(new TaskWakeScheduleFactory());
	return registry;
}

export interface ProactiveScheduleOptions {
	readonly factories?: ScheduleFactoryRegistry;
	readonly readiness?: TaskReadinessService;
	readonly maxCatchUp?: number;
}

export interface ScheduleTickResult {
	readonly materialized: readonly ScheduleRun[];
	readonly skipped: readonly ScheduleRun[];
	readonly duplicates: readonly ScheduleRun[];
}

export interface ManualScheduleInput {
	readonly occurrenceKey?: string;
	readonly scheduledFor?: number;
}

export class ProactiveScheduleService {
	private readonly store: ControlStore;
	private readonly factories: ScheduleFactoryRegistry;
	private readonly readiness: TaskReadinessService;
	private readonly maxCatchUp: number;
	private readonly clock: () => number;

	constructor(store: ControlStore, options: ProactiveScheduleOptions = {}, clock: () => number = Date.now) {
		this.store = store;
		this.factories = options.factories ?? createDefaultScheduleFactoryRegistry();
		this.readiness = options.readiness ?? new TaskReadinessService(store);
		this.maxCatchUp = options.maxCatchUp ?? 10;
		this.clock = clock;
	}

	register(input: CreateScheduleSpecInput): ScheduleSpec {
		this.factories.require(input.factoryId);
		const spec = this.store.schedules.create(input);
		this.store.audit.append({
			actor: "system:schedule",
			action: "schedule_registered",
			subject: `schedule:${spec.id}`,
			args: { taskId: spec.taskId, factoryId: spec.factoryId, trigger: spec.trigger },
		});
		return spec;
	}

	pause(specId: string, actorRef: string): ScheduleSpec {
		const spec = this.store.schedules.setStatus(specId, "paused");
		this.store.audit.append({
			actor: actorRef,
			action: "schedule_paused",
			subject: `schedule:${spec.id}`,
			args: {},
		});
		return spec;
	}

	resume(specId: string, actorRef: string, now = this.clock()): ScheduleSpec {
		const current = this.store.schedules.get(specId);
		if (!current) throw new ControlError("not_found", `schedule spec ${specId} not found`);
		const spec = this.store.schedules.setStatus(specId, "active");
		if (spec.trigger.kind === "timer" && (spec.state.nextRunAt === null || spec.state.nextRunAt < now)) {
			const resumed = this.store.schedules.updateProgress(spec.id, {
				state: { ...spec.state, nextRunAt: now },
				outcome: spec.outcome,
				expectedVersion: spec.version,
			});
			this.store.audit.append({
				actor: actorRef,
				action: "schedule_resumed",
				subject: `schedule:${spec.id}`,
				args: { nextRunAt: now },
			});
			return resumed;
		}
		this.store.audit.append({
			actor: actorRef,
			action: "schedule_resumed",
			subject: `schedule:${spec.id}`,
			args: { nextRunAt: spec.state.nextRunAt },
		});
		return spec;
	}

	tick(now = this.clock()): ScheduleTickResult {
		const materialized: ScheduleRun[] = [];
		const skipped: ScheduleRun[] = [];
		const duplicates: ScheduleRun[] = [];
		for (const spec of this.store.schedules.list({ status: "active" })) {
			if (spec.trigger.kind !== "timer") continue;
			const dueAt = spec.state.nextRunAt ?? spec.trigger.firstRunAt ?? spec.createdAt;
			if (dueAt > now) continue;
			const dueCount = Math.min(this.maxCatchUp, Math.floor((now - dueAt) / spec.trigger.everyMs) + 1);
			let nextRunAt = dueAt;
			for (let index = 0; index < dueCount; index += 1) {
				const scheduledFor = dueAt + index * spec.trigger.everyMs;
				const occurrenceKey = `${spec.id}:${scheduledFor}`;
				const result = this.materialize(spec.id, { occurrenceKey, scheduledFor });
				if (result.status === "duplicate") duplicates.push(result.run);
				else if (result.run.status === "queued") materialized.push(result.run);
				else skipped.push(result.run);
				nextRunAt = scheduledFor + spec.trigger.everyMs;
			}
			const current = this.store.schedules.get(spec.id);
			if (current) {
				const state: ScheduleState = {
					...current.state,
					nextRunAt,
					lastRunAt: now,
					generation: current.state.generation + 1,
				};
				try {
					this.store.schedules.updateProgress(spec.id, {
						state,
						outcome: { ...current.outcome, lastTickAt: now, lastNextRunAt: nextRunAt },
						expectedVersion: current.version,
					});
				} catch (error) {
					if (!(error instanceof ControlError) || error.code !== "version_conflict") throw error;
				}
			}
		}
		return { materialized, skipped, duplicates };
	}

	materialize(
		specId: string,
		input: ManualScheduleInput = {},
	): { status: "queued" | "skipped" | "duplicate"; run: ScheduleRun; queueEntryId: string | null } {
		const spec = this.store.schedules.get(specId);
		if (!spec) throw new ControlError("not_found", `schedule spec ${specId} not found`);
		const scheduledFor = input.scheduledFor ?? this.clock();
		const occurrenceKey = input.occurrenceKey ?? `manual:${scheduledFor}`;
		const existing = this.store.schedules.getRun(specId, occurrenceKey);
		if (existing) return { status: "duplicate", run: existing, queueEntryId: existing.queueEntryId };
		if (spec.status === "paused") {
			return this.recordSkip(spec, occurrenceKey, scheduledFor, { code: "schedule_paused" });
		}
		const readiness = this.readiness.evaluateTask(spec.taskId, { now: scheduledFor });
		if (!readiness.ready) {
			return this.recordSkip(spec, occurrenceKey, scheduledFor, {
				code: "task_not_ready",
				reasons: readiness.reasons,
			});
		}
		const factory = this.factories.get(spec.factoryId);
		if (!factory) {
			const run = this.store.schedules.recordRun({
				specId,
				occurrenceKey,
				scheduledFor,
				status: "failed",
				reason: { code: "schedule_unknown_factory", factoryId: spec.factoryId },
			});
			return { status: "skipped", run, queueEntryId: null };
		}
		const materialization = factory.materialize({ spec, occurrenceKey, scheduledFor });
		const result = this.store.transaction.run(() => {
			const message = this.store.messages.append({
				threadId: spec.threadId,
				taskId: spec.taskId,
				authorKind: materialization.authorKind ?? "system",
				authorId: materialization.authorId,
				kind: materialization.messageKind ?? "status",
				bodyMd: materialization.bodyMd,
			});
			const queueEntry = this.store.queue.admit({
				threadId: spec.threadId,
				sourceId: message.id,
				sourceRecordId: spec.id,
				sourceKind: "message_wake",
				targets: [...materialization.targets],
				authorIntent: Object.fromEntries(
					materialization.targets.map((target) => [
						target,
						{ intent: "next_work", scheduleId: spec.id, occurrenceKey },
					]),
				),
				priority: materialization.priority,
				sourceCategory: materialization.sourceCategory,
				orderKey: materialization.orderKey,
			});
			const run = this.store.schedules.recordRun({
				specId,
				occurrenceKey,
				scheduledFor,
				status: "queued",
				queueEntryId: queueEntry.id,
				sourceMessageId: message.id,
			});
			const current = this.store.schedules.get(spec.id)!;
			this.store.schedules.updateProgress(spec.id, {
				state: current.state,
				outcome: {
					...current.outcome,
					lastOccurrenceKey: occurrenceKey,
					lastQueueEntryId: queueEntry.id,
					lastSourceMessageId: message.id,
					lastStatus: "queued",
					lastAt: scheduledFor,
				},
				expectedVersion: current.version,
			});
			return { run, queueEntryId: queueEntry.id };
		});
		this.store.audit.append({
			actor: "system:schedule",
			action: "schedule_occurrence_materialized",
			subject: `schedule:${spec.id}`,
			args: { occurrenceKey, queueEntryId: result.queueEntryId, factoryId: spec.factoryId },
		});
		return { status: "queued", run: result.run, queueEntryId: result.queueEntryId };
	}

	private recordSkip(
		spec: ScheduleSpec,
		occurrenceKey: string,
		scheduledFor: number,
		reason: Record<string, unknown>,
	): { status: "skipped"; run: ScheduleRun; queueEntryId: null } {
		const run = this.store.schedules.recordRun({
			specId: spec.id,
			occurrenceKey,
			scheduledFor,
			status: "skipped",
			reason,
		});
		const current = this.store.schedules.get(spec.id);
		if (current && current.version === spec.version) {
			this.store.schedules.updateProgress(spec.id, {
				state: current.state,
				outcome: {
					...current.outcome,
					lastOccurrenceKey: occurrenceKey,
					lastStatus: "skipped",
					lastAt: scheduledFor,
					lastReason: reason,
				},
				expectedVersion: current.version,
			});
		}
		this.store.audit.append({
			actor: "system:schedule",
			action: "schedule_occurrence_skipped",
			subject: `schedule:${spec.id}`,
			args: { occurrenceKey, reason },
		});
		return { status: "skipped", run, queueEntryId: null };
	}
}
