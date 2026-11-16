import { ControlError } from "../control/errors.ts";
import { BudgetService } from "../scheduling/budget.ts";
import { option, type ParsedArgs } from "./args.ts";
import { type CliContext, requireOperator } from "./context.ts";
import { writeJson, writeLine } from "./output.ts";

function usage(): never {
	throw new ControlError(
		"invalid_input",
		"usage: codeteam budget <set|show> <taskId> [--tokens N] [--cost N] [--wall-time-ms N]",
	);
}

export function runBudgetCommand(args: ParsedArgs, context: CliContext): number {
	const subcommand = args.positionals[0];
	const taskId = args.positionals[1];
	if (!taskId) usage();
	const service = new BudgetService(context.store);
	if (subcommand === "show") {
		const status = service.status(taskId);
		if (context.json) writeJson(status);
		else {
			if (!status.budget) {
				writeLine(`task ${taskId} has no budget`);
				return 0;
			}
			const budget = status.budget;
			writeLine(`task ${taskId} budget=${budget.id} paused=${status.paused}`);
			writeLine(`tokens: ${budget.tokensUsed}/${budget.tokensLimit ?? "unlimited"}`);
			writeLine(`cost: ${budget.costUsed}/${budget.costLimit ?? "unlimited"}`);
			writeLine(`wall_time_ms: ${budget.wallTimeUsedMs}/${budget.wallTimeLimitMs ?? "unlimited"}`);
			if (status.limitsHit.length > 0) writeLine(`limits_hit: ${status.limitsHit.join(",")}`);
			if (status.pauseApprovalId) writeLine(`pause_approval: ${status.pauseApprovalId}`);
			writeLine(`charges: ${status.charges.length}`);
		}
		return 0;
	}
	if (subcommand === "set") {
		const operator = requireOperator(context);
		const status = service.setLimits({
			taskId,
			tokensLimit: optionalNumber(args, "tokens"),
			costLimit: optionalNumber(args, "cost"),
			wallTimeLimitMs: optionalNumber(args, "wall-time-ms"),
			actorRef: `user:${operator.id}`,
		});
		if (context.json) writeJson(status);
		else writeLine(`budget set task=${taskId} paused=${status.paused}`);
		return 0;
	}
	usage();
}

function optionalNumber(args: ParsedArgs, name: string): number | null | undefined {
	const raw = option(args, name);
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) {
		throw new ControlError("invalid_input", `--${name} must be a non-negative number`);
	}
	return value;
}
