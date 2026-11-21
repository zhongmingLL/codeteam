import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import { ReloginPage } from "@/app/ReloginPage";
import { useSessionStore } from "@/domains/session/store";

afterEach(() => {
	useSessionStore.setState({ status: "loading", userId: undefined, csrfToken: undefined, error: undefined });
});

describe("relogin page", () => {
	it("shows the console-link command and retry action", () => {
		useSessionStore.setState({ status: "unauthenticated" });

		render(
			<MemoryRouter>
				<ReloginPage />
			</MemoryRouter>,
		);

		expect(screen.getByRole("heading", { name: "需要重新连接" })).toBeInTheDocument();
		expect(screen.getByText("superagentteam auth console-link")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "我已完成，重试" })).toBeInTheDocument();
	});

	it("shows a connection error without losing the retry action", () => {
		useSessionStore.setState({ status: "error", error: "无法连接 daemon" });

		render(
			<MemoryRouter>
				<ReloginPage />
			</MemoryRouter>,
		);
		expect(screen.getByRole("heading", { name: "暂时连不上 daemon" })).toBeInTheDocument();
		expect(screen.getByText("无法连接 daemon")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "我已完成，重试" })).toBeInTheDocument();
	});
});
