import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { QueueStrip } from "@/components/a2a/QueueStrip";
import type { AgentView } from "@/domains/agent/api";

const agents: AgentView[] = [
	{ id: "a1", displayName: "Agent A1", enabled: true, status: "idle" },
	{ id: "a2", displayName: "Agent A2", enabled: true, status: "working" },
];

describe("queue strip", () => {
	it("renders queued target, position and state", () => {
		render(
			<QueueStrip
				agents={agents}
				cap={20}
				queue={[
					{
						queueEntryId: "queue:1",
						sourceRecordId: "msg:1",
						status: "queued",
						priority: "normal",
						position: 0,
						targetAgentIds: ["a1"],
						claimedBy: null,
						enqueuedAt: 1,
						updatedAt: 1,
					},
				]}
			/>,
		);

		expect(screen.getByLabelText("消息队列")).toBeInTheDocument();
		expect(screen.getByText("#1")).toBeInTheDocument();
		expect(screen.getByText("Agent A1")).toBeInTheDocument();
		expect(screen.getByText("排队中")).toBeInTheDocument();
	});

	it("is hidden when the queue is empty", () => {
		const { container } = render(<QueueStrip agents={agents} queue={[]} />);
		expect(container).toBeEmptyDOMElement();
	});
});
