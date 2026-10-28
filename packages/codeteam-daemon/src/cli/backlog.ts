import { ControlError } from "../control/errors.ts";
import type { BacklogPriority, BacklogStatus, ThreadPhase } from "../control/stores/types.ts";
import { numberOption, option, options, type ParsedArgs, requireOption } from "./args.ts";
import { type CliContext, requireOperator } from "./context.ts";
import { writeJson, writeLine, writeTable } from "./output.ts";

const STATUSES = new Set<BacklogStatus>(["open", "suggested", "approved", "dispatched", "done"]);
const PRIORITIES = new Set<BacklogPriority>(["p0", "p1", "p2", "p3"]);
const PHASES = new Set<ThreadPhase>(["coding", "research", "brainstorm"]);

function statusOption(value: string | undefined): BacklogStatus | undefined {
	if (value === undefined) return undefined;
	if (!STATUSES.has(value as BacklogStatus))
		throw new ControlError("invalid_input", `unknown backlog status ${value}`);
	return value as BacklogStatus;
}

function priorityOption(value: string | undefined): BacklogPriority | undefined {
	if (value === undefined) return undefined;
	if (!PRIORITIES.has(value as BacklogPriority))
		throw new ControlError("invalid_input", `unknown backlog priority ${value}`);
	return value as BacklogPriority;
}

function phaseOption(value: string | undefined): ThreadPhase {
	const phase = (value ?? "coding") as ThreadPhase;
	if (!PHASES.has(phase)) throw new ControlError("invalid_input", `unknown thread phase ${value}`);
	return phase;
}

export function runBacklogCommand(args: ParsedArgs, context: CliContext): number {
	const subcommand = args.positionals[0];
	if (subcommand === "create") return createBacklog(args, context);
	if (subcommand === "list") return listBacklog(args, context);
	if (subcommand === "show") return showBacklog(args, context);
	if (subcommand === "approve") return approveBacklog(args, context);
	if (subcommand === "dispatch") return dispatchBacklog(args, context);
	if (subcommand === "done") return doneBacklog(args, context);
	throw new ControlError("invalid_input", "usage: codeteam backlog <create|list|show|approve|dispatch|done>");
}

function createBacklog(args: ParsedArgs, context: CliContext): number {
	const operator = requireOperator(context);
	const title = requireOption(args, "title");
	const summary = requireOption(args, "summary");
	const tags = options(args, "tag");
	if (tags.length === 0) throw new ControlError("invalid_input", "--tag is required (for example --tag feature:F007)");
	if (!tags.some((tag) => tag.startsWith("feature:"))) {
		throw new ControlError("invalid_input", "at least one --tag must be feature:<id>");
	}
	const priority = priorityOption(option(args, "priority")) ?? "p2";
	const status = statusOption(option(args, "status")) ?? "open";
	const item = context.store.backlog.create({
		userId: option(args, "user") ?? operator.id,
		projectId: option(args, "project") ?? null,
		title,
		summary,
		priority,
		tags,
		createdByKind: "user",
		createdById: operator.id,
		initialStatus: status,
		importReason: option(args, "reason"),
	});
	if (context.json) writeJson(item);
	else writeLine(`created ${item.id} status=${item.status} priority=${item.priority}`);
	return 0;
}

function listBacklog(args: ParsedArgs, context: CliContext): number {
	const items = context.store.backlog.list({
		status: statusOption(option(args, "status")),
		priority: priorityOption(option(args, "priority")),
		projectId: option(args, "project"),
		limit: numberOption(args, "limit"),
	});
	if (context.json) {
		writeJson(items);
		return 0;
	}
	writeTable(items, [
		{ header: "id", value: (item) => item.id },
		{ header: "status", value: (item) => item.status },
		{ header: "priority", value: (item) => item.priority },
		{ header: "title", value: (item) => item.title },
	]);
	return 0;
}

