import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Composer } from "@/components/chat/Composer";
import type { AgentView } from "@/domains/agent/api";

afterEach(() => {
	window.sessionStorage.clear();
});

describe("composer", () => {
	it("sends on Enter and clears the draft after success", async () => {
		const onSend = vi.fn(async () => {});
		render(<Composer threadId="thread:1" onSend={onSend} />);
		const input = screen.getByLabelText("消息内容");

		fireEvent.change(input, { target: { value: "hello" } });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(onSend).toHaveBeenCalledWith("hello", expect.any(String)));
		await waitFor(() => expect(input).toHaveValue(""));
	});

	it("keeps a newline for Shift+Enter instead of sending", () => {
		const onSend = vi.fn(async () => {});
		render(<Composer threadId="thread:1" onSend={onSend} />);
		const input = screen.getByLabelText("消息内容");

		fireEvent.change(input, { target: { value: "hello" } });
		fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

		expect(onSend).not.toHaveBeenCalled();
	});

	it("disables an empty send and never double-submits", async () => {
		let finish: () => void = () => {};
		const onSend = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		render(<Composer threadId="thread:1" onSend={onSend} />);
		const input = screen.getByLabelText("消息内容");
		expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();

		fireEvent.change(input, { target: { value: "hello" } });
		fireEvent.keyDown(input, { key: "Enter" });
		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
		finish();
	});

	it("keeps the draft and reuses the same key after a failure", async () => {
		const onSend = vi.fn().mockRejectedValueOnce(new Error("daemon down")).mockResolvedValueOnce(undefined);
		render(<Composer threadId="thread:1" onSend={onSend} />);
		const input = screen.getByLabelText("消息内容");

		fireEvent.change(input, { target: { value: "hello" } });
		fireEvent.keyDown(input, { key: "Enter" });

		expect(await screen.findByText(/发送失败/)).toBeInTheDocument();
		expect(input).toHaveValue("hello");

		fireEvent.keyDown(input, { key: "Enter" });

		await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
		expect(onSend.mock.calls[0]?.[1]).toBe(onSend.mock.calls[1]?.[1]);
		await waitFor(() => expect(input).toHaveValue(""));
	});

	it("restores a per-thread draft after remount", () => {
		const onSend = vi.fn(async () => {});
		const first = render(<Composer threadId="thread:1" onSend={onSend} />);
		fireEvent.change(screen.getByLabelText("消息内容"), { target: { value: "unfinished" } });
		first.unmount();

		render(<Composer threadId="thread:1" onSend={onSend} />);
		expect(screen.getByLabelText("消息内容")).toHaveValue("unfinished");
	});

	it("sends to an explicit target and hides disabled agents", async () => {
		const onSend = vi.fn(async () => {});
		const agents: AgentView[] = [
			{ id: "a1", displayName: "Agent A1", enabled: true, status: "idle" },
			{ id: "a2", displayName: "Agent A2", enabled: false, status: "offline" },
		];
		render(<Composer threadId="thread:1" onSend={onSend} agents={agents} />);

		expect(screen.queryByRole("option", { name: "Agent A2" })).not.toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("收件人"), { target: { value: "a1" } });
		fireEvent.change(screen.getByLabelText("消息内容"), { target: { value: "hello" } });
		fireEvent.keyDown(screen.getByLabelText("消息内容"), { key: "Enter" });

		await waitFor(() => expect(onSend).toHaveBeenCalledWith("hello", expect.any(String), ["a1"]));
	});
});
