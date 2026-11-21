import { NavLink } from "react-router-dom";

import type { ThreadView } from "@/domains/thread/api";
import { formatRelative } from "@/lib/time";

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
