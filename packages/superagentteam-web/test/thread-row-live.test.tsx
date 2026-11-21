import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import { ThreadRow } from "@/components/threads/ThreadRow";
import { useA2AStore } from "@/domains/a2a/store";
import type { ThreadView } from "@/domains/thread/api";

const thread: ThreadView = {
	id: "thread:1",
	projectPath: "/tmp/project",
	title: "Alpha",
	titleSource: "user",
	createdBy: "operator:1",
	participants: [],
	lastActiveAt: 1,
	createdAt: 1,
	updatedAt: 1,
	deletedAt: null,
};

afterEach(() => {
	useA2AStore.getState().reset();
});

describe("thread row live presence", () => {
	it("marks only the active thread as running", () => {
		useA2AStore.setState({
			threadId: "thread:1",
			live: [
				{
					agentId: "a1",
					turnExecutionId: "turn:1",
					parentInvocationId: "inv:1",
					startedAt: 1,
					childStatus: "running",
					responseStatus: "missing",
					evidenceRank: "record+tracker",
				},
			],
		});
		render(
			<MemoryRouter>
				<ThreadRow thread={thread} />
			</MemoryRouter>,
		);

		expect(screen.getByText("执行中")).toBeInTheDocument();
	});

	it("does not mark a thread that is not the active live thread", () => {
		useA2AStore.setState({ threadId: "thread:2", live: [] });
		render(
			<MemoryRouter>
				<ThreadRow thread={thread} />
			</MemoryRouter>,
		);

		expect(screen.queryByText("执行中")).not.toBeInTheDocument();
	});
});
