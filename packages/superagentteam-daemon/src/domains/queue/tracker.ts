// F018 R2-a InvocationTracker (0007 §3.4): in-process execution slots.
// Process-local by design — durable truth is TurnExecution.status; the real
// execution mutex is the attempt active-delivery uniqueness + worker layer.

export type SlotState = "active" | "absent";

export interface InvocationSlot {
	threadId: string;
	agentId: string;
	userId: string;
	turnExecutionId: string;
	controller: AbortController;
	startedAt: number;
}

export interface StaleSlot {
	threadId: string;
	agentId: string;
	userId: string;
	turnExecutionId: string;
	startedAt: number;
	ageMs: number;
}

export class InvocationTracker {
	private readonly slots = new Map<string, InvocationSlot>();
	private readonly clock: () => number;

	constructor(clock: () => number = Date.now) {
		this.clock = clock;
	}

	private key(threadId: string, agentId: string): string {
		return `${threadId}\u0000${agentId}`;
	}

	/** Preempt semantics: same slot's old controller is aborted first. */
	start(threadId: string, agentId: string, userId: string, turnExecutionId: string): AbortController {
		const key = this.key(threadId, agentId);
		const existing = this.slots.get(key);
		if (existing) existing.controller.abort();
		const controller = new AbortController();
		this.slots.set(key, {
			threadId,
			agentId,
			userId,
			turnExecutionId,
			controller,
			startedAt: this.clock(),
		});
		return controller;
	}

	/** All-or-nothing: if any target's slot is busy, nothing is started. */
	startAll(
		threadId: string,
		targets: ReadonlyArray<{ agentId: string; turnExecutionId: string }>,
		userId: string,
	): Map<string, AbortController> | { error: "slot_busy"; agentId: string } {
		for (const target of targets) {
			if (this.slots.has(this.key(threadId, target.agentId))) {
				return { error: "slot_busy", agentId: target.agentId };
			}
		}
		const controllers = new Map<string, AbortController>();
		for (const target of targets) {
			controllers.set(target.agentId, this.start(threadId, target.agentId, userId, target.turnExecutionId));
		}
		return controllers;
	}

	/** Ownership fence: only releases the slot matching turnExecutionId. */
	complete(threadId: string, agentId: string, turnExecutionId?: string): boolean {
		const key = this.key(threadId, agentId);
		const slot = this.slots.get(key);
		if (!slot) return false;
		if (turnExecutionId !== undefined && slot.turnExecutionId !== turnExecutionId) return false;
		this.slots.delete(key);
		return true;
	}

	completeAll(threadId: string, agentIds: readonly string[], turnExecutionId?: string): number {
		let released = 0;
		for (const agentId of agentIds) {
			if (this.complete(threadId, agentId, turnExecutionId)) released += 1;
		}
		return released;
	}

	/** Cancel-and-release: signals the controller, then drops the slot. */
	cancel(threadId: string, agentId: string): boolean {
		const key = this.key(threadId, agentId);
		const slot = this.slots.get(key);
		if (!slot) return false;
		slot.controller.abort();
		this.slots.delete(key);
		return true;
	}

	cancelAll(threadId: string): string[] {
		const canceled: string[] = [];
		for (const slot of [...this.slots.values()]) {
			if (slot.threadId === threadId) {
				this.cancel(slot.threadId, slot.agentId);
				canceled.push(slot.agentId);
			}
		}
		return canceled;
	}

	has(threadId: string, agentId?: string): boolean {
		if (agentId === undefined) {
			return [...this.slots.values()].some((slot) => slot.threadId === threadId);
		}
		return this.slots.has(this.key(threadId, agentId));
	}

	isBusy(threadId: string, agentId: string): boolean {
		return this.slots.has(this.key(threadId, agentId));
	}

	getSlotState(threadId: string, agentId: string): SlotState {
		return this.slots.has(this.key(threadId, agentId)) ? "active" : "absent";
	}

	getController(threadId: string, agentId: string): AbortController | undefined {
		return this.slots.get(this.key(threadId, agentId))?.controller;
	}

	getExecutionId(threadId: string, agentId: string): string | undefined {
		return this.slots.get(this.key(threadId, agentId))?.turnExecutionId;
	}

	getActiveSlots(threadId: string): Array<{ agentId: string; turnExecutionId: string; startedAt: number }> {
		return [...this.slots.values()]
			.filter((slot) => slot.threadId === threadId)
			.map((slot) => ({ agentId: slot.agentId, turnExecutionId: slot.turnExecutionId, startedAt: slot.startedAt }));
	}

	listStaleSlots(now: number, minAgeMs = 0): StaleSlot[] {
		return [...this.slots.values()]
			.map((slot) => ({
				threadId: slot.threadId,
				agentId: slot.agentId,
				userId: slot.userId,
				turnExecutionId: slot.turnExecutionId,
				startedAt: slot.startedAt,
				ageMs: now - slot.startedAt,
			}))
			.filter((slot) => slot.ageMs >= minAgeMs);
	}
}
