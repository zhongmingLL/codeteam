import { useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";

import { useThreadStore } from "@/domains/thread/store";
import { useNewThreadDialog } from "@/domains/thread/dialog-store";
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
	const location = useLocation();
	const navigate = useNavigate();
	const dialogOpen = useNewThreadDialog((state) => state.open);
	const hideDialog = useNewThreadDialog((state) => state.hide);
	const [sidebarOpen, setSidebarOpen] = useState(() => !window.matchMedia("(max-width: 900px)").matches);
	const activeThreadId = threadIdFromPath(location.pathname);
	const activeThread = detail?.id === activeThreadId ? detail : threads.find((thread) => thread.id === activeThreadId);

	usePolling(refresh, { intervalMs: 10_000 });

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
