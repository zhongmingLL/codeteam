import { create } from "zustand";

import { type MessageApi, type MessageView, messageApi, type SendMessageReceipt } from "./api.ts";

export type ChatStatus = "idle" | "loading" | "ready" | "error";

export interface PendingUserMessage {
	messageId: string;
	content: string;
}

export interface ChatState {
	threadId: string | null;
	messages: MessageView[];
	status: ChatStatus;
	error?: string;
	hasMore: boolean;
	loadingOlder: boolean;
	followingLatest: boolean;
	pendingUserMessages: PendingUserMessage[];
	sending: boolean;
	loadLatest(threadId: string): Promise<boolean>;
	refresh(): Promise<boolean>;
	loadOlder(): Promise<boolean>;
	resumeLatest(): Promise<boolean>;
	send(content: string, idempotencyKey: string, targetAgentIds?: string[]): Promise<SendMessageReceipt>;
	reset(): void;
}

export interface ChatStoreDeps {
	api: Pick<MessageApi, "list" | "send">;
}

const MESSAGE_WINDOW_LIMIT = 50;

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

export function createChatStore(deps: ChatStoreDeps) {
	return create<ChatState>((set, get) => {
		let requestSeq = 0;

		const fetchLatest = async (threadId: string): Promise<boolean> => {
			const seq = ++requestSeq;
			try {
				const body = await deps.api.list(threadId, { limit: MESSAGE_WINDOW_LIMIT });
				if (seq !== requestSeq || get().threadId !== threadId) return false;
				const present = new Set(body.messages.map((message) => message.id));
				set((state) => ({
					messages: body.messages,
					hasMore: body.hasMore,
					status: "ready",
					error: undefined,
					loadingOlder: false,
					pendingUserMessages: state.pendingUserMessages.filter((pending) => !present.has(pending.messageId)),
				}));
				return true;
			} catch (error) {
				if (seq !== requestSeq || get().threadId !== threadId) return false;
				set((state) => ({
					status: state.messages.length === 0 ? "error" : "ready",
					error: errorMessage(error, "无法加载消息"),
				}));
				return false;
			}
		};

		return {
			threadId: null,
			messages: [],
			status: "idle",
			error: undefined,
			hasMore: false,
			loadingOlder: false,
			followingLatest: true,
			pendingUserMessages: [],
			sending: false,

			async loadLatest(threadId) {
				if (get().threadId !== threadId) {
					set({
						threadId,
						messages: [],
						status: "loading",
						error: undefined,
						hasMore: false,
						loadingOlder: false,
						followingLatest: true,
						pendingUserMessages: [],
					});
				} else if (get().messages.length === 0) {
					set({ status: "loading", error: undefined });
				}
				return fetchLatest(threadId);
			},

			async refresh() {
				const threadId = get().threadId;
				if (!threadId || !get().followingLatest) return true;
				return fetchLatest(threadId);
			},

			async loadOlder() {
				const state = get();
				if (!state.threadId || !state.hasMore || state.loadingOlder || state.messages.length === 0) return false;
				const first = state.messages[0];
				const before = `${first.timestamp}:${first.id}`;
				const threadId = state.threadId;
				const seq = ++requestSeq;
				set({ loadingOlder: true, error: undefined });
				try {
					const body = await deps.api.list(threadId, { limit: MESSAGE_WINDOW_LIMIT, before });
					if (seq !== requestSeq || get().threadId !== threadId) return false;
					if (body.query_warnings?.includes("invalid_cursor")) {
						set({ loadingOlder: false });
						return fetchLatest(threadId);
					}
					set((current) => ({
						messages: [...body.messages, ...current.messages],
						hasMore: body.hasMore,
						loadingOlder: false,
						followingLatest: false,
						error: undefined,
					}));
					return true;
				} catch (error) {
					if (seq !== requestSeq || get().threadId !== threadId) return false;
					set({ loadingOlder: false, error: errorMessage(error, "无法加载更早的消息") });
					return false;
				}
			},

			async resumeLatest() {
				const threadId = get().threadId;
				if (!threadId) return false;
				set({ followingLatest: true });
				return fetchLatest(threadId);
			},

			async send(content, idempotencyKey, targetAgentIds) {
				const threadId = get().threadId;
				if (!threadId) throw new Error("没有打开的对话");
				if (get().sending) throw new Error("正在发送上一条消息");
				set({ sending: true });
				try {
					const receipt = await deps.api.send({
						threadId,
						content,
						idempotencyKey,
						...(targetAgentIds && targetAgentIds.length > 0 ? { targets: targetAgentIds } : {}),
					});
					set((state) => ({
						sending: false,
						pendingUserMessages: [
							...state.pendingUserMessages.filter((pending) => pending.messageId !== receipt.userMessageId),
							{ messageId: receipt.userMessageId, content },
						],
					}));
					await get().refresh();
					return receipt;
				} catch (error) {
					set({ sending: false });
					throw error;
				}
			},

			reset() {
				requestSeq += 1;
				set({
					threadId: null,
					messages: [],
					status: "idle",
					error: undefined,
					hasMore: false,
					loadingOlder: false,
					followingLatest: true,
					pendingUserMessages: [],
					sending: false,
				});
			},
		};
	});
}

export const useChatStore = createChatStore({ api: messageApi });
