import { describe, expect, it, vi } from "vitest";

import { ChangeBus } from "../src/domains/events/bus.ts";

describe("ChangeBus", () => {
	it("publishes deduped topics to subscribers and unsubscribes cleanly", () => {
		const bus = new ChangeBus();
		const listener = vi.fn();
		const unsubscribe = bus.subscribe("thread:1", listener);

		bus.publish("thread:1", ["messages", "messages", "queue"], 42);

		expect(listener).toHaveBeenCalledWith({
			threadId: "thread:1",
			topics: ["messages", "queue"],
			at: 42,
		});
		expect(bus.subscriberCount("thread:1")).toBe(1);
		unsubscribe();
		expect(bus.subscriberCount("thread:1")).toBe(0);
		bus.publish("thread:1", ["live"], 43);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("isolates a throwing subscriber from the others", () => {
		const bus = new ChangeBus();
		const healthy = vi.fn();
		bus.subscribe("thread:1", () => {
			throw new Error("broken sink");
		});
		bus.subscribe("thread:1", healthy);

		expect(() => bus.publish("thread:1", ["live"])).not.toThrow();
		expect(healthy).toHaveBeenCalledTimes(1);
	});
});
