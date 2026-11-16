import { ControlError } from "../control/errors.ts";
import type { ApprovalKind, ApprovalResolution } from "../control/stores/types.ts";
import { numberOption, option, type ParsedArgs, requireOption } from "./args.ts";
import { type CliContext, requireOperator } from "./context.ts";
import { writeJson, writeLine, writeTable } from "./output.ts";

const KINDS = new Set<ApprovalKind>(["merge", "design_gate", "spec_change", "blocker", "budget_pause"]);
const RESOLUTIONS = new Set<ApprovalResolution>(["open", "accepted", "rejected", "closed_without_decision"]);

function parseJsonObject(value: string | undefined, name: string): Record<string, unknown> | undefined {
	if (value === undefined) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (error) {
		throw new ControlError("invalid_input", `--${name} must be valid JSON`, { cause: error });
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ControlError("invalid_input", `--${name} must be a JSON object`);
	}
	return parsed as Record<string, unknown>;
}

export function runApprovalCommand(args: ParsedArgs, context: CliContext): number {
	const subcommand = args.positionals[0];
	if (subcommand === "request") return requestApproval(args, context);
	if (subcommand === "list") return listApprovals(args, context);
	if (subcommand === "show") return showApproval(args, context);
	if (subcommand === "approve") return decideApproval(args, context, "accepted");
	if (subcommand === "reject") return decideApproval(args, context, "rejected");
	throw new ControlError("invalid_input", "usage: codeteam approval <request|list|show|approve|reject>");
}

function requestApproval(args: ParsedArgs, context: CliContext): number {
	const kind = requireOption(args, "kind") as ApprovalKind;
	if (!KINDS.has(kind)) throw new ControlError("invalid_input", `unknown approval kind ${kind}`);
	const requestedBy = resolveRequester(args, context);
	const approval = context.store.approvals.create({
		threadId: requireOption(args, "thread"),
		taskId: requireOption(args, "task"),
		kind,
		idempotencyKey: requireOption(args, "idempotency-key"),
		originRef: parseJsonObject(option(args, "origin-json"), "origin-json") ?? {},
		cardRef: parseJsonObject(option(args, "card-json"), "card-json") ?? {},
		payload: parseJsonObject(option(args, "payload-json"), "payload-json") ?? {},
		requestedBy,
		expiresAt: numberOption(args, "expires-at"),
	});
	if (context.json) writeJson(approval);
	else writeLine(`requested approval ${approval.id} kind=${approval.kind} resolution=${approval.resolution}`);
	return 0;
}

function resolveRequester(args: ParsedArgs, context: CliContext): string {
	const explicit = option(args, "requester");
	if (explicit) {
		const candidate = explicit.startsWith("profile:") ? explicit : `profile:${explicit}`;
		const profile = context.store.profiles.get(candidate) ?? context.store.profiles.get(explicit);
		if (!profile || profile.status !== "active") {
			throw new ControlError("not_found", `active agent profile ${explicit} not found`);
		}
		return profile.id;
	}
	try {
		return requireOperator(context).id;
	} catch (error) {
		if (error instanceof ControlError && error.code === "not_found") {
			throw new ControlError(
				"invalid_input",
				"approval request needs --requester <profile> when no operator credential is initialized",
			);
		}
		throw error;
	}
}

function listApprovals(args: ParsedArgs, context: CliContext): number {
	const resolution = option(args, "resolution") as ApprovalResolution | undefined;
	if (resolution && !RESOLUTIONS.has(resolution)) {
		throw new ControlError("invalid_input", `unknown approval resolution ${resolution}`);
	}
	const kind = option(args, "kind") as ApprovalKind | undefined;
	if (kind && !KINDS.has(kind)) throw new ControlError("invalid_input", `unknown approval kind ${kind}`);
	const approvals = context.store.approvals.list({
		taskId: option(args, "task"),
		kind,
		resolution,
	});
	if (context.json) {
		writeJson(approvals);
		return 0;
	}
	writeTable(approvals, [
		{ header: "id", value: (approval) => approval.id },
		{ header: "kind", value: (approval) => approval.kind },
		{ header: "resolution", value: (approval) => approval.resolution },
		{ header: "task", value: (approval) => approval.taskId },
		{ header: "requestedBy", value: (approval) => approval.requestedBy },
	]);
	return 0;
}

function showApproval(args: ParsedArgs, context: CliContext): number {
	const id = args.positionals[1];
	if (!id) throw new ControlError("invalid_input", "usage: codeteam approval show <id>");
	const approval = context.store.approvals.get(id);
	if (!approval) throw new ControlError("not_found", `approval ${id} not found`);
	if (context.json) writeJson(approval);
	else {
		writeLine(`${approval.id}  ${approval.kind}  ${approval.resolution}`);
		writeLine(`task: ${approval.taskId} thread: ${approval.threadId}`);
		writeLine(`requestedBy: ${approval.requestedBy}`);
		if (approval.decidedBy) writeLine(`decidedBy: ${approval.decidedBy} at ${approval.decidedAt}`);
		if (approval.decidedNote) writeLine(`note: ${approval.decidedNote}`);
		writeLine(`payload: ${JSON.stringify(approval.payload)}`);
	}
	return 0;
}

function decideApproval(args: ParsedArgs, context: CliContext, resolution: "accepted" | "rejected"): number {
	const operator = requireOperator(context);
	const id = args.positionals[1];
	if (!id)
		throw new ControlError(
			"invalid_input",
			`usage: codeteam approval ${resolution === "accepted" ? "approve" : "reject"} <id>`,
		);
	const approval = context.store.approvals.decide(id, {
		resolution,
		decidedBy: operator.id,
		note: option(args, "note"),
	});
	if (context.json) writeJson(approval);
	else writeLine(`${approval.resolution} ${approval.id} by ${approval.decidedBy}`);
	return 0;
}
