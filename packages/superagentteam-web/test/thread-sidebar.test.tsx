import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThreadSidebar } from "@/components/threads/ThreadSidebar";
import type { ThreadView } from "@/domains/thread/api";
import { useNewThreadDialog } from "@/domains/thread/dialog-store";
import { useThreadStore } from "@/domains/thread/store";

function thread(overrides: Partial<ThreadView> = {}): ThreadView {
	return {
		id: "thread:1",
		projectPath: "/tmp/project-a",
		title: "Alpha",
		titleSource: "user",
		createdBy: "operator:1",
		participants: [],
		lastActiveAt: Date.now(),
		createdAt: Date.now(),
		updatedAt: Date.now(),
		deletedAt: null,
		...overrides,
	};
}

afterEach(() => {
	useThreadStore.setState({
		threads: [],
		status: "ready",
		error: undefined,
		query: "",
		load: vi.fn(async () => {}),
		refresh: vi.fn(async () => true),
		create: vi.fn(),
	});
});

describe("thread sidebar", () => {
	it("lists threads and filters by search", () => {
		useThreadStore.setState({
			threads: [thread(), thread({ id: "thread:2", title: "Beta", projectPath: "/tmp/b" })],
			status: "ready",
		});
		render(
			<MemoryRouter>
				<ThreadSidebar open onClose={() => {}} />
			</MemoryRouter>,
		);

		expect(screen.getByText("Alpha")).toBeInTheDocument();
		expect(screen.getByText("Beta")).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("搜索对话"), { target: { value: "beta" } });
		expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
		expect(screen.getByText("Beta")).toBeInTheDocument();
	});

	it("shows an accessible unread count on a thread row", () => {
		useThreadStore.setState({
			threads: [thread({ unreadCount: 3 })],
			status: "ready",
		});
		render(
			<MemoryRouter>
				<ThreadSidebar open onClose={() => {}} />
			</MemoryRouter>,
		);

		expect(screen.getByLabelText("3 条未读")).toHaveTextContent("3");
	});

	it("shows the empty state and opens the new-thread dialog", () => {
		useThreadStore.setState({ threads: [], status: "ready", query: "" });
		render(
			<MemoryRouter>
				<ThreadSidebar open onClose={() => {}} />
			</MemoryRouter>,
		);

		expect(screen.getByText("还没有对话。点「+ 新对话」开始。")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "+ 新对话" }));
		expect(useNewThreadDialog.getState().open).toBe(true);
		useNewThreadDialog.setState({ open: false });
	});
});
