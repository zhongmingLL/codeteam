import { api } from "@/lib/api";
import type { ApiClient } from "@/lib/api/client.ts";

export interface QueueEntryView {
	queueEntryId: string;
	sourceRecordId: string;
	status: "queued" | "claimed";
	priority: "urgent" | "normal";
	position: number;
	targetAgentIds: string[];
	claimedBy: string | null;
	enqueuedAt: number;
	updatedAt: number;
}

export type LiveChildStatus = "running" | "completed" | "failed" | "interrupted" | "canceled";
export type LiveResponseStatus = "processing" | "completed" | "failed" | "interrupted" | "canceled" | "missing";

export interface LiveInvocationView {
	agentId: string;
	turnExecutionId: string;
	parentInvocationId: string | null;
	startedAt: number;
	childStatus: LiveChildStatus;
	responseStatus: LiveResponseStatus;
	evidenceRank: "record+tracker" | "tracker-only" | "record-only";
}

export interface QueueSnapshot {
	threadId: string;
	cap: { perKind: number };
	queue: QueueEntryView[];
	entries: QueueEntryView[];
	activeInvocations: LiveInvocationView[];
}

export interface LiveSnapshot {
	threadId: string;
	invocations: LiveInvocationView[];
}

export interface A2AApi {
	queue(threadId: string): Promise<QueueSnapshot>;
	live(threadId: string): Promise<LiveSnapshot>;
}

export function createA2AApi(client: Pick<ApiClient, "get">): A2AApi {
	return {
		queue: (threadId) => client.get<QueueSnapshot>(`/api/threads/${encodeURIComponent(threadId)}/queue`),
		live: (threadId) => client.get<LiveSnapshot>(`/api/threads/${encodeURIComponent(threadId)}/live`),
	};
}

export const a2aApi = createA2AApi(api);
