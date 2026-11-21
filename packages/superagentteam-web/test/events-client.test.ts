import { describe, expect, it, vi } from "vitest";

import { connectThreadEvents, type EventSourceLike, parseChangeEvent } from "@/domains/events/client";

class MockEventSource implements EventSourceLike {
	readonly listeners = new Map<string, Set<(event: Event) => void>>();
	onerror: ((event: Event) => void) | null = null;
	closed = false;

	constructor(readonly url: string) {}

	addEventListener(type: string, listener: (event: Event) => void): void {
		let listeners = this.listeners.get(type);
		if (!listeners) {
			listeners = new Set();
			this.listeners.set(type, listeners);
		}
		listeners.add(listener);
	}

	removeEventListener(type: string, listener: (event: Event) => void): void {
		this.listeners.get(type)?.delete(listener);
	}

	close(): void {
		this.closed = true;
	}

	emit(type: string, data?: string): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(new MessageEvent(type, { data }));
		}
	}

	fail(): void {
		this.onerror?.(new Event("error"));
	}
}

describe("thread event client", () => {
	it("connects to the active thread, parses ready/change, and closes cleanly", () => {
		let source: MockEventSource | undefined;
		const handlers = { onReady: vi.fn(), onChange: vi.fn(), onError: vi.fn() };
		const close = connectThreadEvents("thread:1", handlers, (url) => {
			source = new MockEventSource(url);
			return source;
		});

		expect(source?.url).toBe("/api/events?threadId=thread%3A1");
		source?.emit("ready");
		source?.emit("change", JSON.stringify({ threadId: "thread:1", topics: ["messages", "queue"], at: 1 }));
		source?.emit("change", JSON.stringify({ threadId: "thread:2", topics: ["live"], at: 1 }));
		source?.emit("change", "not-json");
		source?.fail();
		close();

		expect(handlers.onReady).toHaveBeenCalledTimes(1);
		expect(handlers.onChange).toHaveBeenCalledWith({
			threadId: "thread:1",
			topics: ["messages", "queue"],
			at: 1,
		});
		expect(handlers.onChange).toHaveBeenCalledTimes(1);
		expect(handlers.onError).toHaveBeenCalledTimes(1);
		expect(source?.closed).toBe(true);
	});

	it("drops unknown topics and invalid envelopes", () => {
		expect(parseChangeEvent(JSON.stringify({ threadId: "t", topics: ["messages", "bogus"], at: 1 }))).toEqual({
			threadId: "t",
			topics: ["messages"],
			at: 1,
		});
		expect(parseChangeEvent(JSON.stringify({ threadId: "t", topics: ["bogus"], at: 1 }))).toBeNull();
		expect(parseChangeEvent(JSON.stringify({ threadId: 1, topics: ["messages"], at: 1 }))).toBeNull();
		expect(parseChangeEvent("not-json")).toBeNull();
	});
});
