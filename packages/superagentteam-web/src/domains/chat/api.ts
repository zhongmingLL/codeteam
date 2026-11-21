import type {
	MessageContent,
	MessageFrom,
	MessageLifecycle,
	RichMessageExtra,
	StoredToolEvent,
} from "@superagentteam/shared/types";

import { api } from "@/lib/api";
import type { ApiClient } from "@/lib/api/client.ts";

export interface MessageView {
	id: string;
	threadId: string;
	type: "user" | "assistant" | "system" | "connector";
	from: MessageFrom;
	catId?: string;
	content: string;
	contentBlocks?: MessageContent[];
	toolEvents?: StoredToolEvent[];
	lifecycle?: MessageLifecycle;
	replyTo?: string;
	mentionsUser?: boolean;
	timestamp: number;
	updatedAt: number;
	thinking?: string;
	extra?: { rich?: RichMessageExtra } & Record<string, unknown>;
}

export interface MessageWindow {
	messages: MessageView[];
	hasMore: boolean;
	query_warnings?: string[];
}

export interface ListMessagesOptions {
	before?: string;
	limit?: number;
}

export interface SendMessageInput {
	threadId: string;
	content: string;
	idempotencyKey: string;
	targets?: string[];
}

export interface SendMessageReceipt {
	status: "queued";
	userMessageId: string;
	entryId?: string;
	queuePosition?: number;
	merged?: boolean;
	targetAgentIds?: string[];
}

export interface MessageApi {
	list(threadId: string, options?: ListMessagesOptions): Promise<MessageWindow>;
	send(input: SendMessageInput): Promise<SendMessageReceipt>;
}

export function createMessageApi(client: Pick<ApiClient, "get" | "post">): MessageApi {
	return {
		list(threadId, options = {}) {
			const query = new URLSearchParams({ threadId });
			if (options.before !== undefined) query.set("before", options.before);
			if (options.limit !== undefined) query.set("limit", String(options.limit));
			return client.get<MessageWindow>(`/api/messages?${query.toString()}`);
		},
		send(input) {
			return client.post<SendMessageReceipt>("/api/messages", input);
		},
	};
}

export const messageApi = createMessageApi(api);
