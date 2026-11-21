import { useCallback, useEffect } from "react";
import { Link, useParams } from "react-router-dom";

import { Composer } from "@/components/chat/Composer";
import { MessageList } from "@/components/chat/MessageList";
import { useChatStore } from "@/domains/chat/store";
import { useThreadStore } from "@/domains/thread/store";
import { usePolling } from "@/lib/polling";

export function ThreadPage() {
	const { threadId } = useParams<{ threadId: string }>();
	const detail = useThreadStore((state) => state.detail);
	const listThread = useThreadStore((state) => state.threads.find((item) => item.id === threadId));
	const listStatus = useThreadStore((state) => state.status);
	const detailStatus = useThreadStore((state) => state.detailStatus);
	const detailError = useThreadStore((state) => state.detailError);
	const loadDetail = useThreadStore((state) => state.loadDetail);

	const messages = useChatStore((state) => state.messages);
	const chatStatus = useChatStore((state) => state.status);
	const chatError = useChatStore((state) => state.error);
	const hasMore = useChatStore((state) => state.hasMore);
	const loadingOlder = useChatStore((state) => state.loadingOlder);
	const followingLatest = useChatStore((state) => state.followingLatest);
	const pendingUserMessages = useChatStore((state) => state.pendingUserMessages);
	const loadLatest = useChatStore((state) => state.loadLatest);
	const loadOlder = useChatStore((state) => state.loadOlder);
	const resumeLatest = useChatStore((state) => state.resumeLatest);
	const refresh = useChatStore((state) => state.refresh);
	const send = useChatStore((state) => state.send);
	const reset = useChatStore((state) => state.reset);

	useEffect(() => {
		if (!threadId) return;
		void loadDetail(threadId);
		void loadLatest(threadId);
		return () => reset();
	}, [threadId, loadDetail, loadLatest, reset]);

	const poll = useCallback(async () => {
		if (!threadId || detailStatus === "not_found") return true;
		if (useChatStore.getState().threadId !== threadId) return true;
		return refresh();
	}, [threadId, detailStatus, refresh]);
	usePolling(poll, { intervalMs: 2000, runImmediately: false });

	if (!threadId) {
		return (
			<section className="st-empty-panel">
				<h1>对话不存在</h1>
				<Link className="st-button st-button-secondary" to="/">
					返回
				</Link>
			</section>
		);
	}

	const thread = detail?.id === threadId ? detail : listThread;
	if (!thread && detailStatus === "not_found") {
		return (
			<section className="st-empty-panel">
				<h1>对话不存在</h1>
				<p>它可能已被删除，或者不在当前 operator 名下。</p>
				<Link className="st-button st-button-secondary" to="/">
					返回
				</Link>
			</section>
		);
	}
	if (!thread && detailStatus === "error") {
		return (
			<section className="st-empty-panel">
				<h1>对话加载失败</h1>
				<p>{detailError ?? "daemon 暂时没有响应。"}</p>
				<button type="button" className="st-button" onClick={() => void loadDetail(threadId)}>
					重试
				</button>
				<Link className="st-button st-button-secondary" to="/">
					返回
				</Link>
			</section>
		);
	}
	if (!thread) {
		return <p className="st-page-note">{detailStatus === "loading" || listStatus === "loading" ? "正在加载对话…" : "对话不存在"}</p>;
	}

	const deleted = thread.deletedAt !== null && thread.deletedAt !== undefined;
	return (
		<section className="st-thread-page" aria-busy={chatStatus === "loading"}>
			<header className="st-thread-header">
				<h1>{thread.title ?? "未命名对话"}</h1>
				<div className="st-thread-header-meta">
					<code title={thread.projectPath}>{thread.projectPath}</code>
					<span>{thread.participants.length > 0 ? `${thread.participants.length} 位成员` : "还没有成员"}</span>
				</div>
			</header>
			{deleted ? <p className="st-thread-deleted">这个对话已删除，历史只读。</p> : null}
			<MessageList
				thread={thread}
				messages={messages}
				status={chatStatus}
				error={chatError}
				hasMore={hasMore}
				loadingOlder={loadingOlder}
				followingLatest={followingLatest}
				pendingUserMessages={pendingUserMessages}
				onLoadOlder={() => void loadOlder()}
				onRetry={() => void refresh()}
				onResumeLatest={() => void resumeLatest()}
			/>
			<Composer
				key={threadId}
				threadId={threadId}
				onSend={async (content, idempotencyKey) => {
					await send(content, idempotencyKey);
				}}
				disabled={deleted}
				disabledReason="这个对话已删除，不能再发送消息。"
			/>
		</section>
	);
}
