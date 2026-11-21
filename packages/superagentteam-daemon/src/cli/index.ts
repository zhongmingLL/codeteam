import { initOperatorCredential } from "../auth/operator.ts";
import { createConsoleToken } from "../api/console-link.ts";
import { resolveControlDataDir } from "../control/database.ts";
import { ControlError } from "../control/errors.ts";
import { resolveDaemonPaths } from "../paths.ts";
import { readStateFile } from "../state.ts";
import { runApprovalCommand } from "./approval.ts";
import { flag, option, parseArgs } from "./args.ts";
import { runBacklogCommand } from "./backlog.ts";
import { runBudgetCommand } from "./budget.ts";
import { openCliContext } from "./context.ts";
import { runDaemonCommand } from "./daemon.ts";
import { runDeploymentCommand } from "./deployment.ts";
import { runEvalCommand } from "./eval.ts";
import { runGateCommand } from "./gate.ts";
import { runMemoryCommand } from "./memory.ts";
import { runMergeCommand } from "./merge.ts";
import { writeJson, writeLine } from "./output.ts";
import { runProfileCommand } from "./profile.ts";
import { runScheduleCommand } from "./schedule.ts";
import { runSessionCommand } from "./session.ts";
import { runSopCommand } from "./sop.ts";
import { runTaskCommand, runThreadCommand } from "./thread.ts";
import { runA2AThreadCommand } from "./thread-a2a.ts";

export async function runCli(argv: readonly string[]): Promise<number> {
	const { argvWithoutGlobals, globals } = extractGlobalOptions(argv);
	const [command, ...rest] = argvWithoutGlobals;
	if (command === "auth" && rest[0] === "init") return runAuthInit([...rest.slice(1), ...globals]);
	if (command === "auth" && rest[0] === "console-link") return runAuthConsoleLink([...rest.slice(1), ...globals]);
	if (command === "memory") return runMemoryCommand([...rest, ...globals]);
	if (!command || command === "help" || command === "--help") {
		writeUsage();
		return 0;
	}
	const args = parseArgs(
		[...rest, ...globals],
		[
			"json",
			"follow",
			"help",
			"hard-gate",
			"spec-change",
			"allow-unsynced-base",
			"allow-primary-worktree",
			"clear",
			"new-boot",
		],
	);
	if (flag(args, "help")) {
		writeUsage();
		return 0;
	}
	if (command === "thread") {
		const engine = option(args, "engine") ?? "a2a";
		if (engine === "a2a") {
			return await runA2AThreadCommand(args, {
				dataDir: resolveControlDataDir(option(args, "data-dir")),
				json: flag(args, "json"),
			});
		}
		if (engine !== "legacy") {
			throw new ControlError("invalid_input", `unknown thread engine ${engine}; use a2a or legacy`);
		}
	}
	const context = openCliContext(args);
	try {
		if (command === "backlog") return runBacklogCommand(args, context);
		if (command === "sop") return runSopCommand(args, context);
		if (command === "thread") return await runThreadCommand(args, context);
		if (command === "task") return runTaskCommand(args, context);
		if (command === "approval") return runApprovalCommand(args, context);
		if (command === "budget") return runBudgetCommand(args, context);
		if (command === "deployment") return runDeploymentCommand(args, context);
		if (command === "daemon") return await runDaemonCommand(args, context);
		if (command === "schedule") return runScheduleCommand(args, context);
		if (command === "session") return runSessionCommand(args, context);
		if (command === "profile") return runProfileCommand(args, context);
		if (command === "gate") return runGateCommand(args, context);
		if (command === "merge") return runMergeCommand(args, context);
		if (command === "eval") return runEvalCommand(args, context);
		throw new ControlError("invalid_input", `unknown command ${command}`);
	} finally {
		context.store.close();
	}
}

function extractGlobalOptions(argv: readonly string[]): { argvWithoutGlobals: string[]; globals: string[] } {
	const argvWithoutGlobals: string[] = [];
	const globals: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]!;
		if (arg === "--data-dir") {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) {
				throw new ControlError("invalid_input", "--data-dir requires a value");
			}
			globals.push("--data-dir", value);
			index += 1;
			continue;
		}
		if (arg.startsWith("--data-dir=")) {
			globals.push(arg);
			continue;
		}
		if (arg === "--json") {
			globals.push(arg);
			continue;
		}
		argvWithoutGlobals.push(arg);
	}
	return { argvWithoutGlobals, globals };
}

