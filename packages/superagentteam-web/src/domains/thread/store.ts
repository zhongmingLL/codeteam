import { create } from "zustand";

import { type CreateThreadInput, type ThreadApi, type ThreadView, threadApi } from "./api.ts";

export type ThreadListStatus = "loading" | "ready" | "error";

export interface ThreadState {
	threads: ThreadView[];
	status: ThreadListStatus;
	error?: string;
	query: string;
	load(): Promise<void>;
	refresh(): Promise<void>;
	create(input: CreateThreadInput): Promise<ThreadView>;
	setQuery(query: string): void;
}

export interface ThreadStoreDeps {
	api: Pick<ThreadApi, "list" | "create">;
}

export function createThreadStore(deps: ThreadStoreDeps) {
	return create<ThreadState>((set) => ({
		threads: [],
		status: "loading",
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
				set({ threads: body.threads, status: "ready", error: undefined });
			} catch (error) {
				set({ status: "error", error: error instanceof Error ? error.message : "无法加载对话" });
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
	}));
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
