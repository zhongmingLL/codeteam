import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NewThreadDialog } from "@/components/threads/NewThreadDialog";
import type { ThreadView } from "@/domains/thread/api";
import { useThreadStore } from "@/domains/thread/store";

const created: ThreadView = {
	id: "thread:new",
	projectPath: "/tmp/new",
	title: null,
	titleSource: undefined,
	createdBy: "operator:1",
	participants: [],
	lastActiveAt: 1,
	createdAt: 1,
	updatedAt: 1,
	deletedAt: null,
};

afterEach(() => {
	useThreadStore.setState({
		threads: [],
		status: "ready",
		error: undefined,
		query: "",
		load: vi.fn(async () => {}),
		refresh: vi.fn(async () => {}),
		create: vi.fn(),
	});
});

describe("new thread dialog", () => {
	it("requires a project path before creating", async () => {
		const create = vi.fn(async () => created);
		useThreadStore.setState({ create });
		render(<NewThreadDialog open onClose={() => {}} onCreated={() => {}} />);

		fireEvent.click(screen.getByRole("button", { name: "创建" }));
		expect(await screen.findByText("请填写项目路径（daemon 需要一个真实目录）")).toBeInTheDocument();
		expect(create).not.toHaveBeenCalled();
	});

	it("creates with a project path and keeps the idempotency key stable across retry", async () => {
		const create = vi.fn(async () => created);
		useThreadStore.setState({ create });
		const onCreated = vi.fn();
		render(<NewThreadDialog open onClose={() => {}} onCreated={onCreated} />);

		fireEvent.change(screen.getByPlaceholderText("/path/to/project"), { target: { value: "/tmp/new" } });
		fireEvent.click(screen.getByRole("button", { name: "创建" }));
		await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({ projectPath: "/tmp/new", idempotencyKey: expect.any(String) }),
		);
	});
});
