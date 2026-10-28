import { readFileSync } from "node:fs";
import { ControlError } from "../control/errors.ts";
import { GateService } from "../gates/service.ts";
import type { AssuranceLevel, RiskAxis, RiskLane } from "../gates/types.ts";
import { numberOption, option, options, type ParsedArgs, requireOption } from "./args.ts";
import { type CliContext, requireOperator } from "./context.ts";
import { writeJson, writeLine } from "./output.ts";

const LANES = new Set<RiskLane>(["docs", "product_fast", "small_change", "standard"]);
const ASSURANCES = new Set<AssuranceLevel>(["light", "standard", "high", "critical"]);
const AXES = new Set<RiskAxis>(["behavior", "data", "security", "contract", "irreversible"]);

function riskFlags(args: ParsedArgs): { lane?: RiskLane; assurance?: AssuranceLevel; axes?: RiskAxis[] } {
	const lane = option(args, "lane") as RiskLane | undefined;
	if (lane && !LANES.has(lane)) throw new ControlError("invalid_input", `unknown lane ${lane}`);
	const assurance = option(args, "assurance") as AssuranceLevel | undefined;
	if (assurance && !ASSURANCES.has(assurance))
		throw new ControlError("invalid_input", `unknown assurance ${assurance}`);
	const axes = options(args, "axis") as RiskAxis[];
	for (const axis of axes) if (!AXES.has(axis)) throw new ControlError("invalid_input", `unknown risk axis ${axis}`);
	return { lane, assurance, axes: axes.length > 0 ? axes : undefined };
}

export function runGateCommand(args: ParsedArgs, context: CliContext): number {
	const subcommand = args.positionals[0];
	if (subcommand === "telemetry") {
		const telemetry = new GateService(context.store).telemetry(numberOption(args, "since-days") ?? 30);
		if (context.json) writeJson(telemetry);
		else {
			writeLine(`gate telemetry: total=${telemetry.total}`);
			for (const gate of telemetry.gates) {
				writeLine(
					`${gate.gate}: total=${gate.total} pass=${gate.passed} block=${gate.blocked} advisory=${gate.advisory} passRate=${(gate.passRate * 100).toFixed(1)}% pruning=${gate.pruningCandidate}`,
				);
				for (const code of gate.blockCodes.slice(0, 5)) writeLine(`  ${code.code}: ${code.count}`);
			}
		}
		return 0;
	}
	if (subcommand !== "check") throw new ControlError("invalid_input", "usage: codeteam gate <check|telemetry>");
	const gate = args.positionals[1];
	if (!gate)
		throw new ControlError(
			"invalid_input",
			"usage: codeteam gate check <worktree|design|review|verify|risk|completion|merge>",
		);
	const service = new GateService(context.store);
	if (gate === "risk") {
		const evaluated = service.risk(
			requireOption(args, "repo"),
			requireOption(args, "base"),
			requireOption(args, "head"),
			riskFlags(args),
		);
		const auditRef = service.record(evaluated.result, `${evaluated.baseSha}..${evaluated.headSha}`);
		output(context, evaluated.result, { risk: evaluated.risk, files: evaluated.files, auditRef });
		return 0;
	}
	if (gate === "worktree") {
		const result = service.worktree(
			requireOption(args, "repo"),
			option(args, "worktree") ?? process.cwd(),
			requireOption(args, "base"),
			{
				phase: option(args, "phase") === "merge" ? "merge" : "start",
				allowUnsyncedBase: args.flags.has("allow-unsynced-base"),
				allowPrimaryWorktree: args.flags.has("allow-primary-worktree"),
			},
		);
		const auditRef = service.record(result, option(args, "worktree") ?? process.cwd());
		output(context, result, { auditRef });
		return 0;
	}
	if (gate === "review" || gate === "verify") {
		const request = {
			taskId: requireOption(args, "task"),
			headSha: requireOption(args, "head"),
			baseSha: requireOption(args, "base"),
		};
		const result = gate === "review" ? service.review(request) : service.verify(request);
		const auditRef = service.record(result, request.taskId);
		output(context, result, { auditRef });
		return 0;
	}
	if (gate === "design") {
		const specPath = requireOption(args, "spec");
		let spec: {
			specRef?: string;
			acceptanceCriteria?: string[];
			userJourney?: string[];
			userVisible?: boolean;
		};
		try {
			spec = JSON.parse(readFileSync(specPath, "utf8")) as typeof spec;
		} catch (error) {
			throw new ControlError("invalid_input", "--spec must be a readable JSON object", { cause: error });
		}
		const evaluated = service.risk(
			requireOption(args, "repo"),
			requireOption(args, "base"),
			requireOption(args, "head"),
			riskFlags(args),
		);
		const approvalId = option(args, "approval");
		const result = service.design({
			taskId: requireOption(args, "task"),
			specRef: spec.specRef ?? specPath,
			acceptanceCriteria: spec.acceptanceCriteria ?? [],
			userJourney: spec.userJourney ?? [],
			userVisible: spec.userVisible ?? false,
			risk: evaluated.risk,
			specChange: args.flags.has("spec-change"),
			approval: approvalId ? context.store.approvals.get(approvalId) : null,
		});
		const auditRef = service.record(result, requireOption(args, "task"));
		output(context, result, { risk: evaluated.risk, auditRef });
		return 0;
	}
	if (gate === "completion") {
		const operator = requireOperator(context);
		const result = service.completion(
			requireOption(args, "backlog"),
			option(args, "actor") ?? operator.id,
			option(args, "acceptance-ref"),
		);
		const auditRef = service.record(result, requireOption(args, "backlog"));
		output(context, result, { auditRef });
		return 0;
	}
	if (gate === "merge") {
		const evaluated = service.merge(mergeRequest(args));
		const auditRef = service.record(
			evaluated.result,
			evaluated.result.gate === "merge" ? requireOption(args, "task") : "unknown",
		);
		output(context, evaluated.result, {
			risk: evaluated.risk,
			reviewRef: evaluated.reviewRef,
			baseSha: evaluated.baseSha,
			headSha: evaluated.headSha,
			auditRef,
		});
		return 0;
	}
	throw new ControlError("invalid_input", `unknown gate ${gate}`);
}

export function mergeRequest(args: ParsedArgs) {
	const risk = riskFlags(args);
	return {
		taskId: requireOption(args, "task"),
		repoPath: requireOption(args, "repo"),
		worktreePath: option(args, "worktree") ?? process.cwd(),
		baseRef: requireOption(args, "base"),
		headSha: requireOption(args, "head"),
		prRef: option(args, "pr") ?? null,
		declaredLane: risk.lane,
		declaredAssurance: risk.assurance,
		declaredAxes: risk.axes,
		hardGate: args.flags.has("hard-gate"),
		approvalId: option(args, "approval") ?? null,
		allowUnsyncedBase: args.flags.has("allow-unsynced-base"),
		allowPrimaryWorktree: args.flags.has("allow-primary-worktree"),
	};
}

function output(
	context: CliContext,
	result: { gate: string; status: string; findings: readonly { severity: string; code: string; message: string }[] },
	extra: Record<string, unknown>,
): void {
	if (context.json) {
		writeJson({ result, ...extra });
		return;
	}
	writeLine(`${result.gate}: ${result.status}`);
	for (const finding of result.findings) writeLine(`- ${finding.severity} ${finding.code}: ${finding.message}`);
}
