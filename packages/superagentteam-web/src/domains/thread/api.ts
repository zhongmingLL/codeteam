import type { Thread } from "@superagentteam/shared/types";

import { api } from "@/lib/api";
import type { ApiClient } from "@/lib/api/client.ts";

export type ThreadView = Thread & {
	/** Derived per-operator unread count; absent/0 means no badge. */
	unreadCount?: number;
};

export interface CreateThreadInput {
	projectPath: string;
	title?: string;
	idempotencyKey: string;
}

export interface ThreadApi {
	list(): Promise<{ threads: ThreadView[] }>;
	get(threadId: string): Promise<ThreadView>;
	create(input: CreateThreadInput): Promise<ThreadView>;
	markRead(threadId: string, messageId?: string): Promise<{ threadId: string; unreadCount: number }>;
}

export function createThreadApi(client: Pick<ApiClient, "get" | "post">): ThreadApi {
	return {
		list: () => client.get<{ threads: ThreadView[] }>("/api/threads"),
		get: (threadId) => client.get<ThreadView>(`/api/threads/${encodeURIComponent(threadId)}`),
		create: (input) => client.post<ThreadView>("/api/threads", input),
		markRead: (threadId, messageId) =>
			client.post<{ threadId: string; unreadCount: number }>(
				`/api/threads/${encodeURIComponent(threadId)}/read`,
				messageId === undefined ? {} : { messageId },
			),
	};
}

export const threadApi = createThreadApi(api);
