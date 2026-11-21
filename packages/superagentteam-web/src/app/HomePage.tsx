import { useSessionStore } from "@/domains/session/store";

export function HomePage() {
	const userId = useSessionStore((state) => state.userId);

	return (
		<main className="st-home">
			<h1>SuperAgentTeam</h1>
			<p>已连接到 daemon。{userId ? <span>当前 operator：{userId}</span> : null}</p>
			<p>F020 H0 脚手架已就位；sidebar/threads/chat 在 H1–H2 接入。</p>
		</main>
	);
}
