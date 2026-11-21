import type { Thread } from "@superagentteam/shared/types";

import { api } from "@/lib/api";
import type { ApiClient } from "@/lib/api/client.ts";

export type ThreadView = Thread;

export interface CreateThreadInput {
	projectPath: string;
	title?: string;
	idempotencyKey: string;
}

export interface ThreadApi {
	list(): Promise<{ threads: ThreadView[] }>;
	get(threadId: string): Promise<ThreadView>;
	create(input: CreateThreadInput): Promise<ThreadView>;
}

export function createThreadApi(client: Pick<ApiClient, "get" | "post">): ThreadApi {
	return {
		list: () => client.get<{ threads: ThreadView[] }>("/api/threads"),
		get: (threadId) => client.get<ThreadView>(`/api/threads/${encodeURIComponent(threadId)}`),
		create: (input) => client.post<ThreadView>("/api/threads", input),
	};
}

export const threadApi = createThreadApi(api);
