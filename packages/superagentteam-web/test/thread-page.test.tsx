import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThreadPage } from "@/app/ThreadPage";
import { useA2AStore } from "@/domains/a2a/store";
import type { MessageView } from "@/domains/chat/api";
import { useChatStore } from "@/domains/chat/store";
import { useAgentStore } from "@/domains/agent/store";
import type { ThreadView } from "@/domains/thread/api";
import { useThreadStore } from "@/domains/thread/store";

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

function message(overrides: Partial<MessageView> = {}): MessageView {
	return {
		id: "msg:1",
		threadId: "thread:1",
		type: "user",
		from: { kind: "user", userId: "operator:1" },
		content: "hello",
		timestamp: 1,
		updatedAt: 1,
		...overrides,
	};
}

afterEach(() => {
	useChatStore.getState().reset();
	useA2AStore.getState().reset();
	useAgentStore.setState({ agents: [], status: "idle", error: undefined });
	useThreadStore.setState({
		threads: [],
		status: "ready",
		error: undefined,
		detail: undefined,
		detailStatus: "idle",
		detailError: undefined,
	});
});

describe("thread page", () => {
	it("loads the thread detail and message window, then renders the composer", async () => {
		const loadDetail = vi.fn(async () => true);
		const loadLatest = vi.fn(async () => true);
		useA2AStore.setState({
			load: vi.fn(async () => true),
			refresh: vi.fn(async () => true),
			reset: vi.fn(),
		});
		useThreadStore.setState({ threads: [thread], status: "ready", loadDetail, detailStatus: "idle" });
		useChatStore.setState({
			threadId: thread.id,
			messages: [message()],
			status: "ready",
			loadLatest,
			refresh: vi.fn(async () => true),
		});

		render(
			<MemoryRouter initialEntries={[`/thread/${encodeURIComponent(thread.id)}`]}>
				<Routes>
					<Route path="/thread/:threadId" element={<ThreadPage />} />
				</Routes>
			</MemoryRouter>,
		);

		expect(await screen.findByText("hello")).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "Alpha" })).toBeInTheDocument();
		expect(loadDetail).toHaveBeenCalledWith("thread:1");
		expect(loadLatest).toHaveBeenCalledWith("thread:1");
		expect(screen.getByLabelText("消息内容")).toBeInTheDocument();
	});

	it("sends from the composer through the chat store", async () => {
		const send = vi.fn(async () => ({ status: "queued" as const, userMessageId: "msg:2" }));
		useA2AStore.setState({
			load: vi.fn(async () => true),
			refresh: vi.fn(async () => true),
			reset: vi.fn(),
		});
		useThreadStore.setState({ threads: [thread], status: "ready", detailStatus: "ready", detail: thread });
		useChatStore.setState({
			threadId: thread.id,
			messages: [],
			status: "ready",
			loadLatest: vi.fn(async () => true),
			send,
		});

		render(
			<MemoryRouter initialEntries={[`/thread/${encodeURIComponent(thread.id)}`]}>
				<Routes>
					<Route path="/thread/:threadId" element={<ThreadPage />} />
				</Routes>
			</MemoryRouter>,
		);

		const input = screen.getByLabelText("消息内容");
		fireEvent.change(input, { target: { value: "new message" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(send).toHaveBeenCalledWith("new message", expect.any(String)));
	});

	it("shows a degraded notice instead of silently hiding queue state", async () => {
		useThreadStore.setState({ threads: [thread], status: "ready", detailStatus: "ready", detail: thread });
		useA2AStore.setState({
			threadId: thread.id,
			status: "error",
			error: "daemon down",
			load: vi.fn(async () => false),
			refresh: vi.fn(async () => false),
			reset: vi.fn(),
		});
		useChatStore.setState({
			threadId: thread.id,
			messages: [],
			status: "ready",
			loadLatest: vi.fn(async () => true),
			refresh: vi.fn(async () => true),
		});

		render(
			<MemoryRouter initialEntries={[`/thread/${encodeURIComponent(thread.id)}`]}>
				<Routes>
					<Route path="/thread/:threadId" element={<ThreadPage />} />
				</Routes>
			</MemoryRouter>,
		);

		expect(await screen.findByText(/队列状态暂时不可用/)).toBeInTheDocument();
		expect(screen.getByText(/daemon down/)).toBeInTheDocument();
	});
});
