import { ControlError } from "../control/errors.ts";
import { readEvalArtifact } from "../eval/artifacts.ts";
import {
	EVAL_CASE_ID_PATTERN,
	EVAL_LIFECYCLE_STATUSES,
	type EvalArtifactRef,
	type EvalLifecycleStatus,
} from "../eval/contract.ts";
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
	const id = args.positionals[1];
	if (!id) throw new ControlError("invalid_input", "usage: codeteam eval show <caseId|verdictId>");
	let projection: ReturnType<typeof getEvalCase> | null = null;
	try {
		projection = getEvalCase(context.store, id);
	} catch (error) {
		if (!(error instanceof ControlError) || error.code !== "not_found") throw error;
	}
	const verdict = context.store.evals.get(projection?.verdictId ?? id);
	if (!verdict) throw new ControlError("not_found", `verdict ${projection?.verdictId ?? id} not found`);
	const metrics = verdict.metrics as {
		messageId?: string;
		artifacts?: EvalArtifactRef[];
	};
	const message = metrics.messageId ? context.store.messages.get(metrics.messageId) : null;
	const artifacts = metrics.artifacts ?? [];
	const lifecycleRoot = artifacts.find((artifact) => artifact.kind === "eval-lifecycle-root");
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
		artifacts: artifacts.map((artifact) => ({
			artifactId: artifact.artifactId,
			kind: artifact.kind,
			sha256: artifact.sha256,
			bytes: artifact.bytes,
		})),
		lifecycleRoot: lifecycleRoot ? (JSON.parse(readEvalArtifact(context.store, lifecycleRoot)) as unknown) : null,
	};
	if (context.json) {
		writeJson(detail);
		return 0;
	}
	writeLine(`case: ${projection?.caseId ?? "(observation; no case tracking)"}`);
	writeLine(`verdict: ${projection?.verdict ?? "observation"} · status: ${projection?.status ?? "observation"}`);
	writeLine(`domain: ${projection?.domainId ?? verdict.domainId}`);
	writeLine(`awaiting sunset decision: ${projection?.awaitingSunsetDecision ? "yes" : "no"}`);
	writeLine(`overdue: ${projection?.overdue ? "yes" : "no"}`);
	writeLine(`next sequence: ${projection?.nextSequence ?? "-"}`);
	writeLine("");
	writeLine(message?.bodyMd ?? "(no verdict message)");
	if (artifacts.length > 0) {
		writeLine("");
		writeLine("artifacts:");
		for (const artifact of artifacts) writeLine(`  ${artifact.kind} ${artifact.sha256} ${artifact.artifactId}`);
	}
	return 0;
}

function acceptSunsetCommand(args: ParsedArgs, context: CliContext): number {
	const id = args.positionals[1];
	if (!id) {
		throw new ControlError("invalid_input", "usage: codeteam eval accept-sunset <caseId|verdictId> --reason <text>");
	}
	const operator = requireOperator(context);
	const reason = requireOption(args, "reason");
	const expectedSequence = numberOption(args, "expected-seq");
	const result = acceptSunset(context.store, {
		...(EVAL_CASE_ID_PATTERN.test(id) ? { caseId: id } : { verdictId: id }),
		actor: { kind: "operator", id: operator.id },
		reason,
		expectedSequence,
	});
	if (context.json) {
		writeJson(result);
		return 0;
	}
	writeLine(`accepted sunset decision for ${id}`);
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
