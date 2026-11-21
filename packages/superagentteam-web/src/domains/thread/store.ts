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
	markRead(threadId: string, messageId?: string): Promise<boolean>;
	setQuery(query: string): void;
}

export interface ThreadStoreDeps {
	api: Pick<ThreadApi, "list" | "get" | "create" | "markRead">;
}

export function createThreadStore(deps: ThreadStoreDeps) {
	return create<ThreadState>((set, get) => {
		let listSeq = 0;
		let detailSeq = 0;
		return {
			threads: [],
			status: "loading",
			detail: undefined,
			detailStatus: "idle",
			detailError: undefined,
			query: "",
			async load() {
				const seq = ++listSeq;
				set({ status: "loading", error: undefined });
				try {
					const body = await deps.api.list();
					if (seq !== listSeq) return;
					set({ threads: body.threads, status: "ready", error: undefined });
				} catch (error) {
					if (seq !== listSeq) return;
					set({ status: "error", error: error instanceof Error ? error.message : "无法加载对话" });
				}
			},
			async refresh() {
				const seq = ++listSeq;
				try {
					const body = await deps.api.list();
					if (seq !== listSeq) return true;
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
					if (seq !== listSeq) return true;
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
				listSeq += 1;
				set((state) => ({ threads: [thread, ...state.threads.filter((item) => item.id !== thread.id)] }));
				return thread;
			},
			async markRead(threadId, messageId) {
				// Invalidate list reads that started before this write; they may
				// carry the pre-read unread count.
				listSeq += 1;
				const previous = get().threads.find((thread) => thread.id === threadId)?.unreadCount ?? 0;
				const previousDetail = get().detail?.id === threadId ? (get().detail?.unreadCount ?? 0) : undefined;
				set((state) => ({
					threads: state.threads.map((thread) =>
						thread.id === threadId ? { ...thread, unreadCount: 0 } : thread,
					),
					...(state.detail?.id === threadId && state.detail
						? { detail: { ...state.detail, unreadCount: 0 } }
						: {}),
				}));
				try {
					const receipt = await deps.api.markRead(threadId, messageId);
					// Also invalidate list reads started during the write; only
					// post-commit reads are authoritative.
					listSeq += 1;
					set((state) => ({
						threads: state.threads.map((thread) =>
							thread.id === threadId ? { ...thread, unreadCount: receipt.unreadCount } : thread,
						),
						...(state.detail?.id === threadId && state.detail
							? { detail: { ...state.detail, unreadCount: receipt.unreadCount } }
							: {}),
					}));
					return true;
				} catch {
					listSeq += 1;
					set((state) => ({
						threads: state.threads.map((thread) =>
							thread.id === threadId ? { ...thread, unreadCount: previous } : thread,
						),
						...(state.detail?.id === threadId && state.detail
							? { detail: { ...state.detail, unreadCount: previousDetail ?? 0 } }
							: {}),
					}));
					return false;
				}
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
