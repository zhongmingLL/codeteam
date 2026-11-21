import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
	vi.restoreAllMocks();
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
		const markRead = vi.fn(async () => true);
		const loadLatest = vi.fn(async () => true);
		useA2AStore.setState({
			load: vi.fn(async () => true),
			refresh: vi.fn(async () => true),
			reset: vi.fn(),
		});
		useThreadStore.setState({ threads: [thread], status: "ready", loadDetail, detailStatus: "idle", markRead });
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
		expect(markRead).toHaveBeenCalledWith("thread:1", "msg:1");
		expect(screen.getByLabelText("消息内容")).toBeInTheDocument();
	});

	it("sends from the composer through the chat store", async () => {
		const send = vi.fn(async () => ({ status: "queued" as const, userMessageId: "msg:2" }));
		useA2AStore.setState({
			load: vi.fn(async () => true),
			refresh: vi.fn(async () => true),
			reset: vi.fn(),
		});
		useThreadStore.setState({
			threads: [thread],
			status: "ready",
			detailStatus: "ready",
			detail: thread,
			markRead: vi.fn(async () => true),
		});
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
		useThreadStore.setState({
			threads: [thread],
			status: "ready",
			detailStatus: "ready",
			detail: thread,
			markRead: vi.fn(async () => true),
		});
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

	it("marks read on open and only marks arrivals when following latest", async () => {
		const markRead = vi.fn(async () => true);
		const first = message({ id: "msg:1" });
		useThreadStore.setState({
			threads: [thread],
			status: "ready",
			detailStatus: "ready",
			detail: thread,
			markRead,
		});
		useA2AStore.setState({
			load: vi.fn(async () => true),
			refresh: vi.fn(async () => true),
			reset: vi.fn(),
		});
		useChatStore.setState({
			threadId: thread.id,
			messages: [first],
			status: "ready",
			followingLatest: true,
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

		await waitFor(() => expect(markRead).toHaveBeenCalledWith(thread.id, "msg:1"));
		markRead.mockClear();

		const second = message({
			id: "msg:2",
			type: "assistant",
			from: { kind: "agent", agentId: "a1" },
			content: "reply",
		});
		act(() => {
			useChatStore.setState({ messages: [first, second], followingLatest: false });
		});
		expect(await screen.findByText("reply")).toBeInTheDocument();
		expect(markRead).not.toHaveBeenCalledWith(thread.id, "msg:2");

		act(() => {
			useChatStore.setState({ followingLatest: true });
		});
		await waitFor(() => expect(markRead).toHaveBeenCalledWith(thread.id, "msg:2"));
	});

	it("defers a hidden arrival until the page becomes visible", async () => {
		const visibility = vi.spyOn(document, "visibilityState", "get");
		visibility.mockReturnValue("visible");
		const markRead = vi.fn(async () => true);
		const first = message({ id: "msg:1" });
		useThreadStore.setState({
			threads: [thread],
			status: "ready",
			detailStatus: "ready",
			detail: thread,
			markRead,
		});
		useA2AStore.setState({
			load: vi.fn(async () => true),
			refresh: vi.fn(async () => true),
			reset: vi.fn(),
		});
		useChatStore.setState({
			threadId: thread.id,
			messages: [first],
			status: "ready",
			followingLatest: true,
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
		await waitFor(() => expect(markRead).toHaveBeenCalledWith(thread.id, "msg:1"));
		markRead.mockClear();

		visibility.mockReturnValue("hidden");
		act(() => document.dispatchEvent(new Event("visibilitychange")));
		const second = message({
			id: "msg:2",
			type: "assistant",
			from: { kind: "agent", agentId: "a1" },
			content: "hidden reply",
		});
		act(() => useChatStore.setState({ messages: [first, second], followingLatest: true }));
		expect(await screen.findByText("hidden reply")).toBeInTheDocument();
		expect(markRead).not.toHaveBeenCalledWith(thread.id, "msg:2");

		visibility.mockReturnValue("visible");
		act(() => document.dispatchEvent(new Event("visibilitychange")));
		await waitFor(() => expect(markRead).toHaveBeenCalledWith(thread.id, "msg:2"));
		visibility.mockRestore();
	});

	it("does not mark the first message of an empty thread while hidden", async () => {
		const visibility = vi.spyOn(document, "visibilityState", "get");
		visibility.mockReturnValue("visible");
		const markRead = vi.fn(async () => true);
		useThreadStore.setState({
			threads: [thread],
			status: "ready",
			detailStatus: "ready",
			detail: thread,
			markRead,
		});
		useA2AStore.setState({
			load: vi.fn(async () => true),
			refresh: vi.fn(async () => true),
			reset: vi.fn(),
		});
		useChatStore.setState({
			threadId: thread.id,
			messages: [],
			status: "ready",
			followingLatest: true,
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
		await waitFor(() => expect(markRead).not.toHaveBeenCalled());

		visibility.mockReturnValue("hidden");
		act(() => document.dispatchEvent(new Event("visibilitychange")));
		const first = message({
			id: "msg:1",
			type: "assistant",
			from: { kind: "agent", agentId: "a1" },
			content: "first reply",
		});
		act(() => useChatStore.setState({ messages: [first], followingLatest: true }));
		expect(await screen.findByText("first reply")).toBeInTheDocument();
		expect(markRead).not.toHaveBeenCalled();

		visibility.mockReturnValue("visible");
		act(() => document.dispatchEvent(new Event("visibilitychange")));
		await waitFor(() => expect(markRead).toHaveBeenCalledWith(thread.id, "msg:1"));
		visibility.mockRestore();
	});

	it("retries mark-read after a failure on the next visibility change", async () => {
		const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
		const markRead = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		const first = message({ id: "msg:1" });
		useThreadStore.setState({
			threads: [thread],
			status: "ready",
			detailStatus: "ready",
			detail: thread,
			markRead,
		});
		useA2AStore.setState({
			load: vi.fn(async () => true),
			refresh: vi.fn(async () => true),
			reset: vi.fn(),
		});
		useChatStore.setState({
			threadId: thread.id,
			messages: [first],
			status: "ready",
			followingLatest: true,
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
		await waitFor(() => expect(markRead).toHaveBeenCalledTimes(1));

		visibility.mockReturnValue("hidden");
		act(() => document.dispatchEvent(new Event("visibilitychange")));
		visibility.mockReturnValue("visible");
		act(() => document.dispatchEvent(new Event("visibilitychange")));
		await waitFor(() => expect(markRead).toHaveBeenCalledTimes(2));
		visibility.mockRestore();
	});
});