function showBacklog(args: ParsedArgs, context: CliContext): number {
	const id = args.positionals[1];
	if (!id) throw new ControlError("invalid_input", "usage: codeteam backlog show <id>");
	const item = context.store.backlog.getView(id, numberOption(args, "audit-limit") ?? 100);
	if (!item) throw new ControlError("not_found", `backlog item ${id} not found`);
	const sop = context.store.sops.get(id);
	const threads = context.store.threads.list({ backlogItemId: id });
	if (context.json) {
		writeJson({ ...item, sop, threads });
		return 0;
	}
	writeLine(`${item.id}  ${item.status}  ${item.priority}  ${item.title}`);
	writeLine(`summary: ${item.summary}`);
	writeLine(`tags: ${item.tags.join(", ")}`);
	writeLine(`createdBy: ${item.createdByKind}:${item.createdById}`);
	if (item.dispatchedThreadId) writeLine(`thread: ${item.dispatchedThreadId} (${item.dispatchedThreadPhase})`);
	if (sop) writeLine(`sop: stage=${sop.stage} baton=${sop.batonHolder} version=${sop.version}`);
	writeLine(`audit: ${item.audit.length}${item.auditTruncated ? ` (truncated, cursor=${item.auditCursor})` : ""}`);
	for (const entry of item.audit.slice(0, 10)) writeLine(`  ${entry.ts} ${entry.actor} ${entry.action}`);
	return 0;
}

function approveBacklog(args: ParsedArgs, context: CliContext): number {
	const operator = requireOperator(context);
	const id = args.positionals[1];
	if (!id) throw new ControlError("invalid_input", "usage: codeteam backlog approve <id>");
	const current = context.store.backlog.get(id);
	if (!current) throw new ControlError("not_found", `backlog item ${id} not found`);
	let item = current;
	if (current.status === "suggested") {
		item = context.store.backlog.decideSuggestion(id, { decision: "approve", decidedBy: operator.id });
	} else if (current.status === "open") {
		item = context.store.backlog.approve(id, operator.id);
	} else if (current.status !== "approved") {
		throw new ControlError("invalid_state", `backlog item ${id} cannot be approved from ${current.status}`);
	}
	if (context.json) writeJson(item);
	else writeLine(`approved ${item.id} status=${item.status}`);
	return 0;
}

function dispatchBacklog(args: ParsedArgs, context: CliContext): number {
	const operator = requireOperator(context);
	const id = args.positionals[1];
	if (!id) throw new ControlError("invalid_input", "usage: codeteam backlog dispatch <id> --to <profile>");
	const targets = options(args, "to");
	if (targets.length === 0) throw new ControlError("invalid_input", "--to <profile> is required");
	const current = context.store.backlog.get(id);
	if (!current) throw new ControlError("not_found", `backlog item ${id} not found`);
	if (current.status === "open") {
		context.store.backlog.approve(id, operator.id);
	}
	const result = context.store.dispatchBacklog({
		backlogItemId: id,
		targets,
		threadPhase: phaseOption(option(args, "phase")),
		dispatchAttemptId: option(args, "attempt-id"),
		title: option(args, "title"),
		repo: option(args, "repo") ?? null,
		kickoffBody: option(args, "body"),
	});
	if (context.json) writeJson(result);
	else {
		writeLine(`dispatched ${result.backlog.id} thread=${result.thread.id}`);
		writeLine(
			`message=${result.message.id} queue=${result.queueEntry.id} targets=${result.queueEntry.targets.join(",")}`,
		);
	}
	return 0;
}

function doneBacklog(args: ParsedArgs, context: CliContext): number {
	const operator = requireOperator(context);
	const id = args.positionals[1];
	if (!id) throw new ControlError("invalid_input", "usage: codeteam backlog done <id> [--reason <text>]");
	const current = context.store.backlog.get(id);
	if (!current) throw new ControlError("not_found", `backlog item ${id} not found`);
	const reason = option(args, "reason");
	const item =
		current.status === "dispatched"
			? context.store.backlog.markDone(id, operator.id)
			: reason
				? context.store.backlog.overrideDone(id, reason, operator.id)
				: (() => {
						throw new ControlError("invalid_input", "done override requires --reason");
					})();
	if (context.json) writeJson(item);
	else writeLine(`done ${item.id}`);
	return 0;
}
