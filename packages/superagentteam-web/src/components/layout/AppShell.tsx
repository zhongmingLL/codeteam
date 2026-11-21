import { useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";

import { LivePill } from "@/components/a2a/LivePill";
import { AgentPopover } from "@/components/agent/AgentPopover";
import { useThreadStore } from "@/domains/thread/store";
import { useNewThreadDialog } from "@/domains/thread/dialog-store";
import { useA2AStore } from "@/domains/a2a/store";
import { useAgentStore } from "@/domains/agent/store";
import { ThreadSidebar } from "@/components/threads/ThreadSidebar";
import { NewThreadDialog } from "@/components/threads/NewThreadDialog";
import { usePolling } from "@/lib/polling";

function threadIdFromPath(pathname: string): string | undefined {
	const prefix = "/thread/";
	if (!pathname.startsWith(prefix)) return undefined;
	try {
		return decodeURIComponent(pathname.slice(prefix.length));
	} catch {
		return undefined;
	}
}

export function AppShell() {
	const refresh = useThreadStore((state) => state.refresh);
	const threads = useThreadStore((state) => state.threads);
	const detail = useThreadStore((state) => state.detail);
	const refreshAgents = useAgentStore((state) => state.refresh);
	const loadAgents = useAgentStore((state) => state.load);
	const agents = useAgentStore((state) => state.agents);
	const agentStatus = useAgentStore((state) => state.status);
	const agentError = useAgentStore((state) => state.error);
	const a2aThreadId = useA2AStore((state) => state.threadId);
	const a2aLive = useA2AStore((state) => state.live);
	const location = useLocation();
	const navigate = useNavigate();
	const dialogOpen = useNewThreadDialog((state) => state.open);
	const hideDialog = useNewThreadDialog((state) => state.hide);
	const [sidebarOpen, setSidebarOpen] = useState(() => !window.matchMedia("(max-width: 900px)").matches);
	const activeThreadId = threadIdFromPath(location.pathname);
	const activeThread = detail?.id === activeThreadId ? detail : threads.find((thread) => thread.id === activeThreadId);
	const showLive = activeThreadId !== undefined && a2aThreadId === activeThreadId;

	usePolling(refresh, { intervalMs: 10_000 });
	usePolling(refreshAgents, { intervalMs: 10_000 });

	useEffect(() => {
		if (window.matchMedia("(max-width: 900px)").matches) setSidebarOpen(false);
	}, [location.pathname]);

	useEffect(() => {
		const mobile = window.matchMedia("(max-width: 900px)");
		const onChange = (event: MediaQueryListEvent): void => {
			if (event.matches) setSidebarOpen(false);
		};
		mobile.addEventListener("change", onChange);
		return () => mobile.removeEventListener("change", onChange);
	}, []);

	return (
		<div className="st-shell">
			<ThreadSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
			{sidebarOpen ? <button type="button" className="st-sidebar-backdrop" aria-label="收起侧栏" onClick={() => setSidebarOpen(false)} /> : null}
			<main className="st-main">
				<header className="st-topbar">
					<button type="button" className="st-icon-button st-menu-button" onClick={() => setSidebarOpen(true)} aria-label="打开侧栏">
						☰
					</button>
					<span className="st-topbar-title">{activeThread?.title ?? "对话"}</span>
					<div className="st-topbar-actions">
						{showLive ? <LivePill live={a2aLive} agents={agents} /> : null}
						<AgentPopover
							agents={agents}
							status={agentStatus}
							error={agentError}
							onRetry={() => void loadAgents()}
						/>
					</div>
				</header>
				<div className="st-content">
					<Outlet />
				</div>
			</main>
			<NewThreadDialog
				open={dialogOpen}
				onClose={hideDialog}
				onCreated={(thread) => {
					hideDialog();
					setSidebarOpen(false);
					navigate(`/thread/${encodeURIComponent(thread.id)}`);
				}}
			/>
		</div>
	);
}
