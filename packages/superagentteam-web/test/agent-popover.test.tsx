import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgentPopover } from "@/components/agent/AgentPopover";
import type { AgentView } from "@/domains/agent/api";

const agents: AgentView[] = [
	{ id: "a1", displayName: "Agent A1", enabled: true, status: "idle" },
	{ id: "a2", displayName: "Agent A2", enabled: false, status: "offline" },
];

describe("agent popover", () => {
	it("lists agent names and human-readable status", () => {
		render(<AgentPopover agents={agents} status="ready" />);
		fireEvent.click(screen.getByRole("button", { name: /Agents/ }));

		expect(screen.getByText("Agent A1")).toBeInTheDocument();
		expect(screen.getByText("空闲")).toBeInTheDocument();
		expect(screen.getByText("Agent A2")).toBeInTheDocument();
		expect(screen.getByText("离线")).toBeInTheDocument();
	});

	it("closes on Escape", () => {
		render(<AgentPopover agents={agents} status="ready" />);
		fireEvent.click(screen.getByRole("button", { name: /Agents/ }));
		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.queryByText("Agent A1")).not.toBeInTheDocument();
	});
});
