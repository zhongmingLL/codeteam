import { ControlError } from "../control/errors.ts";
import type { HandoffKind } from "../control/stores/types.ts";

export interface HandoffDirectionBinding {
	readonly role: string;
	readonly runId: string;
}

export interface HandoffDirectionRequest {
	readonly toRole: string;
	readonly kind: HandoffKind;
}

export interface HandoffDirectionDecision {
	readonly fromRole: string;
	readonly actionPair: string;
}

export interface HandoffDirectionOptions {
	readonly actionPairs?: readonly string[];
}

export const DEFAULT_ACTION_PAIRS: readonly string[] = [
	"coder->reviewer:review",
	"reviewer->coder:verdict",
	"reviewer->human:verdict",
	"coder->verifier:handoff",
	"verifier->coder:verdict",
	"*->human:blocker",
	"*->human:spec_change",
	"*->human:plan_revision",
	"*->human:question",
];

const KIND_ACTIONS: Record<HandoffKind, string> = {
	handoff: "handoff",
	review_request: "review",
	verdict: "verdict",
	blocker: "blocker",
	spec_change: "spec_change",
	plan_revision: "plan_revision",
	question: "question",
};

export function assertHandoffDirection(
	binding: HandoffDirectionBinding,
	request: HandoffDirectionRequest,
	options: HandoffDirectionOptions = {},
): HandoffDirectionDecision {
	const fromRole = binding.role;
	const actionPair = `${fromRole}->${request.toRole}:${KIND_ACTIONS[request.kind]}`;
	const wildcard = `*->${request.toRole}:${KIND_ACTIONS[request.kind]}`;
	const allowed = options.actionPairs ?? DEFAULT_ACTION_PAIRS;
	if (!allowed.includes(actionPair) && !allowed.includes(wildcard)) {
		throw new ControlError("forbidden", `handoff direction not allowed: ${actionPair}`);
	}
	return { fromRole, actionPair };
}
