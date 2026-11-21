import { useEffect, useRef, useState } from "react";

import type { MessageView } from "@/domains/chat/api";
import type { ThreadView } from "@/domains/thread/api";
import { formatRelative } from "@/lib/time";
import { MessageContent } from "./MessageContent";

export interface PendingUserMessageView {
	messageId: string;
	content: string;
}

export interface MessageListProps {
	thread: ThreadView;
	messages: MessageView[];
	status: "idle" | "loading" | "ready" | "error";
	error?: string;
	hasMore: boolean;
	loadingOlder: boolean;
	followingLatest: boolean;
	pendingUserMessages: PendingUserMessageView[];
	onLoadOlder: () => void;
	onRetry: () => void;
	onResumeLatest: () => void;
}

function senderLabel(message: MessageView): string {
	if (message.from.kind === "user") return "你";
	if (message.from.kind === "agent") return message.from.agentId;
	return message.from.service;
}

function isProcessing(message: MessageView): boolean {
	return message.lifecycle?.kind === "response" && message.lifecycle.status === "processing";
}

function MessageRow({ message }: { message: MessageView }) {
	const sender = message.from.kind;
	const processing = isProcessing(message);
	return (
		<article className={`st-message is-${sender}`} data-message-id={message.id}>
			<div className="st-message-meta">
				<span className="st-message-sender">{senderLabel(message)}</span>
				<time dateTime={new Date(message.timestamp).toISOString()}>{formatRelative(message.timestamp)}</time>
			</div>
			{message.content !== "" ? <MessageContent content={message.content} /> : null}
			{processing ? <p className="st-message-processing">正在回复…</p> : null}
		</article>
	);
}

export function MessageList({
	thread,
	messages,
	status,
	error,
	hasMore,
	loadingOlder,
	followingLatest,
	pendingUserMessages,
	onLoadOlder,
	onRetry,
	onResumeLatest,
}: MessageListProps) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const [pinned, setPinned] = useState(true);

	useEffect(() => {
		const element = scrollRef.current;
		if (!element || !pinned) return;
		element.scrollTop = element.scrollHeight;
	}, [messages.length, pendingUserMessages.length, pinned, thread.id]);

	const showLatest = !followingLatest || !pinned;
	const scrollToLatest = (): void => {
		if (!followingLatest) onResumeLatest();
		setPinned(true);
		const element = scrollRef.current;
		if (element) element.scrollTop = element.scrollHeight;
	};

	return (
		<div
			className="st-message-scroll"
			ref={scrollRef}
			onScroll={(event) => {
				const element = event.currentTarget;
				setPinned(element.scrollHeight - element.scrollTop - element.clientHeight < 80);
			}}
		>
			{error && (messages.length > 0 || pendingUserMessages.length > 0) ? (
				<div className="st-inline-error" role="alert">
					<span>{error}</span>
					<button type="button" className="st-link-button" onClick={onRetry}>
						重试
					</button>
				</div>
			) : null}
			{hasMore ? (
				<div className="st-load-older">
					<button type="button" className="st-button st-button-secondary" onClick={onLoadOlder} disabled={loadingOlder}>
						{loadingOlder ? "正在载入…" : "载入更早的消息"}
					</button>
				</div>
			) : null}
			{status === "loading" && messages.length === 0 ? <p className="st-page-note">正在加载消息…</p> : null}
			{status === "error" && messages.length === 0 ? (
				<div className="st-empty-panel">
					<h1>消息加载失败</h1>
					<p>{error ?? "daemon 暂时没有响应。"}</p>
					<button type="button" className="st-button" onClick={onRetry}>
						重试
					</button>
				</div>
			) : null}
			{status === "ready" && messages.length === 0 && pendingUserMessages.length === 0 ? (
				<div className="st-thread-empty">
					<p>这个对话还没有消息。</p>
					<p className="st-thread-empty-hint">在下面发第一条消息。</p>
				</div>
			) : null}
			{messages.map((message) => (
				<MessageRow key={message.id} message={message} />
			))}
			{pendingUserMessages.map((pending) => (
				<article className="st-message is-user is-pending" key={pending.messageId}>
					<div className="st-message-meta">
						<span className="st-message-sender">你</span>
						<span>发送中…</span>
					</div>
					<MessageContent content={pending.content} />
				</article>
			))}
			{showLatest ? (
				<div className="st-latest-anchor">
					<button type="button" className="st-button st-button-secondary" onClick={scrollToLatest}>
						回到最新
					</button>
				</div>
			) : null}
		</div>
	);
}
