import { useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { useSessionStore } from "@/domains/session/store";
import { HomePage } from "./app/HomePage";
import { ReloginPage } from "./app/ReloginPage";

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

	return (
		<Routes>
			<Route path="/relogin" element={<ReloginPage />} />
			<Route
				path="/"
				element={status === "authenticated" ? <HomePage /> : <Navigate to="/relogin" replace />}
			/>
			<Route path="*" element={<Navigate to="/" replace />} />
		</Routes>
	);
}
