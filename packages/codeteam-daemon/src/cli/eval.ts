import { ControlError } from "../control/errors.ts";
import { readEvalArtifact } from "../eval/artifacts.ts";
import { EVAL_LIFECYCLE_STATUSES, type EvalArtifactRef, type EvalLifecycleStatus } from "../eval/contract.ts";
import { acceptSunset, getEvalCase, listEvalCases } from "../eval/lifecycle.ts";
import { numberOption, option, type ParsedArgs, requireOption } from "./args.ts";
import { type CliContext, requireOperator } from "./context.ts";
import { writeJson, writeLine, writeTable } from "./output.ts";

function usage(): never {
	throw new ControlError("invalid_input", "usage: codeteam eval <list|open|overdue|show|accept-sunset> ...");
}

function parseStatus(value: string | undefined): EvalLifecycleStatus | undefined {
	if (value === undefined) return undefined;
	if (!EVAL_LIFECYCLE_STATUSES.includes(value as EvalLifecycleStatus)) {
		throw new ControlError("invalid_input", `unknown eval lifecycle status ${value}`);
	}
	return value as EvalLifecycleStatus;
}

function listCases(args: ParsedArgs, context: CliContext, mode: "all" | "open" | "overdue"): number {
	const items = listEvalCases(context.store, {
		domainId: option(args, "domain"),
		status: parseStatus(option(args, "status")),
		openOnly: mode === "open",
		overdueOnly: mode === "overdue",
	});
	if (context.json) {
		writeJson(items);
		return 0;
	}
	writeTable(items, [
		{ header: "case", value: (item) => item.caseId },
		{ header: "domain", value: (item) => item.domainId },
		{ header: "verdict", value: (item) => item.verdict },
		{ header: "status", value: (item) => item.status },
		{ header: "awaiting", value: (item) => (item.awaitingSunsetDecision ? "sunset" : "-") },
		{ header: "overdue", value: (item) => (item.overdue ? "yes" : "no") },
	]);
	return 0;
}

function showCase(args: ParsedArgs, context: CliContext): number {
	const caseId = args.positionals[1];
	if (!caseId) throw new ControlError("invalid_input", "usage: codeteam eval show <caseId>");
	const projection = getEvalCase(context.store, caseId);
	const verdict = context.store.evals.get(projection.verdictId);
	if (!verdict) throw new ControlError("not_found", `verdict ${projection.verdictId} not found`);
	const metrics = verdict.metrics as {
		messageId?: string;
		artifacts?: { kind: string; path: string; sha256: string; bytes: number }[];
	};
	const message = metrics.messageId ? context.store.messages.get(metrics.messageId) : null;
	const artifacts = (metrics.artifacts ?? []) as EvalArtifactRef[];
	const lifecycleRoot = artifacts.find((artifact) => artifact.kind === "lifecycle-root");
	const detail = {
		case: projection,
		verdict: {
			id: verdict.id,
			domainId: verdict.domainId,
			bundleId: verdict.bundleId,
			status: verdict.status,
			reasons: verdict.reasons,
			windowStartMs: verdict.windowStartMs,
			windowEndMs: verdict.windowEndMs,
			measurementRef: verdict.measurementRef,
			createdAt: verdict.createdAt,
		},
		message: message
			? { id: message.id, threadId: message.threadId, seq: message.seq, bodyMd: message.bodyMd }
			: null,
		artifacts,
		lifecycleRoot: lifecycleRoot ? (JSON.parse(readEvalArtifact(lifecycleRoot)) as unknown) : null,
	};
	if (context.json) {
		writeJson(detail);
		return 0;
	}
	writeLine(`case: ${projection.caseId}`);
	writeLine(`verdict: ${projection.verdict} · status: ${projection.status}`);
	writeLine(`domain: ${projection.domainId}`);
	writeLine(`awaiting sunset decision: ${projection.awaitingSunsetDecision ? "yes" : "no"}`);
	writeLine(`overdue: ${projection.overdue ? "yes" : "no"}`);
	writeLine(`next sequence: ${projection.nextSequence}`);
	writeLine("");
	writeLine(message?.bodyMd ?? "(no verdict message)");
	if (artifacts.length > 0) {
		writeLine("");
		writeLine("artifacts:");
		for (const artifact of artifacts) writeLine(`  ${artifact.kind} ${artifact.sha256} ${artifact.path}`);
	}
	return 0;
}

function acceptSunsetCommand(args: ParsedArgs, context: CliContext): number {
	const caseId = args.positionals[1];
	if (!caseId) throw new ControlError("invalid_input", "usage: codeteam eval accept-sunset <caseId> --reason <text>");
	const operator = requireOperator(context);
	const reason = requireOption(args, "reason");
	const expectedSequence = numberOption(args, "expected-seq");
	const result = acceptSunset(context.store, {
		caseId,
		actor: { kind: "operator", id: operator.id },
		reason,
		expectedSequence,
	});
	if (context.json) {
		writeJson(result);
		return 0;
	}
	writeLine(`accepted sunset decision for ${caseId}`);
	writeLine(`status: ${result.case.status}`);
	writeLine(`event: ${result.event.eventId}`);
	writeLine("no harness files or configuration were deleted");
	return 0;
}

export function runEvalCommand(args: ParsedArgs, context: CliContext): number {
	const subcommand = args.positionals[0];
	if (subcommand === "list") return listCases(args, context, "all");
	if (subcommand === "open") return listCases(args, context, "open");
	if (subcommand === "overdue") return listCases(args, context, "overdue");
	if (subcommand === "show") return showCase(args, context);
	if (subcommand === "accept-sunset") return acceptSunsetCommand(args, context);
	usage();
}
