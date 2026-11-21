import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LivePill } from "@/components/a2a/LivePill";
import type { LiveInvocationView } from "@/domains/a2a/api";
import type { AgentView } from "@/domains/agent/api";

const agents: AgentView[] = [{ id: "a1", displayName: "Agent A1", enabled: true, status: "working" }];

function live(overrides: Partial<LiveInvocationView> = {}): LiveInvocationView {
	return {
		agentId: "a1",
		turnExecutionId: "turn:1",
		parentInvocationId: "inv:1",
		startedAt: 0,
		childStatus: "running",
		responseStatus: "missing",
		evidenceRank: "record+tracker",
		...overrides,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("live pill", () => {
	it("shows the running agent and elapsed minutes", () => {
		vi.spyOn(Date, "now").mockReturnValue(120_000);
		render(<LivePill live={[live()]} agents={agents} />);

		expect(screen.getByText("执行中 · Agent A1 · 2 分")).toBeInTheDocument();
	});

	it("summarizes additional live agents", () => {
		vi.spyOn(Date, "now").mockReturnValue(60_000);
		render(
			<LivePill
				live={[live(), live({ agentId: "a2", turnExecutionId: "turn:2" })]}
				agents={[...agents, { id: "a2", displayName: "Agent A2", enabled: true }]}
			/>,
		);

		expect(screen.getByText("执行中 · Agent A1 +1 · 1 分")).toBeInTheDocument();
	});

	it("does not call a sub-minute run zero minutes", () => {
		vi.spyOn(Date, "now").mockReturnValue(30_000);
		render(<LivePill live={[live()]} agents={agents} />);

		expect(screen.getByText("执行中 · Agent A1 · 不到 1 分")).toBeInTheDocument();
	});

	it("is hidden when nothing is running", () => {
		const { container } = render(<LivePill live={[]} agents={agents} />);
		expect(container).toBeEmptyDOMElement();
	});
});
