import { revokeCredentialsForRun } from "../auth/revoke.ts";
import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import type { Run } from "../control/stores/types.ts";
import type { DispatchSettleInput } from "./types.ts";

const TERMINAL_STATUSES = new Set(["completed", "canceled", "interrupted", "failed"]);

export interface SettleRunResult {
	readonly run: Run;
	readonly changed: boolean;
}

export function settleRunTerminal(
	store: ControlStore,
	runId: string,
	input: DispatchSettleInput,
	clock: () => number = Date.now,
): SettleRunResult {
	return store.transaction.run(() => {
		const current = store.runs.get(runId);
		if (!current) throw new ControlError("not_found", `run ${runId} not found`);
		if (TERMINAL_STATUSES.has(current.status)) return { run: current, changed: false };
		if (current.status !== "running") {
			throw new ControlError("invalid_state", `run ${runId} is ${current.status}`);
		}
		if (current.responseMessageId) {
			const finalBody =
				input.bodyMd ??
				(input.status === "completed" ? "" : `Execution ${input.status}${input.reason ? `: ${input.reason}` : ""}`);
			store.messages.setBody(current.responseMessageId, finalBody);
		}
		store.runs.terminal(current.id, { status: input.status, usage: input.usage ?? null });
		store.runs.appendEvent(current.id, "message", {
			phase: "terminal",
			status: input.status,
			reason: input.reason ?? null,
			responseMessageId: current.responseMessageId,
		});
		if (current.responseMessageId) {
			store.messages.settleDispatchRef(current.sourceId, {
				targetId: current.recipientProfileId,
				statusMessageId: current.responseMessageId,
				patch: { status: input.status, reason: input.reason ?? null, settledAt: clock() },
			});
		}
		store.audit.append({
			actor: input.actorRef ?? "system:dispatch",
			action: "run_terminal",
			subject: `run:${current.id}`,
			args: { status: input.status, reason: input.reason ?? null },
		});
		if (input.status !== "completed") {
			for (const claim of store.handoffs.listActiveClaimsByRun(current.id)) {
				store.handoffs.releaseClaim(claim.handoffId, claim.profileId, input.reason ?? input.status);
			}
		}
		revokeCredentialsForRun(store, current.id, dispositionFor(input.status));
		return { run: store.runs.get(current.id)!, changed: true };
	});
}

function dispositionFor(status: DispatchSettleInput["status"]): "completed" | "failed" | "canceled" | "interrupted" {
	return status === "completed" || status === "failed" || status === "canceled" || status === "interrupted"
		? status
		: "failed";
}
