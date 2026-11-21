import { useEffect, useRef, useState } from "react";

import type { AgentView } from "@/domains/agent/api";
import { agentStatusLabel } from "@/domains/agent/labels";

export interface AgentPopoverProps {
	agents: AgentView[];
	status: "idle" | "loading" | "ready" | "error";
	error?: string;
	onRetry?: () => void;
}

export function AgentPopover({ agents, status, error, onRetry }: AgentPopoverProps) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setOpen(false);
		};
		const onPointer = (event: MouseEvent): void => {
			if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("mousedown", onPointer);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("mousedown", onPointer);
		};
	}, [open]);

	return (
		<div className="st-agent-popover" ref={rootRef}>
			<button
				type="button"
				className="st-icon-button st-agent-button"
				aria-expanded={open}
				aria-haspopup="dialog"
				onClick={() => setOpen((value) => !value)}
			>
				Agents{" "}
				{agents.length > 0 ? <span className="st-agent-count">{agents.length}</span> : null}
			</button>
			{open ? (
				<div className="st-agent-panel" role="dialog" aria-label="Agents">
					{status === "loading" && agents.length === 0 ? <p className="st-page-note">正在加载 agents…</p> : null}
					{status === "ready" && agents.length === 0 ? <p className="st-page-note">还没有注册的 agent。</p> : null}
					{status === "error" ? (
						<div className="st-agent-error">
							<p className="st-error">{error ?? "无法加载 agents"}</p>
							{onRetry ? (
								<button type="button" className="st-link-button" onClick={onRetry}>
									重试
								</button>
							) : null}
						</div>
					) : null}
					{agents.map((agent) => (
						<div className="st-agent-row" key={agent.id}>
							<span className={`st-agent-dot is-${agent.status ?? "unknown"}`} aria-hidden="true" />
							<span className="st-agent-name" title={agent.id}>
								{agent.displayName}
							</span>
							<span className="st-agent-status">{agentStatusLabel(agent.status)}</span>
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}
