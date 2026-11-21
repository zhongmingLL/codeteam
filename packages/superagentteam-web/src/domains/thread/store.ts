import { create } from "zustand";
import { ApiError } from "@/lib/api/client.ts";
import { type CreateThreadInput, type ThreadApi, type ThreadView, threadApi } from "./api.ts";

export type ThreadListStatus = "loading" | "ready" | "error";
export type ThreadDetailStatus = "idle" | "loading" | "ready" | "error" | "not_found";

export interface ThreadState {
	threads: ThreadView[];
	status: ThreadListStatus;
	error?: string;
	detail?: ThreadView;
	detailStatus: ThreadDetailStatus;
	detailError?: string;
	query: string;
	load(): Promise<void>;
	refresh(): Promise<boolean>;
	loadDetail(threadId: string): Promise<boolean>;
	create(input: CreateThreadInput): Promise<ThreadView>;
	setQuery(query: string): void;
}

export interface ThreadStoreDeps {
	api: Pick<ThreadApi, "list" | "get" | "create">;
}

export function createThreadStore(deps: ThreadStoreDeps) {
	return create<ThreadState>((set) => {
		let detailSeq = 0;
		return {
			threads: [],
			status: "loading",
			detail: undefined,
			detailStatus: "idle",
			detailError: undefined,
			query: "",
			async load() {
				set({ status: "loading", error: undefined });
				try {
					const body = await deps.api.list();
					set({ threads: body.threads, status: "ready", error: undefined });
				} catch (error) {
					set({ status: "error", error: error instanceof Error ? error.message : "无法加载对话" });
				}
			},
			async refresh() {
				try {
					const body = await deps.api.list();
					set((state) => {
						const currentDetail = state.detail;
						const nextDetail = currentDetail
							? (body.threads.find((thread) => thread.id === currentDetail.id) ?? currentDetail)
							: undefined;
						return {
							threads: body.threads,
							status: "ready",
							error: undefined,
							...(nextDetail ? { detail: nextDetail } : {}),
						};
					});
					return true;
				} catch (error) {
					set((state) => ({
						status: state.threads.length === 0 ? "error" : "ready",
						error: error instanceof Error ? error.message : "无法加载对话",
					}));
					return false;
				}
			},
			async loadDetail(threadId) {
				const seq = ++detailSeq;
				set((state) => ({
					detail: state.detail?.id === threadId ? state.detail : undefined,
					detailStatus: "loading",
					detailError: undefined,
				}));
				try {
					const thread = await deps.api.get(threadId);
					if (seq !== detailSeq) return false;
					set({ detail: thread, detailStatus: "ready", detailError: undefined });
					return true;
				} catch (error) {
					if (seq !== detailSeq) return false;
					if (error instanceof ApiError && error.status === 404) {
						set({ detail: undefined, detailStatus: "not_found", detailError: undefined });
						return false;
					}
					set({
						detailStatus: "error",
						detailError: error instanceof Error ? error.message : "无法加载对话",
					});
					return false;
				}
			},
			async create(input) {
				const thread = await deps.api.create(input);
				set((state) => ({ threads: [thread, ...state.threads.filter((item) => item.id !== thread.id)] }));
				return thread;
			},
			setQuery(query) {
				set({ query });
			},
		};
	});
}

export function filterThreads(threads: ThreadView[], rawQuery: string): ThreadView[] {
	const query = rawQuery.trim().toLocaleLowerCase();
	if (query === "") return threads;
	return threads.filter((thread) => {
		const title = (thread.title ?? "").toLocaleLowerCase();
		const project = thread.projectPath.toLocaleLowerCase();
		return title.includes(query) || project.includes(query);
	});
}

export function selectFilteredThreads(state: ThreadState): ThreadView[] {
	return filterThreads(state.threads, state.query);
}

export const useThreadStore = createThreadStore({ api: threadApi });
