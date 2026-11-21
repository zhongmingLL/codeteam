import { useEffect, useRef } from "react";

import { useSessionStore } from "@/domains/session/store";

import {
	CHANGE_TOPICS,
	type ChangeTopic,
	connectThreadEvents,
	type EventSourceFactory,
	type ThreadChangeEvent,
} from "./client.ts";
import { useEventStore } from "./store.ts";

const ALL_TOPICS: ChangeTopic[] = [...CHANGE_TOPICS];
const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_DEBOUNCE_MS = 100;

export interface UseThreadEventsOptions {
	threadId?: string;
	onRefresh: (topics: readonly ChangeTopic[]) => void;
	createSource?: EventSourceFactory;
	probeSession?: () => Promise<"ok" | "unauthorized" | "unavailable">;
	reconnectBaseMs?: number;
	reconnectMaxMs?: number;
	debounceMs?: number;
}

const defaultProbe = (): Promise<"ok" | "unauthorized" | "unavailable"> => useSessionStore.getState().probe();

export function useThreadEvents(options: UseThreadEventsOptions): void {
	const {
		threadId,
		onRefresh,
		createSource,
		probeSession = defaultProbe,
		reconnectBaseMs = DEFAULT_RECONNECT_BASE_MS,
		reconnectMaxMs = DEFAULT_RECONNECT_MAX_MS,
		debounceMs = DEFAULT_DEBOUNCE_MS,
	} = options;
	const refreshRef = useRef(onRefresh);
	refreshRef.current = onRefresh;
	const begin = useEventStore((state) => state.begin);
	const setStatus = useEventStore((state) => state.setStatus);
	const reset = useEventStore((state) => state.reset);

	useEffect(() => {
		if (!threadId) return;
		begin(threadId);
		let disposed = false;
		let closeSource: (() => void) | undefined;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		let flushTimer: ReturnType<typeof setTimeout> | undefined;
		let delay = reconnectBaseMs;
		let attempt = 0;
		let connected = false;
		let errorInFlight = false;
		const pending = new Set<ChangeTopic>();

		const flush = (): void => {
			flushTimer = undefined;
			if (disposed || pending.size === 0) return;
			const topics = [...pending];
			pending.clear();
			refreshRef.current(topics);
		};

		const scheduleFlush = (): void => {
			if (flushTimer === undefined) flushTimer = setTimeout(flush, debounceMs);
		};

		const refreshAll = (): void => refreshRef.current(ALL_TOPICS);

		const handleError = async (): Promise<void> => {
			let result: "ok" | "unauthorized" | "unavailable";
			try {
				result = await probeSession();
			} catch {
				result = "unavailable";
			}
			if (disposed) return;
			setStatus("fallback");
			if (result === "unauthorized") return;
			if (retryTimer !== undefined) return;
			retryTimer = setTimeout(() => {
				retryTimer = undefined;
				connect();
			}, delay);
			delay = Math.min(delay * 2, reconnectMaxMs);
		};

		const connect = (): void => {
			if (disposed) return;
			closeSource?.();
			connected = false;
			setStatus(attempt === 0 ? "connecting" : "fallback");
			attempt += 1;
			closeSource = connectThreadEvents(
				threadId,
				{
					onReady() {
						if (disposed) return;
						connected = true;
						attempt = 0;
						delay = reconnectBaseMs;
						setStatus("live");
						refreshAll();
					},
					onChange(event: ThreadChangeEvent) {
						for (const topic of event.topics) pending.add(topic);
						scheduleFlush();
					},
					onError() {
						if (disposed) return;
						closeSource?.();
						closeSource = undefined;
						connected = false;
						setStatus("fallback");
						if (errorInFlight) return;
						errorInFlight = true;
						void handleError().finally(() => {
							errorInFlight = false;
						});
					},
				},
				createSource,
			);
		};

		connect();
		const onVisibility = (): void => {
			if (document.hidden || disposed) return;
			refreshAll();
			if (!connected && retryTimer === undefined) connect();
		};
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			disposed = true;
			closeSource?.();
			if (retryTimer !== undefined) clearTimeout(retryTimer);
			if (flushTimer !== undefined) clearTimeout(flushTimer);
			document.removeEventListener("visibilitychange", onVisibility);
			reset(threadId);
		};
	}, [threadId, createSource, probeSession, reconnectBaseMs, reconnectMaxMs, debounceMs, begin, setStatus, reset]);
}
