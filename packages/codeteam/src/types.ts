import type { Clock } from "./clock.ts";
import type { ControlStore } from "./store.ts";

export type Role = "architect" | "coder" | "reviewer" | "verifier" | "human";

export type Stage = "intake" | "plan" | "implement" | "review" | "verify" | "done";

export type HandoffKind = "handoff" | "review_request" | "verdict" | "blocker" | "spec_change" | "plan_revision";

export type HandoffStatus = "pending" | "claimed" | "consumed" | "expired";

export type RunStatus = "running" | "completed" | "interrupted";

export type TaskStatus = "running" | "blocked" | "done";

export type StageChangeKind = "spec_change" | "plan_revision";

export interface Task {
	id: string;
	stage: Stage;
	status: TaskStatus;
}

export interface Run {
	id: string;
	taskId: string;
	role: Role;
	status: RunStatus;
	handoffId?: string;
	terminalAt?: number;
}

export interface Handoff {
	id: string;
	taskId: string;
	kind: HandoffKind;
	fromRole: Role;
	toRole: Role;
	status: HandoffStatus;
	subject: string;
	actionPair: string;
	expectedArtifact: string;
	payload: Record<string, unknown>;
	deadline: number;
	attempt: number;
	claimedByRunId?: string;
	claimedAt?: number;
	terminalAt?: number;
	result?: Record<string, unknown>;
	createdAt: number;
}

export interface CreateHandoffInput {
	taskId: string;
	kind: HandoffKind;
	fromRole: Role;
	toRole: Role;
	subject: string;
	actionPair: string;
	expectedArtifact: string;
	payload?: Record<string, unknown>;
	deadlineMs?: number;
}

export interface ClaimResult {
	handoff: Handoff;
	replayed: boolean;
}

export interface ControlPlaneOptions {
	clock?: Clock;
	loopLimit?: number;
	defaultDeadlineMs?: number;
	store?: ControlStore;
}
