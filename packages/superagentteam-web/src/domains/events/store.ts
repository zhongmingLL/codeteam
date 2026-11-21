import { create } from "zustand";

export type RealtimeStatus = "idle" | "connecting" | "live" | "fallback";

export interface EventState {
	threadId: string | null;
	status: RealtimeStatus;
	begin(threadId: string): void;
	setStatus(status: RealtimeStatus): void;
	reset(threadId?: string): void;
}

export const useEventStore = create<EventState>((set) => ({
	threadId: null,
	status: "idle",
	begin(threadId) {
		set({ threadId, status: "connecting" });
	},
	setStatus(status) {
		set({ status });
	},
	reset(threadId) {
		set((state) =>
			threadId === undefined || state.threadId === threadId ? { threadId: null, status: "idle" } : state,
		);
	},
}));
