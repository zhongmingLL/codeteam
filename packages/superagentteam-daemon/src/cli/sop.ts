import { ControlError } from "../control/errors.ts";
import { SOP_CHECK_EVIDENCE_KIND, SOP_CHECK_NAME_VALUES } from "../control/stores/sop-check-evidence.ts";
import type { SopCheckName, SopChecks, SopStage } from "../control/stores/types.ts";
import { SOP_CATALOG, SOP_STAGE_IDS, SopService } from "../sop/service.ts";
import { numberOption, option, options, type ParsedArgs, requireOption } from "./args.ts";
import { type CliContext, requireOperator } from "./context.ts";
import { writeJson, writeLine } from "./output.ts";

function stageOption(value: string | undefined): SopStage {
	const stage = value as SopStage | undefined;
	if (!stage || !SOP_STAGE_IDS.includes(stage)) {
		throw new ControlError("invalid_input", `--stage must be one of: ${SOP_STAGE_IDS.join(", ")}`);
	}
	return stage;
}

function checkName(value: string | undefined): SopCheckName {
	const name = value as SopCheckName | undefined;
	if (!name || !SOP_CHECK_NAME_VALUES.includes(name)) {
		throw new ControlError("invalid_input", `check must be one of: ${SOP_CHECK_NAME_VALUES.join(", ")}`);
	}
	return name;
}

function checksOption(value: string | undefined): SopChecks | undefined {
	if (value === undefined) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (error) {
		throw new ControlError("invalid_input", "--checks-json must be valid JSON", { cause: error });
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ControlError("invalid_input", "--checks-json must be an object");
	}
	return parsed as SopChecks;
}

export function runSopCommand(args: ParsedArgs, context: CliContext): number {
	const subcommand = args.positionals[0];
	if (subcommand === "catalog") {
		if (context.json) writeJson(SOP_CATALOG);
		else
			writeLine(`sop=${SOP_CATALOG.id} stages=${SOP_STAGE_IDS.join(",")} checks=${SOP_CHECK_NAME_VALUES.join(",")}`);
		return 0;
	}
	if (subcommand === "show") return showSop(args, context);
	if (subcommand === "update") return updateSop(args, context);
	if (subcommand === "evidence") return recordEvidence(args, context);
	throw new ControlError("invalid_input", "usage: codeteam sop <catalog|show|update|evidence>");
}

function showSop(args: ParsedArgs, context: CliContext): number {
	const id = args.positionals[1];
	if (!id) throw new ControlError("invalid_input", "usage: codeteam sop show <backlogItemId>");
	const headSha = option(args, "head-sha");
	const baseSha = option(args, "base-sha");
	const mergeSha = option(args, "merge-sha");
	const currentRevisions: Partial<Record<SopCheckName, string>> = {};
	if (headSha) {
		currentRevisions.qualityGatePassed = headSha;
		currentRevisions.reviewApproved = headSha;
	}
	if (baseSha) currentRevisions.remoteMainSynced = baseSha;
	if (mergeSha) currentRevisions.visionGuardDone = mergeSha;
	const service = new SopService(context.store);
	const view = service.view(id, { currentRevisions });
	if (!view) throw new ControlError("not_found", `workflow SOP for backlog item ${id} not found`);
	if (context.json) {
		writeJson(view);
		return 0;
	}
	writeLine(`${id}  stage=${view.sop.stage}  baton=${view.sop.batonHolder}  version=${view.sop.version}`);
	writeLine(`goal: ${view.sop.resumeCapsule.goal}`);
	writeLine(`focus: ${view.sop.resumeCapsule.currentFocus}`);
	writeLine(`done: ${view.sop.resumeCapsule.done.join(" | ") || "(empty)"}`);
	for (const [check, status] of Object.entries(view.effectiveChecks)) {
		const stale = view.staleEvidence.includes(check as SopCheckName) ? " stale" : "";
		writeLine(`check ${check}: ${status}${stale}`);
	}
	return 0;
}

function updateSop(args: ParsedArgs, context: CliContext): number {
	const operator = requireOperator(context);
	const id = args.positionals[1];
	if (!id)
		throw new ControlError(
			"invalid_input",
			"usage: codeteam sop update <backlogItemId> --stage <stage> --baton <profile|operator> --focus <text>",
		);
	const backlog = context.store.backlog.get(id);
	if (!backlog) throw new ControlError("not_found", `backlog item ${id} not found`);
	const featureTag = backlog.tags.find((tag) => tag.startsWith("feature:"));
	if (!featureTag) throw new ControlError("invalid_input", "backlog item has no feature:<id> tag");
	const existing = context.store.sops.get(id);
	const checks = checksOption(option(args, "checks-json"));
	const stage = stageOption(requireOption(args, "stage"));
	const done = options(args, "done");
	const capsule = {
		goal: option(args, "goal") ?? existing?.resumeCapsule.goal ?? backlog.title,
		done: done.length > 0 ? done : (existing?.resumeCapsule.done ?? []),
		currentFocus: requireOption(args, "focus"),
	};
	const sop = context.store.sops.upsert({
		backlogItemId: id,
		featureId: option(args, "feature") ?? featureTag.slice("feature:".length),
		stage,
		batonHolder: requireOption(args, "baton"),
		nextSkill: option(args, "next-skill") ?? null,
		resumeCapsule: capsule,
		checks: checks ??
			existing?.checks ?? {
				remoteMainSynced: "unknown",
				qualityGatePassed: "unknown",
				reviewApproved: "unknown",
				visionGuardDone: "unknown",
			},
		expectedVersion: numberOption(args, "expected-version"),
		updatedBy: operator.id,
		completionSubjectRevision: option(args, "subject-revision") ?? null,
	});
	if (context.json) writeJson(sop);
	else writeLine(`updated ${sop.backlogItemId} stage=${sop.stage} version=${sop.version}`);
	return 0;
}

function recordEvidence(args: ParsedArgs, context: CliContext): number {
	const operator = requireOperator(context);
	const id = args.positionals[1];
	const name = checkName(args.positionals[2]);
	const evidenceRef = args.positionals[3] ?? option(args, "ref");
	if (!id)
		throw new ControlError(
			"invalid_input",
			"usage: codeteam sop evidence <backlogItemId> <check> <evidenceRef> --subject-revision <sha>",
		);
	if (!evidenceRef) throw new ControlError("invalid_input", "evidenceRef is required");
	const subjectRevision = requireOption(args, "subject-revision");
	const service = new SopService(context.store);
	const evidence = service.recordEvidence({
		backlogItemId: id,
		checkName: name,
		evidenceKind: SOP_CHECK_EVIDENCE_KIND[name],
		evidenceRef,
		subjectRevision,
		recordedBy: operator.id,
	});
	if (context.json) writeJson(evidence);
	else writeLine(`verified ${name} for ${id} ref=${evidenceRef} revision=${subjectRevision}`);
	return 0;
}
