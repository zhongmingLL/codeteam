import { useMemo } from "react";
import { useNewThreadDialog } from "@/domains/thread/dialog-store";
import { filterThreads, useThreadStore } from "@/domains/thread/store";
import { ThreadRow } from "./ThreadRow";

export interface ThreadSidebarProps {
	open: boolean;
	onClose: () => void;
}

export function ThreadSidebar({ open, onClose }: ThreadSidebarProps) {
	const allThreads = useThreadStore((state) => state.threads);
	const status = useThreadStore((state) => state.status);
	const error = useThreadStore((state) => state.error);
	const query = useThreadStore((state) => state.query);
	const setQuery = useThreadStore((state) => state.setQuery);
	const load = useThreadStore((state) => state.load);
	const threads = useMemo(() => filterThreads(allThreads, query), [allThreads, query]);
	const showDialog = useNewThreadDialog((state) => state.show);

	return (
		<aside className={`st-sidebar${open ? " is-open" : ""}`} aria-label="对话列表">
				<div className="st-sidebar-header">
					<span className="st-brand">SuperAgentTeam</span>
					<button type="button" className="st-icon-button st-sidebar-close" onClick={onClose} aria-label="收起侧栏">
						×
					</button>
				</div>
				<button type="button" className="st-new-thread" onClick={() => showDialog()}>
					+ 新对话
				</button>
				<input
					className="st-search"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder="搜索已加载的对话"
					aria-label="搜索对话"
					title="只搜索当前已加载的对话"
				/>
				<div className="st-thread-list">
					{status === "loading" && threads.length === 0 ? <p className="st-sidebar-note">正在加载对话…</p> : null}
					{status === "error" ? (
						<div className="st-sidebar-note">
							<p className="st-error">{error ?? "无法加载对话"}</p>
							<button type="button" className="st-link-button" onClick={() => void load()}>
								重试
							</button>
						</div>
					) : null}
					{status === "ready" && threads.length === 0 && query.trim() === "" ? (
						<p className="st-sidebar-note">还没有对话。点「+ 新对话」开始。</p>
					) : null}
					{status === "ready" && threads.length === 0 && query.trim() !== "" ? (
						<p className="st-sidebar-note">没有匹配的对话。</p>
					) : null}
					{threads.map((thread) => (
						<ThreadRow key={thread.id} thread={thread} />
					))}
				</div>
		</aside>
	);
}
