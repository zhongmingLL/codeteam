import { Link, useParams } from "react-router-dom";

import { useThreadStore } from "@/domains/thread/store";

export function ThreadPage() {
	const { threadId } = useParams<{ threadId: string }>();
	const threads = useThreadStore((state) => state.threads);
	const status = useThreadStore((state) => state.status);
	const thread = threads.find((item) => item.id === threadId);

	if (status === "loading" && !thread) {
		return <p className="st-page-note">正在加载对话…</p>;
	}
	if (!thread) {
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

	return (
		<section className="st-thread-page">
			<header className="st-thread-header">
				<h1>{thread.title ?? "未命名对话"}</h1>
				<div className="st-thread-header-meta">
					<code>{thread.projectPath}</code>
					<span>{thread.participants.length > 0 ? `${thread.participants.length} 位成员` : "还没有成员"}</span>
				</div>
			</header>
			<div className="st-thread-empty">
				<p>这个对话还没有消息。</p>
			</div>
		</section>
	);
}
