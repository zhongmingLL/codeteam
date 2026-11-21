import { useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";

import { useThreadPolling } from "@/domains/thread/use-thread-polling";
import { useThreadStore } from "@/domains/thread/store";
import { useNewThreadDialog } from "@/domains/thread/dialog-store";
import { ThreadSidebar } from "@/components/threads/ThreadSidebar";
import { NewThreadDialog } from "@/components/threads/NewThreadDialog";

export function AppShell() {
	const refresh = useThreadStore((state) => state.refresh);
	const location = useLocation();
	const navigate = useNavigate();
	const dialogOpen = useNewThreadDialog((state) => state.open);
	const hideDialog = useNewThreadDialog((state) => state.hide);
	const [sidebarOpen, setSidebarOpen] = useState(() => !window.matchMedia("(max-width: 900px)").matches);

	useThreadPolling(refresh);

	useEffect(() => {
		if (window.matchMedia("(max-width: 900px)").matches) setSidebarOpen(false);
	}, [location.pathname]);

	return (
		<div className="st-shell">
			<ThreadSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
			{sidebarOpen ? <button type="button" className="st-sidebar-backdrop" aria-label="收起侧栏" onClick={() => setSidebarOpen(false)} /> : null}
			<main className="st-main">
				<header className="st-topbar">
					<button type="button" className="st-icon-button st-menu-button" onClick={() => setSidebarOpen(true)} aria-label="打开侧栏">
						☰
					</button>
					<span className="st-topbar-title">对话</span>
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
