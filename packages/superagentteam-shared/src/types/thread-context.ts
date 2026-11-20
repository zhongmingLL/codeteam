// F018 R4-a thread_context contract (0007 §3.8, DP-F018SURFACE-1=A).
// Read-only bounded thread window; never acks a delivery cursor and never
// creates a queue entry.

import type { MessageContent, MessageFrom, MessageLifecycle } from "./message.ts";

export interface ThreadContextInput {
	/** Omitted = the caller's current thread. */
	threadId?: string;
	/** Exact message id inside the resolved thread. */
	anchor?: string;
	/** Messages before the anchor, 0-50. */
	before?: number;
	/** Messages after the anchor, 0-50. */
	after?: number;
	/** Window size when no anchor is given, 1-200, default 50. */
	limit?: number;
	/** Opaque continuation for an older window; cannot be combined with anchor. */
	cursor?: string;
}

export interface ThreadContextMessageView {
	messageId: string;
	seq: number;
	from: MessageFrom;
	content: string;
	contentBlocks?: MessageContent[];
	lifecycle?: Pick<MessageLifecycle, "kind"> & { status?: string };
	createdAt: number;
}

export interface ThreadContextResult {
	threadId: string;
	messages: ThreadContextMessageView[];
	hasMore: boolean;
	nextCursor?: string;
}
