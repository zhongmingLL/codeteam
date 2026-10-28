import { initOperatorCredential } from "../auth/operator.ts";
import { resolveControlDataDir } from "../control/database.ts";
import { ControlError } from "../control/errors.ts";
import { runApprovalCommand } from "./approval.ts";
import { flag, option, parseArgs } from "./args.ts";
import { runBacklogCommand } from "./backlog.ts";
import { openCliContext } from "./context.ts";
import { runGateCommand } from "./gate.ts";
import { runMergeCommand } from "./merge.ts";
import { writeJson, writeLine } from "./output.ts";
import { runSopCommand } from "./sop.ts";
import { runTaskCommand, runThreadCommand } from "./thread.ts";

export async function runCli(argv: readonly string[]): Promise<number> {
	const [command, ...rest] = argv;
	if (command === "auth" && rest[0] === "init") return runAuthInit(rest.slice(1));
	if (!command || command === "help" || command === "--help") {
		writeUsage();
		return 0;
	}
	const args = parseArgs(rest, [
		"json",
		"follow",
		"help",
		"hard-gate",
		"spec-change",
		"allow-unsynced-base",
		"allow-primary-worktree",
	]);
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
		if (command === "gate") return runGateCommand(args, context);
		if (command === "merge") return runMergeCommand(args, context);
		throw new ControlError("invalid_input", `unknown command ${command}`);
	} finally {
		context.store.close();
	}
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
	writeLine("  backlog <create|list|show|approve|dispatch|done>");
	writeLine("  sop <catalog|show|update|evidence>");
	writeLine("  thread <list|show|post|tail>");
	writeLine("  task <create|list|status>");
	writeLine("  approval <request|list|show|approve|reject>");
	writeLine("  gate <check|telemetry>");
	writeLine("  merge <plan|execute|record>");
	writeLine("global options: --data-dir <path> --json");
}
