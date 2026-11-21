import { useEffect, useRef } from "react";

export interface PollingOptions {
	intervalMs: number;
	maxBackoffMs?: number;
	runImmediately?: boolean;
}

/**
 * Runs one refresh at a time. A successful task schedules the next poll at the
 * base interval; a failed task backs off exponentially up to maxBackoffMs.
 * Hidden pages pause polling and refresh as soon as they become visible again.
 */
export function usePolling(task: () => Promise<boolean>, options: PollingOptions): void {
	const { intervalMs, maxBackoffMs = 30_000, runImmediately = true } = options;
	const taskRef = useRef(task);
	taskRef.current = task;

	useEffect(() => {
		let cancelled = false;
		let running = false;
		let delay = intervalMs;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const schedule = (waitMs: number): void => {
			if (cancelled) return;
			timer = setTimeout(() => void tick(), waitMs);
		};

		const tick = async (): Promise<void> => {
			timer = undefined;
			if (cancelled || running) return;
			if (document.hidden) return;

			running = true;
			let ok = false;
			try {
				ok = await taskRef.current();
			} catch {
				ok = false;
			} finally {
				running = false;
			}
			if (cancelled) return;

			delay = ok ? intervalMs : Math.min(Math.max(delay * 2, intervalMs), maxBackoffMs);
			schedule(delay);
		};

		const onVisibility = (): void => {
			if (cancelled || running || document.hidden) return;
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
			delay = intervalMs;
			void tick();
		};

		if (runImmediately) void tick();
		else schedule(intervalMs);
		document.addEventListener("visibilitychange", onVisibility);

		return () => {
			cancelled = true;
			if (timer !== undefined) clearTimeout(timer);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [intervalMs, maxBackoffMs, runImmediately]);
}
