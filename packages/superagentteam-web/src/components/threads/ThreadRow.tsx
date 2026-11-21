import { NavLink } from "react-router-dom";

import type { ThreadView } from "@/domains/thread/api";

function formatRelative(timestamp: number): string {
	const diff = Date.now() - timestamp;
	if (diff < 60_000) return "刚刚";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
	if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
	return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(timestamp);
}

export function ThreadRow({ thread }: { thread: ThreadView }) {
	return (
		<NavLink
			to={`/thread/${encodeURIComponent(thread.id)}`}
			className={({ isActive }) => `st-thread-row${isActive ? " is-active" : ""}`}
		>
			<span className="st-thread-title">{thread.title ?? "未命名对话"}</span>
			<span className="st-thread-meta">
				<span className="st-thread-project" title={thread.projectPath}>
					{thread.projectPath}
				</span>
				<span>{formatRelative(thread.lastActiveAt)}</span>
			</span>
		</NavLink>
	);
}
