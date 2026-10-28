import { initOperatorCredential } from "../auth/operator.ts";
import { resolveControlDataDir } from "../control/database.ts";
import { ControlError } from "../control/errors.ts";
import { runApprovalCommand } from "./approval.ts";
import { flag, option, parseArgs } from "./args.ts";
import { runBacklogCommand } from "./backlog.ts";
import { runBudgetCommand } from "./budget.ts";
import { openCliContext } from "./context.ts";
import { runGateCommand } from "./gate.ts";
import { runMergeCommand } from "./merge.ts";
import { writeJson, writeLine } from "./output.ts";
import { runProfileCommand } from "./profile.ts";
import { runScheduleCommand } from "./schedule.ts";
import { runSopCommand } from "./sop.ts";
import { runTaskCommand, runThreadCommand } from "./thread.ts";

export async function runCli(argv: readonly string[]): Promise<number> {
	const { argvWithoutGlobals, globals } = extractGlobalOptions(argv);
	const [command, ...rest] = argvWithoutGlobals;
	if (command === "auth" && rest[0] === "init") return runAuthInit([...rest.slice(1), ...globals]);
	if (!command || command === "help" || command === "--help") {
		writeUsage();
		return 0;
	}
	const args = parseArgs(
		[...rest, ...globals],
		["json", "follow", "help", "hard-gate", "spec-change", "allow-unsynced-base", "allow-primary-worktree", "clear"],
	);
	if (flag(args, "help")) {
		writeUsage();
		return 0;
	}
	const context = openCliContext(args);
	try {
		if (command === "backlog") return runBacklogCommand(args, context);
		if (command === "sop") return runSopCommand(args, context);
		if (command === "thread") return await runThreadCommand(args, context);
		if (command === "task") return runTaskCommand(args, context);
		if (command === "approval") return runApprovalCommand(args, context);
		if (command === "budget") return runBudgetCommand(args, context);
		if (command === "schedule") return runScheduleCommand(args, context);
		if (command === "profile") return runProfileCommand(args, context);
		if (command === "gate") return runGateCommand(args, context);
		if (command === "merge") return runMergeCommand(args, context);
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

function writeUsage(): void {
	writeLine("usage: codeteam <command> [options]");
	writeLine("commands:");
	writeLine("  auth init [--data-dir <path>] [--rotate]");
	writeLine("  backlog <create|list|show|approve|dispatch|done|depend>");
	writeLine("  sop <catalog|show|update|evidence>");
	writeLine("  thread <list|show|post|tail>");
	writeLine("  task <create|list|status|readiness>");
	writeLine("  approval <request|list|show|approve|reject>");
	writeLine("  budget <set|show> <taskId>");
	writeLine("  schedule <add|list|show|pause|resume|tick>");
	writeLine("  profile <seed|add|list>");
	writeLine("  gate <check|telemetry>");
	writeLine("  merge <plan|execute|record>");
	writeLine("global options: --data-dir <path> --json");
	writeLine("  global options may precede the command");
	writeLine("backlog create: --title --summary --tag feature:<id> [--priority p0-p3] [--project]");
	writeLine("backlog create dependencies: [--depends-on <backlogId> ...]");
	writeLine("backlog depend: <id> [--on <backlogId> ... | --clear]");
	writeLine("backlog dispatch: <id> --to <profile> [--phase coding|research|brainstorm] [--body]");
	writeLine("thread post: <threadId> <body> [--to <profile>] [--kind chat]");
	writeLine("thread tail: <threadId> [--after-seq N] [--follow] [--interval-ms N]");
	writeLine("sop evidence: <backlogId> <check> <evidenceRef> --subject-revision <sha>");
	writeLine("sop update: <backlogId> --stage <stage> --baton <profile|operator> --focus <text>");
	writeLine("approval request: --task --thread --kind --idempotency-key [--requester profile:<id>]");
	writeLine("merge execute: --task --repo --worktree --base --head [--hard-gate --approval <id>]");
	writeLine("budget set: <taskId> [--tokens N] [--cost N] [--wall-time-ms N]");
	writeLine("schedule add: --task --thread [--factory task_wake] [--every-ms N] [--to <profile> ...] [--body]");
	writeLine("task create budget: [--budget-tokens N] [--budget-cost N] [--budget-wall-time-ms N]");
}