function runAuthInit(argv: readonly string[]): number {
	const args = parseArgs(argv, ["rotate"]);
	const dataDir = option(args, "data-dir");
	const resolved = resolveControlDataDir(dataDir);
	const paths = initOperatorCredential({ dataDir: resolved, rotate: flag(args, "rotate") });
	writeJson({ dataDir: resolved, publicKeyPath: paths.publicKeyPath, fingerprint: paths.fingerprint });
	return 0;
}

function runAuthConsoleLink(argv: readonly string[]): number {
	const args = parseArgs(argv, ["json"]);
	const dataDir = resolveControlDataDir(option(args, "data-dir"));
	const paths = resolveDaemonPaths(dataDir);
	const state = readStateFile(paths.stateFile);
	if (!state?.healthPort) {
		throw new ControlError("invalid_state", "daemon is not running or has no health port; start the daemon first");
	}
	const ttlText = option(args, "ttl-ms");
	const ttlMs = ttlText === undefined ? undefined : Number(ttlText);
	if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
		throw new ControlError("invalid_input", "--ttl-ms must be a positive number");
	}
	const created = createConsoleToken({ dataDir, ttlMs });
	const url = `http://127.0.0.1:${state.healthPort}/auth/console?token=${encodeURIComponent(created.token)}`;
	if (flag(args, "json")) writeJson({ url, expiresAt: created.payload.exp });
	else writeLine(url);
	return 0;
}

function writeUsage(): void {
	writeLine("usage: superagentteam <command> [options]");
	writeLine("commands:");
	writeLine("  auth init [--data-dir <path>] [--rotate]");
	writeLine("  auth console-link [--data-dir <path>] [--ttl-ms <ms>]");
	writeLine("  backlog <create|list|show|approve|dispatch|done|depend>");
	writeLine("  sop <catalog|show|update|evidence>");
	writeLine("  thread <create|list|show|post|tail> [--engine a2a|legacy]");
	writeLine("  task <create|list|status|readiness>");
	writeLine("  approval <request|list|show|approve|reject>");
	writeLine("  budget <set|show> <taskId>");
	writeLine("  deployment wait <register|status|sweep> ...");
	writeLine("  daemon <status|stop>");
	writeLine("  schedule <add|list|show|pause|resume|tick>");
	writeLine("  session <list|show>");
	writeLine("  profile <seed|add|list>");
	writeLine("  gate <check|telemetry>");
	writeLine("  merge <plan|execute|record>");
	writeLine("  eval <list|open|overdue|show|accept-sunset>");
	writeLine("  memory <index|status|recall|read|digest|trigger>");
	writeLine("global options: --data-dir <path> --json");
	writeLine("  global options may precede the command");
	writeLine("backlog create: --title --summary --tag feature:<id> [--priority p0-p3] [--project]");
	writeLine("backlog create dependencies: [--depends-on <backlogId> ...]");
	writeLine("backlog depend: <id> [--on <backlogId> ... | --clear]");
	writeLine("backlog dispatch: <id> --to <profile> [--phase coding|research|brainstorm] [--body]");
	writeLine("thread create: --project-path <path> [--title <text>] [--id <threadId>]");
	writeLine("thread post: <threadId> <body> [--to <agentId> ...] [--id <messageId>] [--engine a2a|legacy]");
	writeLine("thread post replay: same --id + omitted --to reuses stored targets; different --to conflicts");
	writeLine("thread tail: <threadId> [--after-seq N] [--follow] [--interval-ms N]");
	writeLine("sop evidence: <backlogId> <check> <evidenceRef> --subject-revision <sha>");
	writeLine("sop update: <backlogId> --stage <stage> --baton <profile|operator> --focus <text>");
	writeLine("approval request: --task --thread --kind --idempotency-key [--requester profile:<id>]");
	writeLine("merge execute: --task --repo --worktree --base --head [--hard-gate --approval <id>]");
	writeLine("budget set: <taskId> [--tokens N] [--cost N] [--wall-time-ms N]");
	writeLine("deployment wait register: <taskId> (--revision <sha> | --new-boot) --to <profile> [--services daemon]");
	writeLine("schedule add: --task --thread [--factory task_wake] [--every-ms N] [--to <profile> ...] [--body]");
	writeLine("task create budget: [--budget-tokens N] [--budget-cost N] [--budget-wall-time-ms N]");
	writeLine("task prepare: <taskId> --profile <profile> [--profile ...] [--role <role>] [--worktree <path>]");
}
