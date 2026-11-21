import { NavLink } from "react-router-dom";

import { useA2AStore } from "@/domains/a2a/store";
import type { ThreadView } from "@/domains/thread/api";
import { formatRelative } from "@/lib/time";

export function ThreadRow({ thread }: { thread: ThreadView }) {
	const live = useA2AStore((state) => state.threadId === thread.id && state.live.length > 0);
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
				<span className="st-thread-status">
					{live ? (
						<span className="st-thread-live" title="执行中">
							<span className="st-thread-live-dot" aria-hidden="true" />
							<span>执行中</span>
						</span>
					) : null}
					{formatRelative(thread.lastActiveAt)}
				</span>
			</span>
		</NavLink>
	);
}
