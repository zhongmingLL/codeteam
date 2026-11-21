import { create } from "zustand";
import { ApiError } from "@/lib/api/client";

import { type A2AApi, a2aApi, type LiveInvocationView, type QueueEntryView } from "./api.ts";

export type A2AStatus = "idle" | "loading" | "ready" | "error";

export interface A2AState {
	threadId: string | null;
	queue: QueueEntryView[];
	live: LiveInvocationView[];
	cap?: number;
	status: A2AStatus;
	error?: string;
	load(threadId: string): Promise<boolean>;
	refresh(): Promise<boolean>;
	retryInvocation(invocationId: string): Promise<void>;
	reset(): void;
}

export interface A2AStoreDeps {
	api: Pick<A2AApi, "queue" | "live" | "retryInvocation">;
}

function messageOf(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

export function createA2AStore(deps: A2AStoreDeps) {
	return create<A2AState>((set, get) => {
		let requestSeq = 0;

		const fetchSnapshot = async (threadId: string): Promise<boolean> => {
			const seq = ++requestSeq;
			try {
				const [queue, live] = await Promise.all([deps.api.queue(threadId), deps.api.live(threadId)]);
				if (seq !== requestSeq || get().threadId !== threadId) return false;
				set({
					queue: queue.queue,
					live: live.invocations,
					cap: queue.cap.perKind,
					status: "ready",
					error: undefined,
				});
				return true;
			} catch (error) {
				if (seq !== requestSeq || get().threadId !== threadId) return false;
				set({
					status: get().queue.length === 0 && get().live.length === 0 ? "error" : "ready",
					error: messageOf(error, "无法加载队列状态"),
				});
				return false;
			}
		};

		return {
			threadId: null,
			queue: [],
			live: [],
			cap: undefined,
			status: "idle",
			error: undefined,

			async load(threadId) {
				if (get().threadId !== threadId) {
					set({ threadId, queue: [], live: [], cap: undefined, status: "loading", error: undefined });
				}
				return fetchSnapshot(threadId);
			},

			async refresh() {
				const threadId = get().threadId;
				if (!threadId) return true;
				return fetchSnapshot(threadId);
			},

			async retryInvocation(invocationId) {
				const threadId = get().threadId;
				if (!threadId) throw new Error("没有打开的对话");
				try {
					await deps.api.retryInvocation(threadId, invocationId);
				} catch (error) {
					if (error instanceof ApiError) {
						if (error.code === "not_retryable") throw new Error("这条回复当前不能重试");
						if (error.code === "nothing_to_retry") throw new Error("没有可重试的目标");
						if (error.code === "retry_conflict") throw new Error("重试状态已变化，请刷新后再试");
					}
					throw error;
				}
				await fetchSnapshot(threadId);
			},

			reset() {
				requestSeq += 1;
				set({ threadId: null, queue: [], live: [], cap: undefined, status: "idle", error: undefined });
			},
		};
	});
}

export const useA2AStore = createA2AStore({ api: a2aApi });
