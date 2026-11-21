import { create } from "zustand";

import { api } from "@/lib/api";
import { type ApiClient, ApiError, setUnauthorizedHandler } from "@/lib/api/client.ts";
import { setCsrfToken } from "@/lib/api/token.ts";

export interface SessionResponse {
	userId: string;
	csrfToken: string;
}

export type SessionStatus = "loading" | "authenticated" | "unauthenticated" | "error";
export type SessionProbe = "ok" | "unauthorized" | "unavailable";

export interface SessionState {
	status: SessionStatus;
	userId?: string;
	csrfToken?: string;
	error?: string;
	load(): Promise<void>;
	probe(): Promise<SessionProbe>;
	markUnauthenticated(): void;
}

export interface SessionStoreDeps {
	client: Pick<ApiClient, "get">;
	setToken: (token: string | undefined) => void;
}

export function createSessionStore(deps: SessionStoreDeps) {
	return create<SessionState>((set) => ({
		status: "loading",
		async load() {
			set({ status: "loading", error: undefined });
			try {
				const body = await deps.client.get<SessionResponse>("/api/session");
				deps.setToken(body.csrfToken);
				set({ status: "authenticated", userId: body.userId, csrfToken: body.csrfToken });
			} catch (error) {
				if (error instanceof ApiError && error.status === 401) {
					deps.setToken(undefined);
					set({
						status: "unauthenticated",
						userId: undefined,
						csrfToken: undefined,
						error: undefined,
					});
					return;
				}
				set({
					status: "error",
					error: error instanceof Error ? error.message : "无法连接 daemon",
				});
			}
		},
		async probe() {
			try {
				const body = await deps.client.get<SessionResponse>("/api/session");
				deps.setToken(body.csrfToken);
				set({ status: "authenticated", userId: body.userId, csrfToken: body.csrfToken, error: undefined });
				return "ok";
			} catch (error) {
				if (error instanceof ApiError && error.status === 401) {
					deps.setToken(undefined);
					set({
						status: "unauthenticated",
						userId: undefined,
						csrfToken: undefined,
						error: undefined,
					});
					return "unauthorized";
				}
				return "unavailable";
			}
		},
		markUnauthenticated() {
			deps.setToken(undefined);
			set({
				status: "unauthenticated",
				userId: undefined,
				csrfToken: undefined,
				error: undefined,
			});
		},
	}));
}

export const useSessionStore = createSessionStore({ client: api, setToken: setCsrfToken });

setUnauthorizedHandler(() => {
	useSessionStore.getState().markUnauthenticated();
});
