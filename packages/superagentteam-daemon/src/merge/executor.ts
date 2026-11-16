import { createHash, type KeyObject } from "node:crypto";
import {
	issueMergeServiceCredential,
	MERGE_SERVICE_ACTOR,
	verifyMergeServiceCredential,
} from "../auth/merge-credential.ts";
import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import type { Merge } from "../control/stores/types.ts";
import { requireGit, runGit } from "../gates/git.ts";
import { GateService, type MergeGateRequest } from "../gates/service.ts";
import { type GateResult, gateCodes } from "../gates/types.ts";
import { ManagedWorkService } from "../managed-work/service.ts";

export interface MergeExecuteInput extends MergeGateRequest {
	readonly operatorId: string;
	readonly operatorPrivateKey: KeyObject;
	readonly operatorPublicKey: KeyObject;
	readonly credentialTtlMs?: number;
}

export interface MergeExecuteResult {
	readonly gate: GateResult;
	readonly gateEvidenceRef: string;
	readonly reviewRef: string | null;
	readonly receipt: Merge;
	readonly credentialFingerprint: string;
}

export class MergeExecutor {
	private readonly store: ControlStore;

	constructor(store: ControlStore) {
		this.store = store;
	}

	execute(input: MergeExecuteInput): MergeExecuteResult {
		const gateService = new GateService(this.store);
		const evaluation = gateService.merge(input);
		const resolvedInput = { ...input, headSha: evaluation.headSha };
		const gateEvidenceRef = gateService.record(evaluation.result, input.taskId);
		if (evaluation.result.status === "block") {
			throw new ControlError("invalid_input", `merge_gate_blocked: ${gateCodes(evaluation.result).join(", ")}`);
		}
		const binding = {
			repo: resolvedInput.repoPath,
			prRef: resolvedInput.prRef ?? "local",
			headSha: resolvedInput.headSha,
		};
		const credential = issueMergeServiceCredential(resolvedInput.operatorPrivateKey, binding, {
			ttlMs: resolvedInput.credentialTtlMs ?? 5 * 60 * 1000,
		});
		verifyMergeServiceCredential(resolvedInput.operatorPublicKey, credential.token, binding);
		const credentialFingerprint = createHash("sha256").update(credential.token).digest("hex").slice(0, 16);
		this.store.audit.append({
			actor: MERGE_SERVICE_ACTOR,
			action: "merge_credential_minted",
			subject: `merge-credential:${credentialFingerprint}`,
			args: { ...binding, expiresAt: credential.expiresAt },
		});
		const currentHead = runGit(["rev-parse", "HEAD"], resolvedInput.repoPath);
		if (currentHead.status !== 0 || currentHead.stdout !== evaluation.baseSha) {
			throw new ControlError(
				"conflict",
				`merge_base_moved: expected ${evaluation.baseSha}, found ${currentHead.stdout || "unknown"}`,
			);
		}
		const dirty = runGit(["status", "--porcelain"], resolvedInput.repoPath);
		if (dirty.status !== 0 || dirty.stdout !== "") {
			throw new ControlError("invalid_state", "merge_worktree_dirty: target checkout must be clean before merge");
		}
		if (runGit(["cat-file", "-e", `${resolvedInput.headSha}^{commit}`], resolvedInput.repoPath).status !== 0) {
			throw new ControlError(
				"invalid_input",
				`merge head ${resolvedInput.headSha} is not a commit in the target repo`,
			);
		}
		const merge = runGit(["merge", "--no-ff", "--no-edit", resolvedInput.headSha], resolvedInput.repoPath);
		if (merge.status !== 0) {
			runGit(["merge", "--abort"], resolvedInput.repoPath);
			const receipt = this.recordReceipt({
				input: resolvedInput,
				gateEvidenceRef,
				reviewRef: evaluation.reviewRef,
				hardGate: evaluation.hardGateRequired,
				status: "failed",
				mergeSha: evaluation.baseSha,
				failureRef: `merge_failed:${merge.status}`,
				executedAt: Date.now(),
			});
			this.consumeCredential(credentialFingerprint, resolvedInput, "failed");
			return {
				gate: evaluation.result,
				gateEvidenceRef,
				reviewRef: evaluation.reviewRef,
				receipt,
				credentialFingerprint,
			};
		}
		const mergeSha = requireGit(["rev-parse", "HEAD"], resolvedInput.repoPath);
		const receipt = this.recordReceipt({
			input: resolvedInput,
			gateEvidenceRef,
			reviewRef: evaluation.reviewRef,
			hardGate: evaluation.hardGateRequired,
			status: "succeeded",
			mergeSha,
			failureRef: null,
			executedAt: Date.now(),
		});
		this.consumeCredential(credentialFingerprint, resolvedInput, "succeeded");
		return {
			gate: evaluation.result,
			gateEvidenceRef,
			reviewRef: evaluation.reviewRef,
			receipt,
			credentialFingerprint,
		};
	}

	private recordReceipt(input: {
		readonly input: MergeExecuteInput;
		readonly gateEvidenceRef: string;
		readonly reviewRef: string | null;
		readonly hardGate: boolean;
		readonly status: "succeeded" | "failed";
		readonly mergeSha: string;
		readonly failureRef: string | null;
		readonly executedAt: number;
	}): Merge {
		try {
			const receipt = this.store.merges.create({
				taskId: input.input.taskId,
				baseSha: requireGit(["rev-parse", input.input.baseRef], input.input.repoPath),
				headSha: input.input.headSha,
				mergeSha: input.mergeSha,
				policy: "merge-gate",
				approvedBy: input.hardGate ? input.input.operatorId : MERGE_SERVICE_ACTOR,
				receiptRef:
					input.status === "succeeded"
						? `local-merge:${input.mergeSha}`
						: `local-merge-failed:${input.executedAt}`,
				approvalId: input.input.approvalId ?? null,
				executedBy: MERGE_SERVICE_ACTOR,
				gateEvidenceRef: input.gateEvidenceRef,
				reviewRef: input.reviewRef,
				status: input.status,
				failureRef: input.failureRef,
				hardGate: input.hardGate,
				strategy: "merge --no-ff",
				repo: input.input.repoPath,
				prRef: input.input.prRef ?? null,
				mergedAt: input.status === "succeeded" ? input.executedAt : null,
			});
			const task = this.store.tasks.get(input.input.taskId);
			if (task?.kind === "pr_tracking") {
				new ManagedWorkService(this.store).recordLifecycleEvidence({
					taskId: task.id,
					evidenceKind: "merge",
					evidenceRef: `merge:${receipt.id}`,
					actorRef: MERGE_SERVICE_ACTOR,
				});
			}
			return receipt;
		} catch (error) {
			this.store.audit.append({
				actor: MERGE_SERVICE_ACTOR,
				action: "merge_receipt_failed",
				subject: `merge-head:${input.input.headSha}`,
				args: { repo: input.input.repoPath, status: input.status, failure: String(error) },
			});
			throw error;
		}
	}

	private consumeCredential(fingerprint: string, input: MergeExecuteInput, result: "succeeded" | "failed"): void {
		this.store.audit.append({
			actor: MERGE_SERVICE_ACTOR,
			action: "merge_credential_consumed",
			subject: `merge-credential:${fingerprint}`,
			args: { headSha: input.headSha, repo: input.repoPath, prRef: input.prRef ?? "local", result },
		});
	}
}
