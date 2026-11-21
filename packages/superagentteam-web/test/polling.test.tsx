import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePolling } from "@/lib/polling";

const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");

function setHidden(hidden: boolean): void {
	Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	if (originalHidden) Object.defineProperty(document, "hidden", originalHidden);
});

describe("usePolling", () => {
	it("never overlaps slow polls", async () => {
		let finish: (value: boolean) => void = () => {};
		const task = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					finish = resolve;
				}),
		);
		renderHook(() => usePolling(task, { intervalMs: 1000, runImmediately: false }));

		await vi.advanceTimersByTimeAsync(1000);
		expect(task).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(3000);
		expect(task).toHaveBeenCalledTimes(1);

		finish(true);
		await vi.advanceTimersByTimeAsync(1000);
		expect(task).toHaveBeenCalledTimes(2);
	});

	it("backs failed polls off exponentially up to the cap", async () => {
		const task = vi.fn(async () => false);
		renderHook(() =>
			usePolling(task, { intervalMs: 10_000, maxBackoffMs: 30_000, runImmediately: false }),
		);

		await vi.advanceTimersByTimeAsync(10_000);
		expect(task).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(task).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(task).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(task).toHaveBeenCalledTimes(4);
	});

	it("pauses while the page is hidden and refreshes when visible", async () => {
		const task = vi.fn(async () => true);
		setHidden(true);
		renderHook(() => usePolling(task, { intervalMs: 1000, runImmediately: false }));

		await vi.advanceTimersByTimeAsync(3000);
		expect(task).not.toHaveBeenCalled();

		setHidden(false);
		document.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(0);
		expect(task).toHaveBeenCalledTimes(1);
	});
});
