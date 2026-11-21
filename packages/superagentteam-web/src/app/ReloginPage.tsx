import { Navigate } from "react-router-dom";

import { useSessionStore } from "@/domains/session/store";

export function ReloginPage() {
	const status = useSessionStore((state) => state.status);
	const error = useSessionStore((state) => state.error);
	const load = useSessionStore((state) => state.load);

	if (status === "authenticated") return <Navigate to="/" replace />;

	return (
		<main className="st-relogin">
			<h1>{status === "error" ? "暂时连不上 daemon" : "需要重新连接"}</h1>
			<p>
				在终端运行下面的命令，然后打开它打印的地址。浏览器会建立新的 session。
			</p>
			<code>superagentteam auth console-link</code>
			<button type="button" className="st-button" onClick={() => void load()}>
				我已完成，重试
			</button>
			{error ? <p className="st-error">{error}</p> : null}
		</main>
	);
}
