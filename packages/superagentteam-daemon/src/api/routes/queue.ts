import type { IncomingMessage, ServerResponse } from "node:http";

import type { QueueEntry } from "@superagentteam/shared/types";

import type { A2ARuntime } from "../../domains/a2a/runtime.ts";
import { getThreadLiveInvocations, type LiveInvocationView } from "../../domains/invocation/live.ts";
import { QUEUE_CAP_PER_KIND } from "../../domains/queue/store.ts";
import { sendError, sendJson } from "../http.ts";
import type { ApiRouteContext } from "./context.ts";

const QUEUE_PATH = /^\/api\/threads\/([^/]+)\/queue$/;

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

export interface QueueRoutes {
	handle(request: IncomingMessage, response: ServerResponse, url: URL, context: ApiRouteContext): boolean;
}

export interface QueueRoutesOptions {
	runtime: A2ARuntime;
}

function toView(entry: QueueEntry): QueueEntryView {
	return {
		queueEntryId: entry.queueEntryId,
		sourceRecordId: entry.payload.sourceRecordId,
		status: entry.status,
		priority: entry.priority,
		position: entry.position,
		targetAgentIds: entry.targets.filter((target) => target.kind === "agent").map((target) => target.id),
		claimedBy: entry.claim?.owner ?? null,
		enqueuedAt: entry.enqueuedAt,
		updatedAt: entry.updatedAt,
	};
}

function order(left: QueueEntryView, right: QueueEntryView): number {
	const urgency = (left.priority === "urgent" ? 0 : 1) - (right.priority === "urgent" ? 0 : 1);
	if (urgency !== 0) return urgency;
	return left.position - right.position || left.queueEntryId.localeCompare(right.queueEntryId);
}

export function createQueueRoutes(options: QueueRoutesOptions): QueueRoutes {
	const { runtime } = options;

	function live(threadId: string): LiveInvocationView[] {
		return getThreadLiveInvocations(
			{ tracker: runtime.tracker, turns: runtime.turns, attempts: runtime.attempts, messages: runtime.messages },
			threadId,
		);
	}

	function handle(request: IncomingMessage, response: ServerResponse, url: URL, context: ApiRouteContext): boolean {
		if (request.method !== "GET") return false;
		const match = QUEUE_PATH.exec(url.pathname);
		if (!match) return false;
		let threadId: string;
		try {
			threadId = decodeURIComponent(match[1]!);
		} catch {
			sendError(response, 400, "invalid_input", "thread id is not valid URL encoding");
			return true;
		}
		const thread = runtime.threads.get(threadId);
		if (!thread || (thread.deletedAt !== null && thread.deletedAt !== undefined)) {
			sendError(response, 404, "thread_not_found", `thread ${threadId} not found`);
			return true;
		}
		if (thread.createdBy !== context.session.userId) {
			sendError(response, 403, "forbidden", `thread ${threadId} belongs to another user`);
			return true;
		}
		const entries = [...runtime.queue.listQueued(threadId), ...runtime.queue.listActive(threadId)]
			.filter((entry) => entry.targets.some((target) => target.kind === "agent"))
			.map(toView)
			.sort(order);
		const activeInvocations = live(threadId);
		sendJson(response, 200, {
			threadId,
			cap: { perKind: QUEUE_CAP_PER_KIND },
			queue: entries,
			entries,
			activeInvocations,
		});
		return true;
	}

	return { handle };
}
