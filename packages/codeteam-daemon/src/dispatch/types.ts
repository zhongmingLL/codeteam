import type { AgentProfile, AgentSession, Handoff, Message, Run, Task } from "../control/stores/types.ts";

export interface DispatchRoute {
	readonly targetProfileId: string;
	readonly taskId: string;
	readonly role: string;
	readonly agentSessionId: string;
	readonly provider: string;
	readonly model: string;
	readonly modelFamily: string;
	readonly l0Revision: string | null;
	readonly attempt: number;
	readonly chainMetadata: Record<string, unknown>;
}

export interface DispatchExecutionRequest {
	readonly run: Run;
	readonly task: Task;
	readonly session: AgentSession;
	readonly target: AgentProfile;
	readonly sourceMessage: Message;
	readonly responseMessage: Message;
	readonly route: DispatchRoute;
	readonly handoff: Handoff | null;
}

export interface AgentExecutionResult {
	readonly bodyMd: string;
	readonly usage?: Record<string, unknown> | null;
	readonly toolCalls?: readonly string[];
}

export interface AgentExecutor {
	execute(request: DispatchExecutionRequest, signal: AbortSignal): Promise<AgentExecutionResult>;
}

export class InterruptedExecutionError extends Error {
	readonly code: string;

	constructor(code: string, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "InterruptedExecutionError";
		this.code = code;
	}
}

export class RetryableExecutionError extends Error {
	readonly code: string;

	constructor(code: string, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "RetryableExecutionError";
		this.code = code;
	}
}

export type DispatchTerminalStatus = "completed" | "canceled" | "failed" | "interrupted";

export interface DispatchRunOutcome {
	readonly runId: string;
	readonly targetProfileId: string;
	readonly status: DispatchTerminalStatus;
	readonly responseMessageId: string | null;
	readonly error?: string;
	readonly schemaCorrection?: string;
}

export interface DispatchEntryError {
	readonly queueEntryId: string;
	readonly targetProfileId?: string;
	readonly code: string;
	readonly message: string;
}

export interface DispatchDrainResult {
	readonly claimedQueueEntryIds: readonly string[];
	readonly runs: readonly Run[];
	readonly outcomes: readonly DispatchRunOutcome[];
	readonly errors: readonly DispatchEntryError[];
}

export interface DispatchDrainOptions {
	readonly maxEntries?: number;
	readonly claimTtlMs?: number;
}

export interface DispatchSettleInput {
	readonly status: DispatchTerminalStatus;
	readonly bodyMd?: string;
	readonly usage?: Record<string, unknown> | null;
	readonly reason?: string;
	readonly actorRef?: string;
}

export interface DispatchServiceHooks {
	readonly onRunTerminal?: (run: Run, input: DispatchSettleInput) => void;
}

export interface GuideRunInput {
	readonly runId: string;
	readonly kind: "steer" | "followUp" | "humanGuidance";
	readonly payload: Record<string, unknown>;
	readonly actorRef: string;
}

export interface InterruptRunResult {
	readonly canceledRun: Run;
	readonly retryQueueEntryId: string | null;
}
