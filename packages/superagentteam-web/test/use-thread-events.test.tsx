import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EventSourceLike } from "@/domains/events/client";
import { useEventStore } from "@/domains/events/store";
import { useThreadEvents } from "@/domains/events/use-thread-events";

class MockEventSource implements EventSourceLike {
	readonly listeners = new Map<string, Set<(event: Event) => void>>();
	onerror: ((event: Event) => void) | null = null;
	closed = false;

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

beforeEach(() => {
	vi.useFakeTimers();
	useEventStore.getState().reset();
});

afterEach(() => {
	vi.useRealTimers();
	useEventStore.getState().reset();
});

describe("useThreadEvents", () => {
	it("goes live on ready, debounces changes, and refetches all topics", async () => {
		const sources: MockEventSource[] = [];
		const onRefresh = vi.fn();
		renderHook(() =>
			useThreadEvents({
				threadId: "thread:1",
				onRefresh,
				createSource: () => {
					const source = new MockEventSource();
					sources.push(source);
					return source;
				},
				probeSession: async () => "ok",
				debounceMs: 20,
			}),
		);

		expect(useEventStore.getState()).toMatchObject({ threadId: "thread:1", status: "connecting" });
		sources[0]?.emit("ready");
		expect(useEventStore.getState().status).toBe("live");
		expect(onRefresh).toHaveBeenLastCalledWith(["messages", "queue", "live", "thread"]);

		sources[0]?.emit("change", JSON.stringify({ threadId: "thread:1", topics: ["messages"], at: 1 }));
		sources[0]?.emit("change", JSON.stringify({ threadId: "thread:1", topics: ["queue", "live"], at: 2 }));
		expect(onRefresh).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(20);
		expect(onRefresh).toHaveBeenLastCalledWith(["messages", "queue", "live"]);
	});

	it("falls back on error, probes the session, and retries with backoff", async () => {
		const sources: MockEventSource[] = [];
		const probe = vi.fn(async () => "ok" as const);
		renderHook(() =>
			useThreadEvents({
				threadId: "thread:1",
				onRefresh: () => {},
				createSource: () => {
					const source = new MockEventSource();
					sources.push(source);
					return source;
				},
				probeSession: probe,
				reconnectBaseMs: 100,
			}),
		);
		sources[0]?.emit("ready");

		sources[0]?.fail();
		await vi.runAllTicks();
		expect(probe).toHaveBeenCalledTimes(1);
		expect(useEventStore.getState().status).toBe("fallback");
		expect(sources).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(100);
		expect(sources).toHaveLength(2);
		sources[1]?.emit("ready");
		expect(useEventStore.getState().status).toBe("live");
	});

	it("stops retrying when the session probe says unauthorized", async () => {
		const sources: MockEventSource[] = [];
		renderHook(() =>
			useThreadEvents({
				threadId: "thread:1",
				onRefresh: () => {},
				createSource: () => {
					const source = new MockEventSource();
					sources.push(source);
					return source;
				},
				probeSession: async () => "unauthorized",
				reconnectBaseMs: 100,
			}),
		);
		sources[0]?.fail();
		await vi.runAllTicks();
		expect(useEventStore.getState().status).toBe("fallback");

		await vi.advanceTimersByTimeAsync(500);
		expect(sources).toHaveLength(1);
	});
});
