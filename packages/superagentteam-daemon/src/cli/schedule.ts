import { ControlError } from "../control/errors.ts";
import type { ScheduleRunSpec, ScheduleSpec, ScheduleTrigger } from "../control/stores/types.ts";
import { ProactiveScheduleService } from "../scheduling/schedule.ts";
import { numberOption, option, options, type ParsedArgs, requireOption } from "./args.ts";
import { type CliContext, requireOperator } from "./context.ts";
import { writeJson, writeLine, writeTable } from "./output.ts";

function usage(): never {
	throw new ControlError("invalid_input", "usage: codeteam schedule <add|list|show|pause|resume|tick> ...");
}

export function runScheduleCommand(args: ParsedArgs, context: CliContext): number {
	const subcommand = args.positionals[0];
	if (subcommand === "add") return addSchedule(args, context);
	if (subcommand === "list") return listSchedules(args, context);
	if (subcommand === "show") return showSchedule(args, context);
	if (subcommand === "pause" || subcommand === "resume") return changeScheduleStatus(args, context, subcommand);
	if (subcommand === "tick") return tickSchedules(args, context);
	usage();
}

function addSchedule(args: ParsedArgs, context: CliContext): number {
	const operator = requireOperator(context);
	const taskId = requireOption(args, "task");
	const threadId = requireOption(args, "thread");
	const factoryId = option(args, "factory") ?? "task_wake";
	const targets = options(args, "to");
	if (targets.length === 0) throw new ControlError("invalid_input", "--to <profile> is required");
	const body = option(args, "body") ?? "Scheduled wake";
	const everyMs = numberOption(args, "every-ms");
	const trigger: ScheduleTrigger =
		everyMs === undefined
			? { kind: "manual" }
			: { kind: "timer", everyMs, firstRunAt: numberOption(args, "first-run-at") ?? null };
	const priority = (option(args, "priority") ?? "normal") as "urgent" | "normal";
	if (priority !== "urgent" && priority !== "normal") {
		throw new ControlError("invalid_input", "--priority must be urgent or normal");
	}
	const runSpec: ScheduleRunSpec = {
		bodyMd: body,
		messageKind: "status",
		authorKind: "system",
		authorId: `user:${operator.id}`,
	};
	const spec = new ProactiveScheduleService(context.store).register({
		taskId,
		threadId,
		factoryId,
		trigger,
		admission: { targets, priority },
		runSpec,
	});
	if (context.json) writeJson(spec);
	else writeLine(`registered ${spec.id} task=${spec.taskId} factory=${spec.factoryId} trigger=${spec.trigger.kind}`);
	return 0;
}

function listSchedules(args: ParsedArgs, context: CliContext): number {
	const specs = context.store.schedules.list({
		taskId: option(args, "task"),
		status: (option(args, "status") as ScheduleSpec["status"] | undefined) ?? undefined,
	});
	if (context.json) {
		writeJson(specs);
		return 0;
	}
	writeTable(specs, [
		{ header: "id", value: (spec) => spec.id },
		{ header: "status", value: (spec) => spec.status },
		{ header: "task", value: (spec) => spec.taskId },
		{ header: "factory", value: (spec) => spec.factoryId },
		{ header: "next", value: (spec) => String(spec.state.nextRunAt ?? "-") },
	]);
	return 0;
}

function showSchedule(args: ParsedArgs, context: CliContext): number {
	const id = args.positionals[1];
	if (!id) throw new ControlError("invalid_input", "usage: codeteam schedule show <id>");
	const spec = context.store.schedules.get(id);
	if (!spec) throw new ControlError("not_found", `schedule spec ${id} not found`);
	const runs = context.store.schedules.listRuns(id, numberOption(args, "limit") ?? 50);
	if (context.json) {
		writeJson({ spec, runs });
		return 0;
	}
	writeLine(`${spec.id} ${spec.status} task=${spec.taskId} factory=${spec.factoryId}`);
	writeLine(`trigger: ${JSON.stringify(spec.trigger)}`);
	writeLine(`nextRunAt: ${spec.state.nextRunAt ?? "-"}`);
	for (const run of runs) {
		writeLine(`${run.scheduledFor} ${run.status} queue=${run.queueEntryId ?? "-"} ${JSON.stringify(run.reason)}`);
	}
	return 0;
}

function changeScheduleStatus(args: ParsedArgs, context: CliContext, subcommand: "pause" | "resume"): number {
	const operator = requireOperator(context);
	const id = args.positionals[1];
	if (!id) throw new ControlError("invalid_input", `usage: codeteam schedule ${subcommand} <id>`);
	const service = new ProactiveScheduleService(context.store);
	const spec =
		subcommand === "pause" ? service.pause(id, `user:${operator.id}`) : service.resume(id, `user:${operator.id}`);
	if (context.json) writeJson(spec);
	else writeLine(`${subcommand}d ${spec.id} status=${spec.status}`);
	return 0;
}

function tickSchedules(args: ParsedArgs, context: CliContext): number {
	const operator = requireOperator(context);
	const now = numberOption(args, "at") ?? Date.now();
	const result = new ProactiveScheduleService(context.store).tick(now);
	context.store.audit.append({
		actor: `user:${operator.id}`,
		action: "schedule_tick",
		subject: "schedule:tick",
		args: { at: now, materialized: result.materialized.length, skipped: result.skipped.length },
	});
	if (context.json) writeJson(result);
	else {
		writeLine(
			`materialized=${result.materialized.length} skipped=${result.skipped.length} duplicates=${result.duplicates.length}`,
		);
		for (const run of result.materialized) writeLine(`queued ${run.occurrenceKey} -> ${run.queueEntryId}`);
		for (const run of result.skipped) writeLine(`skipped ${run.occurrenceKey} ${JSON.stringify(run.reason)}`);
	}
	return 0;
}
