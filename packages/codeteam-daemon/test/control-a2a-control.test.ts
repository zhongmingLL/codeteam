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
			const id = `a2a-test-${++seq}`;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("control request timed out")), 3_000);
				pending.set(id, (message) => {
					clearTimeout(timer);
					resolve(message);
				});
				socket.write(`${JSON.stringify({ ...value, id })}\n`);
			});
		},
	};
}

function createBoundRun(
	f: W5BFixture,
	input: { runId: string; workerId: string; profileId: string; sessionId: string },
) {
	f.runtime.registry.register({ workerId: input.workerId, role: "coder" });
	f.runtime.registry.heartbeat(input.workerId);
	f.runtime.registry.bindSession(input.sessionId, input.workerId);
	const source = f.createSource(`${input.runId} source`);
	return f.store.runs.create({
		id: input.runId,
		taskId: "task-w5b",
		role: "coder",
		agentSessionId: input.sessionId,
		sourceId: source.id,
		recipientProfileId: input.profileId,
		provider: "test",
		model: "fake",
		modelFamily: "test",
		workerId: input.workerId,
	});
}

describe("A2A control socket", () => {
	it("resolves per-run token identity and executes a2a_send through the handler", async () => {
		fixture = createW5BFixture();
		const socketPath = await fixture.runtime.start();
		const run = createBoundRun(fixture, {
			runId: "run-a2a-send",
			workerId: "worker-a2a-send",
			profileId: "profile:coder",
			sessionId: "session-coder",
		});
		const minted = mintInvocationCredential(fixture.store, { runId: run.id });
		const { socket, request } = await connectControl(socketPath);
		try {
			const response = await request({
				type: "a2a_call",
				workerId: "worker-a2a-send",
				token: minted.token,
				toolName: "a2a_send",
				input: {
					kind: "question",
					targets: ["profile:reviewer"],
					bodyMd: "Please inspect this change.",
					requestId: "req-a2a-1",
				},
			});
			expect(response.ok).toBe(true);
			const result = response.result as {
				message: { id: string; bodyMd: string; authorId: string };
				queueEntry: { targets: string[] };
			};
			expect(result.message.authorId).toBe("profile:coder");
			expect(result.message.bodyMd).toContain("→ @Reviewer");
			expect(result.queueEntry.targets).toEqual(["profile:reviewer"]);

			const replay = await request({
				type: "a2a_call",
				workerId: "worker-a2a-send",
				token: minted.token,
				toolName: "a2a_send",
				input: {
					kind: "question",
					targets: ["profile:reviewer"],
					bodyMd: "Please inspect this change.",
					requestId: "req-a2a-1",
				},
			});
			expect(replay.ok).toBe(true);
			expect((replay.result as { message: { id: string } }).message.id).toBe(result.message.id);
		} finally {
			socket.destroy();
		}
	});

	it("rejects wrong worker, foreign run, non-A2A tools, and credential allowlist escapes", async () => {
		fixture = createW5BFixture();
		const socketPath = await fixture.runtime.start();
		const run = createBoundRun(fixture, {
			runId: "run-a2a-negative",
			workerId: "worker-a2a-negative",
			profileId: "profile:coder",
			sessionId: "session-coder",
		});
		const minted = mintInvocationCredential(fixture.store, { runId: run.id });
		fixture.store.profiles.create({
			id: "profile:restricted",
			role: "coder",
			displayName: "Restricted",
			provider: "test",
			model: "fake",
			modelFamily: "test",
			toolPolicyProfile: "default",
		});
		fixture.store.sessions.create({
			id: "session-restricted",
			threadId: "thread-w5b",
			taskId: "task-w5b",
			profileId: "profile:restricted",
			role: "coder",
			effectiveToolPolicy: "default",
			provider: "test",
			model: "fake",
			modelFamily: "test",
			seq: 1,
			userId: "user-1",
		});
		const restrictedRun = createBoundRun(fixture, {
			runId: "run-a2a-restricted",
			workerId: "worker-a2a-restricted",
			profileId: "profile:restricted",
			sessionId: "session-restricted",
		});
		const restricted = mintInvocationCredential(fixture.store, {
			runId: restrictedRun.id,
			toolPolicy: { allowedTools: ["read"] },
		});
		const { socket, request } = await connectControl(socketPath);
		try {
			const wrongWorker = await request({
				type: "a2a_call",
				workerId: "worker-other",
				token: minted.token,
				toolName: "a2a_send",
				input: { kind: "question", targets: ["profile:reviewer"], bodyMd: "x" },
			});
			expect(wrongWorker).toMatchObject({ ok: false, error: { code: "forbidden" } });

			const nonA2A = await request({
				type: "a2a_call",
				workerId: "worker-a2a-negative",
				token: minted.token,
				toolName: "merge_execute",
				input: {},
			});
			expect(nonA2A).toMatchObject({ ok: false, error: { code: "invalid_input" } });

			const allowlist = await request({
				type: "a2a_call",
				workerId: "worker-a2a-restricted",
				token: restricted.token,
				toolName: "a2a_send",
				input: { kind: "question", targets: ["profile:reviewer"], bodyMd: "x" },
			});
			expect(allowlist).toMatchObject({ ok: false, error: { code: "forbidden" } });
			expect(fixture.store.messages.listThread("thread-w5b").some((message) => message.bodyMd === "x")).toBe(false);
		} finally {
			socket.destroy();
		}
	});

	it("denies a credential with an empty allowlist instead of treating it as allow-all", async () => {
		fixture = createW5BFixture();
		const socketPath = await fixture.runtime.start();
		const run = createBoundRun(fixture, {
			runId: "run-empty-policy",
			workerId: "worker-empty-policy",
			profileId: "profile:coder",
			sessionId: "session-coder",
		});
		const minted = mintInvocationCredential(fixture.store, { runId: run.id, toolPolicy: {} });
		expect(minted.credential.toolPolicy.allowedTools).toBeUndefined();
		const { socket, request } = await connectControl(socketPath);
		try {
			const readPolicy = await request({
				type: "tool_policy",
				workerId: "worker-empty-policy",
				token: minted.token,
				toolName: "read",
				input: { path: "README.md" },
			});
			expect(readPolicy).toMatchObject({ ok: false, error: { code: "forbidden" } });
			const a2a = await request({
				type: "a2a_call",
				workerId: "worker-empty-policy",
				token: minted.token,
				toolName: "a2a_send",
				input: { kind: "question", targets: ["profile:reviewer"], bodyMd: "must not send" },
			});
			expect(a2a).toMatchObject({ ok: false, error: { code: "forbidden" } });
			expect(
				fixture.store.messages.listThread("thread-w5b").some((message) => message.bodyMd.includes("must not send")),
			).toBe(false);
		} finally {
			socket.destroy();
		}
	});
});
