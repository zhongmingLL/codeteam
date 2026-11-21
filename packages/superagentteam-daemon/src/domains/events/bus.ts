export type ChangeTopic = "messages" | "queue" | "live" | "thread";

export interface ChangeEvent {
	threadId: string;
	topics: ChangeTopic[];
	at: number;
}

export type ChangeListener = (event: ChangeEvent) => void;

/**
 * In-process invalidation bus. It carries no truth: listeners must refetch the
 * HTTP read model after receiving an event.
 */
export class ChangeBus {
	private readonly listeners = new Map<string, Set<ChangeListener>>();

	subscribe(threadId: string, listener: ChangeListener): () => void {
		let listeners = this.listeners.get(threadId);
		if (!listeners) {
			listeners = new Set();
			this.listeners.set(threadId, listeners);
		}
		listeners.add(listener);
		return () => {
			const current = this.listeners.get(threadId);
			if (!current) return;
			current.delete(listener);
			if (current.size === 0) this.listeners.delete(threadId);
		};
	}

	publish(threadId: string, topics: readonly ChangeTopic[], at = Date.now()): void {
		const unique = [...new Set(topics)];
		if (unique.length === 0) return;
		const event: ChangeEvent = { threadId, topics: unique, at };
		for (const listener of [...(this.listeners.get(threadId) ?? [])]) {
			try {
				listener(event);
			} catch {
				// One broken stream must not hide changes from other subscribers.
			}
		}
	}

	subscriberCount(threadId: string): number {
		return this.listeners.get(threadId)?.size ?? 0;
	}
}
