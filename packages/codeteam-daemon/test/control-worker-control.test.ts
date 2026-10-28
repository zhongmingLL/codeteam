import { statSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { mintInvocationCredential } from "../src/index.ts";
import { createW5BFixture, type W5BFixture } from "./helpers/w5b-fixture.ts";

let fixture: W5BFixture | null = null;

afterEach(async () => {
	await fixture?.cleanup();
	fixture = null;
});

async function connectControl(
	path: string,
): Promise<{ socket: Socket; request: (value: Record<string, unknown>) => Promise<Record<string, unknown>> }> {
	const socket = connect(path);
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	socket.setEncoding("utf8");
	let buffer = "";
	const pending = new Map<string, (value: Record<string, unknown>) => void>();
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		while (true) {
			const index = buffer.indexOf("\n");
			if (index < 0) break;
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (line === "") continue;
			const message = JSON.parse(line) as Record<string, unknown>;
			const id = typeof message.id === "string" ? message.id : null;
			if (!id) continue;
			pending.get(id)?.(message);
			pending.delete(id);
		}
	});
	let seq = 0;
	return {
		socket,
		request: (value) => {
			const id = `test-${++seq}`;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("control request timed out")), 2_000);
				pending.set(id, (message) => {
					clearTimeout(timer);
					resolve(message);
				});
				socket.write(`${JSON.stringify({ ...value, id })}\n`);
			});
		},
	};
}

describe("W5b worker control plane", () => {
	it("serves heartbeat and tool policy over a 0600 UNIX socket", async () => {
		fixture = createW5BFixture();
		const socketPath = await fixture.runtime.start();
		expect(statSync(socketPath).mode & 0o777).toBe(0o600);
		const { runtime, store } = fixture;
		runtime.registry.register({ workerId: "worker-1", role: "coder" });
		runtime.registry.heartbeat("worker-1");
		runtime.registry.bindSession("session-coder", "worker-1");
		const source = fixture.createSource("policy test");
		const run = store.runs.create({
			id: "run-policy",
			taskId: "task-w5b",
			role: "coder",
			agentSessionId: "session-coder",
			sourceId: source.id,
			recipientProfileId: "profile:coder",
			provider: "test",
			model: "fake",
			modelFamily: "test",
			workerId: "worker-1",
		});
		const minted = mintInvocationCredential(store, { runId: run.id });
		const { socket, request } = await connectControl(socketPath);
		try {
			const heartbeat = await request({ type: "heartbeat", workerId: "worker-1", pid: process.pid });
			expect(heartbeat.ok).toBe(true);
			const allow = await request({
				type: "tool_policy",
				workerId: "worker-1",
				token: minted.token,
				toolName: "write",
				input: { path: "solution.txt", content: "ok" },
			});
			expect(allow).toMatchObject({ ok: true, allow: true });
			const denied = await request({
				type: "tool_policy",
				workerId: "worker-1",
				token: minted.token,
				toolName: "write",
				input: { path: "/tmp/escape.txt", content: "no" },
			});
			expect(denied).toMatchObject({ ok: true, allow: false });
			const wrongWorker = await request({
				type: "tool_policy",
				workerId: "worker-2",
				token: minted.token,
				toolName: "read",
				input: { path: "README.md" },
			});
			expect(wrongWorker).toMatchObject({ ok: false });
			const missing = await request({ type: "heartbeat", workerId: "worker-missing" });
			expect(missing).toMatchObject({ ok: false });
			const bashOk = await request({
				type: "tool_policy",
				workerId: "worker-1",
				token: minted.token,
				toolName: "bash",
				input: { command: "git status" },
			});
			expect(bashOk).toMatchObject({ ok: true, allow: true });
			const bashDenied = await request({
				type: "tool_policy",
				workerId: "worker-1",
				token: minted.token,
				toolName: "bash",
				input: { command: "git status; rm -rf /" },
			});
			expect(bashDenied).toMatchObject({ ok: true, allow: false });
		} finally {
			socket.destroy();
		}
	});

	it("enforces the reviewer read-only tool matrix", async () => {
		fixture = createW5BFixture();
		const socketPath = await fixture.runtime.start();
		const { runtime, store } = fixture;
		runtime.registry.register({ workerId: "worker-review", role: "reviewer" });
		runtime.registry.heartbeat("worker-review");
		runtime.registry.bindSession("session-reviewer", "worker-review");
		const source = fixture.createSource("review policy test");
		const run = store.runs.create({
			id: "run-review-policy",
			taskId: "task-w5b",
			role: "reviewer",
			agentSessionId: "session-reviewer",
			sourceId: source.id,
			recipientProfileId: "profile:reviewer",
			provider: "test",
			model: "fake",
			modelFamily: "test",
			workerId: "worker-review",
		});
		const minted = mintInvocationCredential(store, { runId: run.id });
		const { socket, request } = await connectControl(socketPath);
		try {
			const read = await request({
				type: "tool_policy",
				workerId: "worker-review",
				token: minted.token,
				toolName: "read",
				input: { path: "README.md" },
			});
			expect(read).toMatchObject({ ok: true, allow: true });
			for (const toolName of ["write", "edit", "bash"]) {
				const denied = await request({
					type: "tool_policy",
					workerId: "worker-review",
					token: minted.token,
					toolName,
					input: toolName === "bash" ? { command: "git status" } : { path: "README.md", content: "x" },
				});
				expect(denied).toMatchObject({ ok: true, allow: false, code: "tool_not_allowed_for_role" });
			}
		} finally {
			socket.destroy();
		}
	});

	it("lets the verifier write only its evidence root", async () => {
		fixture = createW5BFixture();
		const socketPath = await fixture.runtime.start();
		const { runtime, store } = fixture;
		runtime.registry.register({ workerId: "worker-verify", role: "verifier" });
		runtime.registry.heartbeat("worker-verify");
		runtime.registry.bindSession("session-verifier", "worker-verify");
		const source = fixture.createSource("verifier policy test");
		const run = store.runs.create({
			id: "run-verify-policy",
			taskId: "task-w5b",
			role: "verifier",
			agentSessionId: "session-verifier",
			sourceId: source.id,
			recipientProfileId: "profile:verifier",
			provider: "test",
			model: "fake",
			modelFamily: "test",
			workerId: "worker-verify",
		});
		const minted = mintInvocationCredential(store, { runId: run.id });
		const { socket, request } = await connectControl(socketPath);
		try {
			const evidence = await request({
				type: "tool_policy",
				workerId: "worker-verify",
				token: minted.token,
				toolName: "write",
				input: { path: `${fixture.dataDir}/evidence/${run.id}/notes.txt`, content: "ok" },
			});
			expect(evidence).toMatchObject({ ok: true, allow: true });
			const worktree = await request({
				type: "tool_policy",
				workerId: "worker-verify",
				token: minted.token,
				toolName: "write",
				input: { path: "worktree-write.txt", content: "no" },
			});
			expect(worktree).toMatchObject({ ok: true, allow: false });
			const bash = await request({
				type: "tool_policy",
				workerId: "worker-verify",
				token: minted.token,
				toolName: "bash",
				input: { command: "git status" },
			});
			expect(bash).toMatchObject({ ok: true, allow: true });
		} finally {
			socket.destroy();
		}
	});
});
