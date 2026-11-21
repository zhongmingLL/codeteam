export const CHANGE_TOPICS = ["messages", "queue", "live", "thread"] as const;
export type ChangeTopic = (typeof CHANGE_TOPICS)[number];

export interface ThreadChangeEvent {
	threadId: string;
	topics: ChangeTopic[];
	at: number;
}

export interface ThreadEventHandlers {
	onReady: () => void;
	onChange: (event: ThreadChangeEvent) => void;
	onError: () => void;
}

export interface EventSourceLike {
	addEventListener(type: string, listener: (event: Event) => void): void;
	removeEventListener(type: string, listener: (event: Event) => void): void;
	close(): void;
	onerror: ((event: Event) => void) | null;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

const topicSet = new Set<string>(CHANGE_TOPICS);

export function parseChangeEvent(data: unknown): ThreadChangeEvent | null {
	if (typeof data !== "string") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(data) as unknown;
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	const value = parsed as Record<string, unknown>;
	if (typeof value.threadId !== "string" || typeof value.at !== "number" || !Array.isArray(value.topics)) return null;
	const topics: ChangeTopic[] = [];
	for (const topic of value.topics) {
		if (typeof topic !== "string" || !topicSet.has(topic)) continue;
		if (!topics.includes(topic as ChangeTopic)) topics.push(topic as ChangeTopic);
	}
	if (topics.length === 0) return null;
	return { threadId: value.threadId, topics, at: value.at };
}

function browserEventSource(url: string): EventSourceLike {
	const source = new EventSource(url);
	return {
		addEventListener: (type, listener) => source.addEventListener(type, listener as EventListener),
		removeEventListener: (type, listener) => source.removeEventListener(type, listener as EventListener),
		close: () => source.close(),
		set onerror(handler) {
			source.onerror = handler;
		},
		get onerror() {
			return source.onerror as ((event: Event) => void) | null;
		},
	};
}

export function connectThreadEvents(
	threadId: string,
	handlers: ThreadEventHandlers,
	createSource: EventSourceFactory = browserEventSource,
): () => void {
	const source = createSource(`/api/events?threadId=${encodeURIComponent(threadId)}`);
	let closed = false;
	const onReady = (): void => {
		if (!closed) handlers.onReady();
	};
	const onChange = (event: Event): void => {
		if (closed) return;
		const change = parseChangeEvent((event as MessageEvent).data);
		if (change && change.threadId === threadId) handlers.onChange(change);
	};
	const onError = (): void => {
		if (!closed) handlers.onError();
	};
	source.addEventListener("ready", onReady);
	source.addEventListener("change", onChange);
	source.onerror = onError;
	return () => {
		closed = true;
		source.removeEventListener("ready", onReady);
		source.removeEventListener("change", onChange);
		source.close();
	};
}
