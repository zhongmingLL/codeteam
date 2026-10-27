import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import { type CommandRequest, collectPathTargets, evaluateCommand } from "./commands.ts";
import { assertReadablePath, assertWritablePath } from "./paths.ts";
import { buildSandboxArgv, resolveBwrapPath, type SandboxConfig } from "./sandbox.ts";
import type { ToolPolicy } from "./types.ts";

export interface CommandResult {
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly truncated: boolean;
	readonly timedOut: boolean;
	readonly durationMs: number;
}

export interface RunCommandOptions {
	readonly timeoutMs?: number;
	readonly sandbox?: SandboxConfig | boolean;
	readonly audit?: CommandAuditContext;
}

export interface CommandAuditContext {
	readonly store: ControlStore;
	readonly actorRef: string;
	readonly runId?: string;
	readonly taskId?: string;
	readonly handoffId?: string;
	readonly agentSessionId?: string;
}

interface PathSnapshot {
	readonly arg: string;
	readonly mode: "read" | "write";
	readonly canonical: string;
	readonly dev: number | null;
	readonly ino: number | null;
}

export async function runCommand(
	policy: ToolPolicy,
	request: CommandRequest,
	options: RunCommandOptions = {},
): Promise<CommandResult> {
	const audit = options.audit;
	if (!audit) return runCommandInner(policy, request, options);
	try {
		const result = await runCommandInner(policy, request, options);
		appendCommandAudit(audit, request, policy, result, null);
		return result;
	} catch (error) {
		appendCommandAudit(audit, request, policy, null, error);
		throw error;
	}
}

async function runCommandInner(
	policy: ToolPolicy,
	request: CommandRequest,
	options: RunCommandOptions,
): Promise<CommandResult> {
	const execution = evaluateCommand(policy, request);
	const snapshots = snapshotPaths(policy, execution.argv, execution.cwd);
	assertSnapshotsStable(policy, snapshots, execution.cwd);
	const timeoutMs = options.timeoutMs ?? execution.timeoutMs;
	if (!options.sandbox) return execute(execution, timeoutMs);
	const sandboxConfig = options.sandbox === true ? {} : options.sandbox;
	const bwrapPath = resolveBwrapPath(sandboxConfig);
	const argv = buildSandboxArgv(policy, execution, { ...sandboxConfig, bwrapPath });
	return execute(
		{
			argv,
			cwd: execution.cwd,
			env: { ...execution.env, TMPDIR: execution.env.TMPDIR ?? "/tmp" },
			maxOutputBytes: execution.maxOutputBytes,
		},
		timeoutMs,
	);
}

function appendCommandAudit(
	context: CommandAuditContext,
	request: CommandRequest,
	policy: ToolPolicy,
	result: CommandResult | null,
	error: unknown,
): void {
	const args: Record<string, unknown> = {
		argv: request.argv.map(String),
		cwd: request.cwd ?? policy.cwd,
	};
	if (result) {
		args.exitCode = result.exitCode;
		args.signal = result.signal;
		args.durationMs = result.durationMs;
		args.truncated = result.truncated;
		args.timedOut = result.timedOut;
		args.stdoutTail = result.stdout.slice(-2000);
		args.stderrTail = result.stderr.slice(-2000);
	} else if (error instanceof ControlError) {
		args.errorCode = error.code;
		args.errorMessage = error.message;
	} else {
		args.errorMessage = String(error);
	}
	if (context.taskId) args.taskId = context.taskId;
	if (context.handoffId) args.handoffId = context.handoffId;
	if (context.agentSessionId) args.agentSessionId = context.agentSessionId;
	context.store.audit.append({
		actor: context.actorRef,
		action: error ? "tool_command_denied" : "tool_command",
		subject: context.runId ? `run:${context.runId}` : `tool:${request.argv[0] ?? "unknown"}`,
		args,
	});
}

function snapshotPaths(policy: ToolPolicy, argv: readonly string[], cwd: string): PathSnapshot[] {
	return collectPathTargets(argv[0] ?? "", argv).map((target) => {
		const canonical =
			target.mode === "read"
				? assertReadablePath(policy, target.arg, cwd)
				: assertWritablePath(policy, target.arg, cwd);
		try {
			const stats = lstatSync(canonical);
			return { ...target, canonical, dev: stats.dev, ino: stats.ino };
		} catch {
			return { ...target, canonical, dev: null, ino: null };
		}
	});
}

function assertSnapshotsStable(policy: ToolPolicy, snapshots: readonly PathSnapshot[], cwd: string): void {
	for (const snapshot of snapshots) {
		const canonical =
			snapshot.mode === "read"
				? assertReadablePath(policy, snapshot.arg, cwd)
				: assertWritablePath(policy, snapshot.arg, cwd);
		if (canonical !== snapshot.canonical) {
			throw new ControlError("forbidden", `path changed before execution: ${snapshot.arg}`);
		}
		if (snapshot.dev === null || snapshot.ino === null) continue;
		const stats = lstatSync(canonical);
		if (stats.dev !== snapshot.dev || stats.ino !== snapshot.ino) {
			throw new ControlError("forbidden", `path identity changed before execution: ${snapshot.arg}`);
		}
	}
}

interface SpawnSpec {
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly env: Record<string, string>;
	readonly maxOutputBytes: number;
}

function execute(execution: SpawnSpec, timeoutMs: number): Promise<CommandResult> {
	const [command, ...args] = execution.argv;
	if (!command) return Promise.reject(new ControlError("invalid_input", "empty command"));
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const child = spawn(command, args, {
			cwd: execution.cwd,
			env: execution.env,
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let captured = 0;
		let truncated = false;
		let timedOut = false;
		let settled = false;
		const append = (chunk: Buffer, target: Buffer[]) => {
			if (captured >= execution.maxOutputBytes) {
				truncated = true;
				child.kill("SIGKILL");
				return;
			}
			const remaining = execution.maxOutputBytes - captured;
			const slice = chunk.subarray(0, remaining);
			target.push(slice);
			captured += slice.length;
			if (slice.length < chunk.length) {
				truncated = true;
				child.kill("SIGKILL");
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.stdout?.on("data", (chunk: Buffer) => append(chunk, out));
		child.stderr?.on("data", (chunk: Buffer) => append(chunk, err));
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new ControlError("command_failed", `failed to spawn ${command}: ${error.message}`));
		});
		child.on("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				exitCode: code,
				signal,
				stdout: Buffer.concat(out).toString("utf8"),
				stderr: Buffer.concat(err).toString("utf8"),
				truncated,
				timedOut,
				durationMs: Date.now() - started,
			});
		});
	});
}
