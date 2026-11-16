import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import type { CreateWaitInput, TerminateWaitInput, Wait, WaitKind, WaitTermination } from "../control/stores/types.ts";

const WAIT_KINDS = new Set<WaitKind>(["timer", "event", "managed_command"]);
const WAIT_SOURCE_REF = /^[a-z][a-z0-9_-]*:.+$/;

export interface ArmWaitInput {
	readonly waitId: string;
	readonly generation: number;
	readonly subjectRef: string;
	readonly kind: WaitKind;
	readonly waitSourceRef: string;
	readonly expectedSignal?: string | null;
	readonly baseline?: Record<string, unknown>;
	readonly continuation?: Record<string, unknown>;
	readonly ownerFence: Record<string, unknown>;
	readonly expiresAt?: number | null;
	readonly autoRenew?: boolean;
	readonly slaUntil: number;
	readonly approvalId?: string | null;
}

function nonEmpty(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new ControlError("invalid_input", `${field} is required`);
	}
	return value;
}

function positiveInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new ControlError("invalid_input", `${field} must be a positive integer`);
	}
	return value;
}

export class WaitContractService {
	private readonly store: ControlStore;
	private readonly clock: () => number;

	constructor(store: ControlStore, clock: () => number = Date.now) {
		this.store = store;
		this.clock = clock;
	}

	arm(input: ArmWaitInput): Wait {
		if (!WAIT_KINDS.has(input.kind)) throw new ControlError("invalid_input", `unknown wait kind ${input.kind}`);
		const waitSourceRef = nonEmpty(input.waitSourceRef, "waitSourceRef");
		if (!WAIT_SOURCE_REF.test(waitSourceRef)) {
			throw new ControlError("invalid_input", "waitSourceRef must be <kind>:<id>");
		}
		const slaUntil = positiveInteger(input.slaUntil, "slaUntil");
		if (slaUntil <= this.clock()) throw new ControlError("invalid_input", "slaUntil must be in the future");
		if (input.expiresAt !== undefined && input.expiresAt !== null) {
			positiveInteger(input.expiresAt, "expiresAt");
		}
		const expectedSignal =
			input.expectedSignal === undefined || input.expectedSignal === null
				? null
				: nonEmpty(input.expectedSignal, "expectedSignal");
		if ((input.kind === "event" || input.kind === "managed_command") && !expectedSignal) {
			throw new ControlError("invalid_input", `${input.kind} waits require expectedSignal`);
		}
		const subjectRef = nonEmpty(input.subjectRef, "subjectRef");
		const ownerFence = this.validateOwnerFence(input.ownerFence);
		this.assertSubjectFenceMatch(subjectRef, ownerFence);
		const create: CreateWaitInput = {
			waitId: nonEmpty(input.waitId, "waitId"),
			generation: positiveInteger(input.generation, "generation"),
			subjectRef,
			kind: input.kind,
			waitSourceRef,
			expectedSignal,
			baseline: input.baseline ?? {},
			continuation: input.continuation ?? {},
			ownerFence,
			expiresAt: input.expiresAt ?? null,
			autoRenew: input.autoRenew,
			slaUntil,
			approvalId: input.approvalId ?? null,
		};
		return this.store.waits.create(create);
	}

	terminate(input: TerminateWaitInput): WaitTermination {
		const wait = this.store.waits.getBySeries(input.waitId, input.generation);
		if (!wait) throw new ControlError("not_found", `wait ${input.waitId}:g${input.generation} not found`);
		if (input.reason === "user_cancel") {
			const actorKind = input.actor.kind;
			const actorId = input.actor.id;
			if (actorKind !== "user" || typeof actorId !== "string") {
				throw new ControlError("forbidden", "user_cancel requires a user actor");
			}
			const ownerUserId = this.ownerUserId(wait.ownerFence);
			if (ownerUserId !== actorId) {
				throw new ControlError("forbidden", "user_cancel actor must be the wait owner");
			}
		}
		return this.store.waits.terminate(input);
	}

	private validateOwnerFence(value: Record<string, unknown>): Record<string, unknown> {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new ControlError("invalid_input", "ownerFence must be an object");
		}
		if (value.kind === "containing_task") {
			const taskId = nonEmpty(value.taskId, "ownerFence.taskId");
			if (!this.store.tasks.get(taskId)) throw new ControlError("not_found", `task ${taskId} not found`);
			return { kind: "containing_task", taskId };
		}
		if (value.kind === "action_successor") {
			const handoffId = nonEmpty(value.handoffId, "ownerFence.handoffId");
			if (!this.store.handoffs.get(handoffId)) {
				throw new ControlError("not_found", `handoff ${handoffId} not found`);
			}
			const fence: Record<string, unknown> = { kind: "action_successor", handoffId };
			if (value.leaseId !== undefined) fence.leaseId = nonEmpty(value.leaseId, "ownerFence.leaseId");
			return fence;
		}
		throw new ControlError("invalid_input", "ownerFence.kind must be containing_task or action_successor");
	}

	private assertSubjectFenceMatch(subjectRef: string, fence: Record<string, unknown>): void {
		if (subjectRef.startsWith("handoff:")) {
			const handoffId = subjectRef.slice("handoff:".length);
			if (fence.kind !== "action_successor" || fence.handoffId !== handoffId) {
				throw new ControlError("invalid_input", "handoff wait requires a matching action_successor fence");
			}
			return;
		}
		if (subjectRef.startsWith("task:")) {
			const taskId = subjectRef.slice("task:".length);
			if (fence.kind !== "containing_task" || fence.taskId !== taskId) {
				throw new ControlError("invalid_input", "task wait requires a matching containing_task fence");
			}
		}
	}

	private ownerUserId(fence: Record<string, unknown>): string | null {
		if (fence.kind === "containing_task" && typeof fence.taskId === "string") {
			return this.store.tasks.get(fence.taskId)?.userId ?? null;
		}
		if (fence.kind === "action_successor" && typeof fence.handoffId === "string") {
			return this.store.handoffs.get(fence.handoffId)?.ownerUserId ?? null;
		}
		return null;
	}
}
