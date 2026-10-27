import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ControlError,
	createToolPolicy,
	DEFAULT_COMMAND_ALLOWLIST,
	openControlStore,
	runCommand,
	type ToolPolicy,
} from "../src/index.ts";

const dirs: string[] = [];
let root: string;
let worktree: string;
let policy: ToolPolicy;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "codeteam-exec-"));
	dirs.push(root);
	mkdirSync(join(root, "data"), { recursive: true });
	worktree = join(root, "worktree");
	mkdirSync(join(worktree, "src"), { recursive: true });
	writeFileSync(join(worktree, "src", "a.ts"), "export const a = 1;\n");
	writeFileSync(join(worktree, "big.txt"), "x".repeat(5000));
	writeFileSync(join(worktree, ".env"), "SECRET=1");
	policy = createToolPolicy({ role: "coder", dataDir: join(root, "data"), worktreeRoot: worktree });
});

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("codeteam command executor", () => {
	it("runs an allowlisted command in the policy cwd", async () => {
		const result = await runCommand(policy, { argv: ["ls", "src"] });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("a.ts");
		expect(result.timedOut).toBe(false);
		expect(result.truncated).toBe(false);
	});

	it("returns the exit code and stderr for failing commands", async () => {
		const result = await runCommand(policy, { argv: ["git", "status"] });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.length).toBeGreaterThan(0);
	});

	it("caps captured output bytes", async () => {
		const capped = createToolPolicy({
			role: "coder",
			dataDir: join(root, "data"),
			worktreeRoot: worktree,
			maxOutputBytes: 100,
		});
		const result = await runCommand(capped, { argv: ["cat", "big.txt"] });
		expect(result.truncated).toBe(true);
		expect(result.stdout.length).toBeLessThanOrEqual(100);
	});

	it("stops commands that exceed the timeout", async () => {
		const withSleep = createToolPolicy({
			role: "coder",
			dataDir: join(root, "data"),
			worktreeRoot: worktree,
			allowedCommands: [...DEFAULT_COMMAND_ALLOWLIST, "sleep"],
		});
		const result = await runCommand(withSleep, { argv: ["sleep", "5"] }, { timeoutMs: 100 });
		expect(result.timedOut).toBe(true);
		expect(result.durationMs).toBeLessThan(4_000);
	});

	it("maps spawn failures to a typed error", async () => {
		const broken = createToolPolicy({
			role: "coder",
			dataDir: join(root, "data"),
			worktreeRoot: worktree,
			allowedCommands: ["definitely-not-a-real-command"],
		});
		await expect(runCommand(broken, { argv: ["definitely-not-a-real-command"] })).rejects.toMatchObject({
			code: "command_failed",
		});
	});

	it("keeps policy denials in front of execution", async () => {
		await expect(runCommand(policy, { argv: ["rm", "src/a.ts"] })).rejects.toBeInstanceOf(ControlError);
		await expect(runCommand(policy, { argv: ["cat", ".env"] })).rejects.toBeInstanceOf(ControlError);
		await expect(runCommand(policy, { argv: ["cat", "src/a.ts"] })).resolves.toMatchObject({ exitCode: 0 });
	});

	it("records command audit entries with args, outcome, and tails", async () => {
		const store = openControlStore({ dataDir: join(root, "data") });
		try {
			await runCommand(
				policy,
				{ argv: ["ls", "src"] },
				{
					audit: {
						store,
						actorRef: "run:run-1",
						runId: "run-1",
						taskId: "task-1",
						agentSessionId: "session-1",
					},
				},
			);
			const entry = store.audit.latest("run:run-1", "tool_command");
			expect(entry?.args).toMatchObject({
				argv: ["ls", "src"],
				exitCode: 0,
				taskId: "task-1",
				agentSessionId: "session-1",
			});
			expect(typeof entry?.args.durationMs).toBe("number");
			expect(typeof entry?.args.stdoutTail).toBe("string");
		} finally {
			store.close();
		}
	});

	it("audits denied commands with the typed error", async () => {
		const store = openControlStore({ dataDir: join(root, "data") });
		try {
			await expect(
				runCommand(
					policy,
					{ argv: ["rm", "src/a.ts"] },
					{ audit: { store, actorRef: "run:run-2", runId: "run-2" } },
				),
			).rejects.toBeInstanceOf(ControlError);
			const entry = store.audit.latest("run:run-2", "tool_command_denied");
			expect(entry?.args).toMatchObject({ argv: ["rm", "src/a.ts"], errorCode: "forbidden" });
		} finally {
			store.close();
		}
	});
});
