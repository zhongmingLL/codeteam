import { useCallback, useEffect } from "react";
import { Link, useParams } from "react-router-dom";

import { Composer } from "@/components/chat/Composer";
import { MessageList } from "@/components/chat/MessageList";
import { QueueStrip } from "@/components/a2a/QueueStrip";
import { useA2AStore } from "@/domains/a2a/store";
import { useAgentStore } from "@/domains/agent/store";
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
	const chatThreadId = useChatStore((state) => state.threadId);
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
	const a2aThreadId = useA2AStore((state) => state.threadId);
	const a2aQueue = useA2AStore((state) => state.queue);
	const a2aLive = useA2AStore((state) => state.live);
	const a2aCap = useA2AStore((state) => state.cap);
	const a2aStatus = useA2AStore((state) => state.status);
	const a2aError = useA2AStore((state) => state.error);
	const loadA2A = useA2AStore((state) => state.load);
	const refreshA2A = useA2AStore((state) => state.refresh);
	const resetA2A = useA2AStore((state) => state.reset);
	const agents = useAgentStore((state) => state.agents);

	useEffect(() => {
		if (!threadId) return;
		void loadDetail(threadId);
		void loadLatest(threadId);
		void loadA2A(threadId);
		return () => {
			reset();
			resetA2A();
		};
	}, [threadId, loadDetail, loadLatest, loadA2A, reset, resetA2A]);

	const poll = useCallback(async () => {
		if (!threadId || detailStatus === "not_found") return true;
		if (useChatStore.getState().threadId !== threadId) return true;
		return refresh();
	}, [threadId, detailStatus, refresh]);
	usePolling(poll, { intervalMs: 2000, runImmediately: false });
	const pollA2A = useCallback(async () => {
		if (!threadId || detailStatus === "not_found") return true;
		if (detail?.deletedAt !== null && detail?.deletedAt !== undefined) return true;
		if (useA2AStore.getState().threadId !== threadId) return true;
		return refreshA2A();
	}, [threadId, detailStatus, detail?.deletedAt, refreshA2A]);
	usePolling(pollA2A, { intervalMs: 2000, runImmediately: false });

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
	const a2aMatches = a2aThreadId === threadId;
	const chatMatches = chatThreadId === threadId;
	return (
		<section className="st-thread-page" aria-busy={!chatMatches || chatStatus === "loading"}>
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
				messages={chatMatches ? messages : []}
				status={chatMatches ? chatStatus : "loading"}
				error={chatMatches ? chatError : undefined}
				hasMore={chatMatches ? hasMore : false}
				loadingOlder={chatMatches ? loadingOlder : false}
				followingLatest={chatMatches ? followingLatest : true}
				pendingUserMessages={chatMatches ? pendingUserMessages : []}
				onLoadOlder={() => void loadOlder()}
				onRetry={() => void refresh()}
				onResumeLatest={() => void resumeLatest()}
				liveInvocations={a2aMatches ? a2aLive : []}
				agentLabel={(agentId) => agents.find((agent) => agent.id === agentId)?.displayName ?? agentId}
			/>
			{a2aMatches && (a2aStatus === "error" || a2aError !== undefined) ? (
				<p className="st-a2a-degraded" role="status">
					队列状态暂时不可用{a2aError ? `：${a2aError}` : "。"}
					<button type="button" className="st-link-button" onClick={() => void refreshA2A()}>
						重试
					</button>
				</p>
			) : null}
			<QueueStrip queue={a2aMatches ? a2aQueue : []} agents={agents} cap={a2aCap} />
			<Composer
				key={threadId}
				threadId={threadId}
				agents={agents}
				onSend={async (content, idempotencyKey, targetAgentIds) => {
					if (targetAgentIds) await send(content, idempotencyKey, targetAgentIds);
					else await send(content, idempotencyKey);
					await refreshA2A();
				}}
				disabled={deleted}
				disabledReason="这个对话已删除，不能再发送消息。"
			/>
		</section>
	);
}
