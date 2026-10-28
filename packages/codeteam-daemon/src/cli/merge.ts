import { createHash } from "node:crypto";
import {
	issueMergeServiceCredential,
	MERGE_SERVICE_ACTOR,
	verifyMergeServiceCredential,
} from "../auth/merge-credential.ts";
import { loadOperatorPublicKey } from "../auth/operator.ts";
import { ControlError } from "../control/errors.ts";
import { runGit } from "../gates/git.ts";
import { GateService } from "../gates/service.ts";
import { gateCodes } from "../gates/types.ts";
import { MergeExecutor } from "../merge/executor.ts";
import { option, type ParsedArgs, requireOption } from "./args.ts";
import { type CliContext, requireOperator } from "./context.ts";
import { mergeRequest } from "./gate.ts";
import { writeJson, writeLine } from "./output.ts";

export function runMergeCommand(args: ParsedArgs, context: CliContext): number {
	const subcommand = args.positionals[0];
	if (subcommand === "plan") {
		const evaluated = new GateService(context.store).merge(mergeRequest(args));
		const auditRef = new GateService(context.store).record(evaluated.result, requireOption(args, "task"));
		if (context.json) writeJson({ ...evaluated, auditRef });
		else {
			writeLine(`merge: ${evaluated.result.status}`);
			for (const finding of evaluated.result.findings) {
				writeLine(`- ${finding.severity} ${finding.code}: ${finding.message}`);
			}
			writeLine(`reviewRef=${evaluated.reviewRef ?? "-"} base=${evaluated.baseSha} head=${evaluated.headSha}`);
		}
		return evaluated.result.status === "block" ? 1 : 0;
	}
	if (subcommand === "execute") {
		const operator = requireOperator(context);
		const result = new MergeExecutor(context.store).execute({
			...mergeRequest(args),
			operatorId: operator.id,
			operatorPrivateKey: operator.privateKey,
			operatorPublicKey: loadOperatorPublicKey(context.dataDir),
		});
		if (context.json) writeJson(result);
		else {
			writeLine(
				`merge receipt ${result.receipt.id} status=${result.receipt.status} mergeSha=${result.receipt.mergeSha}`,
			);
			writeLine(
				`gate=${result.gate.status} evidence=${result.gateEvidenceRef} credential=${result.credentialFingerprint}`,
			);
			for (const finding of result.gate.findings)
				writeLine(`- ${finding.severity} ${finding.code}: ${finding.message}`);
		}
		return result.receipt.status === "succeeded" ? 0 : 1;
	}
	if (subcommand === "record") return recordMerge(args, context);
	throw new ControlError("invalid_input", "usage: codeteam merge <plan|execute|record>");
}

function recordMerge(args: ParsedArgs, context: CliContext): number {
	const status = option(args, "status") ?? "succeeded";
	if (status !== "succeeded" && status !== "failed" && status !== "unknown") {
		throw new ControlError("invalid_input", "--status must be succeeded, failed, or unknown");
	}
	const request = mergeRequest(args);
	const service = new GateService(context.store);
	const evaluated = service.merge(request);
	if (evaluated.result.status === "block") {
		throw new ControlError("invalid_input", `merge_gate_blocked: ${gateCodes(evaluated.result).join(", ")}`);
	}
	const operator = option(args, "credential") ? null : requireOperator(context);
	const binding = {
		repo: request.repoPath,
		prRef: request.prRef ?? "local",
		headSha: evaluated.headSha,
	};
	const operatorPublicKey = loadOperatorPublicKey(context.dataDir);
	const token = option(args, "credential");
	if (token) {
		verifyMergeServiceCredential(operatorPublicKey, token, binding);
	} else {
		const minted = issueMergeServiceCredential(operator!.privateKey, binding, { ttlMs: 5 * 60 * 1000 });
		verifyMergeServiceCredential(operatorPublicKey, minted.token, binding);
		const fingerprint = createHash("sha256").update(minted.token).digest("hex").slice(0, 16);
		context.store.audit.append({
			actor: MERGE_SERVICE_ACTOR,
			action: "merge_credential_minted",
			subject: `merge-credential:${fingerprint}`,
			args: { ...binding, expiresAt: minted.expiresAt },
		});
	}
	const gateEvidenceRef = service.record(evaluated.result, request.taskId);
	const mergeSha =
		status === "succeeded" ? requireOption(args, "merge-sha") : (option(args, "merge-sha") ?? evaluated.baseSha);
	if (status === "succeeded") {
		if (runGit(["cat-file", "-e", `${mergeSha}^{commit}`], request.repoPath).status !== 0) {
			throw new ControlError("invalid_input", `mergeSha ${mergeSha} is not a commit in the target repo`);
		}
		if (runGit(["merge-base", "--is-ancestor", mergeSha, request.baseRef], request.repoPath).status !== 0) {
			throw new ControlError("invalid_input", `mergeSha ${mergeSha} is not reachable from ${request.baseRef}`);
		}
	}
	const receipt = context.store.merges.create({
		taskId: request.taskId,
		baseSha: evaluated.baseSha,
		headSha: evaluated.headSha,
		mergeSha,
		policy: "merge-gate",
		approvedBy: operator?.id ?? MERGE_SERVICE_ACTOR,
		receiptRef: `recorded-merge:${mergeSha}:${Date.now()}`,
		approvalId: request.approvalId,
		executedBy: MERGE_SERVICE_ACTOR,
		gateEvidenceRef,
		reviewRef: evaluated.reviewRef,
		status,
		failureRef: status === "succeeded" ? null : requireOption(args, "failure-ref"),
		hardGate: evaluated.hardGateRequired,
		strategy: option(args, "strategy") ?? "external",
		repo: request.repoPath,
		prRef: request.prRef,
		mergedAt: status === "succeeded" ? Date.now() : null,
	});
	if (context.json) writeJson({ receipt, gate: evaluated.result, gateEvidenceRef });
	else writeLine(`recorded merge receipt ${receipt.id} status=${receipt.status} mergeSha=${receipt.mergeSha}`);
	return status === "succeeded" ? 0 : 1;
}
