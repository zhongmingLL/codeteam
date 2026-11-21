import { useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { AppShell } from "@/components/layout/AppShell";
import { useSessionStore } from "@/domains/session/store";
import { HomePage } from "./app/HomePage";
import { ReloginPage } from "./app/ReloginPage";
import { ThreadPage } from "./app/ThreadPage";

export function App() {
	const status = useSessionStore((state) => state.status);
	const load = useSessionStore((state) => state.load);

	useEffect(() => {
		void load();
	}, [load]);

	if (status === "loading") {
		return (
			<main className="st-splash" aria-busy="true">
				正在连接 daemon…
			</main>
		);
	}

	if (status !== "authenticated") {
		return (
			<Routes>
				<Route path="/relogin" element={<ReloginPage />} />
				<Route path="*" element={<Navigate to="/relogin" replace />} />
			</Routes>
		);
	}

	return (
		<Routes>
			<Route path="/relogin" element={<Navigate to="/" replace />} />
			<Route element={<AppShell />}>
				<Route index element={<HomePage />} />
				<Route path="thread/:threadId" element={<ThreadPage />} />
			</Route>
			<Route path="*" element={<Navigate to="/" replace />} />
		</Routes>
	);
}
