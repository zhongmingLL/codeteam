import type { LiveInvocationView } from "@/domains/a2a/api";
import type { AgentView } from "@/domains/agent/api";
import { agentDisplayName } from "@/domains/agent/labels";
import { formatElapsed } from "@/lib/time";

export interface LivePillProps {
	live: LiveInvocationView[];
	agents: AgentView[];
}

export function LivePill({ live, agents }: LivePillProps) {
	if (live.length === 0) return null;
	const first = live[0];
	const extra = live.length > 1 ? ` +${live.length - 1}` : "";
	const text = `执行中 · ${agentDisplayName(agents, first.agentId)}${extra} · ${formatElapsed(first.startedAt)}`;
	return (
		<span className="st-live-pill" title={`${text} · thread 内状态`}>
			<span className="st-live-dot" aria-hidden="true" />
			<span>{text}</span>
		</span>
	);
}
