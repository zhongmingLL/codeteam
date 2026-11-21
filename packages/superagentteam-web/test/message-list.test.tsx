import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MessageList } from "@/components/chat/MessageList";
import type { MessageView } from "@/domains/chat/api";
import type { ThreadView } from "@/domains/thread/api";

const thread: ThreadView = {
	id: "thread:1",
	projectPath: "/tmp/project",
	title: "Alpha",
	titleSource: "user",
	createdBy: "operator:1",
	participants: ["agent:1"],
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

function renderList(overrides: Partial<React.ComponentProps<typeof MessageList>> = {}) {
	return render(
		<MessageList
			thread={thread}
			messages={[message()]}
			status="ready"
			hasMore={false}
			loadingOlder={false}
			followingLatest
			pendingUserMessages={[]}
			onLoadOlder={() => {}}
			onRetry={() => {}}
			onResumeLatest={() => {}}
			{...overrides}
		/>,
	);
}

describe("message list", () => {
	it("renders message text without interpreting HTML", () => {
		const { container } = renderList({
			messages: [message({ content: '<script>alert("x")</script>' })],
		});

		expect(screen.getByText('<script>alert("x")</script>')).toBeInTheDocument();
		expect(container.querySelector("script")).toBeNull();
	});

	it("renders fenced code blocks as text inside pre/code", () => {
		const { container } = renderList({
			messages: [message({ content: "before\n```ts\nconst x = 1;\n```\nafter" })],
		});

		expect(screen.getByText("before")).toBeInTheDocument();
		expect(screen.getByText("const x = 1;")).toBeInTheDocument();
		expect(container.querySelector("pre code")).toHaveTextContent("const x = 1;");
	});

	it("shows a processing placeholder for an in-flight response", () => {
		renderList({
			messages: [
				message({
					id: "msg:processing",
					type: "assistant",
					from: { kind: "agent", agentId: "agent:1" },
					content: "",
					lifecycle: {
						kind: "response",
						parentInvocationId: "inv:1",
						turnExecutionId: "turn:1",
						target: { kind: "agent", id: "agent:1" },
						status: "processing",
						startedAt: 1,
					},
				}),
			],
		});

		expect(screen.getByText("正在回复…")).toBeInTheDocument();
	});

	it("shows receipt-backed sends as pending, not as history", () => {
		renderList({
			messages: [],
			pendingUserMessages: [{ messageId: "msg:sent", content: "new message" }],
		});

		expect(screen.getByText("new message")).toBeInTheDocument();
		expect(screen.getByText("发送中…")).toBeInTheDocument();
	});

	it("shows a live placeholder when an agent accepted a turn but has not produced a response message", () => {
		renderList({
			messages: [],
			liveInvocations: [
				{
					agentId: "a1",
					turnExecutionId: "turn:1",
					parentInvocationId: "inv:1",
					startedAt: Date.now() - 60_000,
					childStatus: "running",
					responseStatus: "missing",
					evidenceRank: "record+tracker",
				},
			],
			agentLabel: (agentId) => (agentId === "a1" ? "Agent A1" : agentId),
		});

		expect(screen.getByText("Agent A1")).toBeInTheDocument();
		expect(screen.getByText("已受理")).toBeInTheDocument();
		expect(screen.getByText(/正在处理/)).toBeInTheDocument();
	});

	it("shows a visible terminal state when a response failed without content", () => {
		renderList({
			messages: [
				message({
					id: "msg:failed",
					type: "assistant",
					from: { kind: "agent", agentId: "a1" },
					content: "",
					lifecycle: {
						kind: "response",
						parentInvocationId: "inv:1",
						turnExecutionId: "turn:1",
						target: { kind: "agent", id: "a1" },
						status: "failed",
						startedAt: 1,
						endedAt: 2,
					},
				}),
			],
		});

		expect(screen.getByText("回复失败")).toBeInTheDocument();
	});

	it("retries a failed response through the invocation id", async () => {
		const onRetryInvocation = vi.fn(async () => {});
		renderList({
			messages: [
				message({
					id: "msg:failed",
					type: "assistant",
					from: { kind: "agent", agentId: "a1" },
					content: "",
					lifecycle: {
						kind: "response",
						parentInvocationId: "inv:1",
						turnExecutionId: "turn:1",
						target: { kind: "agent", id: "a1" },
						status: "failed",
						startedAt: 1,
						endedAt: 2,
					},
				}),
			],
			onRetryInvocation,
		});

		fireEvent.click(screen.getByRole("button", { name: "重试" }));

		await waitFor(() => expect(onRetryInvocation).toHaveBeenCalledWith("inv:1"));
		expect(await screen.findByText("已重新排队")).toBeInTheDocument();
	});

	it("shows a typed retry failure and keeps the action available", async () => {
		renderList({
			messages: [
				message({
					id: "msg:failed",
					type: "assistant",
					from: { kind: "agent", agentId: "a1" },
					content: "",
					lifecycle: {
						kind: "response",
						parentInvocationId: "inv:1",
						turnExecutionId: "turn:1",
						target: { kind: "agent", id: "a1" },
						status: "failed",
						startedAt: 1,
						endedAt: 2,
					},
				}),
			],
			onRetryInvocation: vi.fn(async () => Promise.reject(new Error("这条回复当前不能重试"))),
		});

		fireEvent.click(screen.getByRole("button", { name: "重试" }));

		expect(await screen.findByRole("alert")).toHaveTextContent("这条回复当前不能重试");
		expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
	});

	it("hides retry while the parent invocation is live", () => {
		renderList({
			messages: [
				message({
					id: "msg:failed",
					type: "assistant",
					from: { kind: "agent", agentId: "a1" },
					content: "",
					lifecycle: {
						kind: "response",
						parentInvocationId: "inv:1",
						turnExecutionId: "turn:1",
						target: { kind: "agent", id: "a1" },
						status: "failed",
						startedAt: 1,
						endedAt: 2,
					},
				}),
			],
			liveInvocations: [
				{
					agentId: "a1",
					turnExecutionId: "turn:2",
					parentInvocationId: "inv:1",
					startedAt: Date.now(),
					childStatus: "running",
					responseStatus: "missing",
					evidenceRank: "tracker-only",
				},
			],
			onRetryInvocation: vi.fn(async () => {}),
		});

		expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();
	});
});
