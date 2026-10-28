import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import type { AgentProfile, AgentSession, Run, Task } from "../control/stores/types.ts";

export interface RunPrincipal {
	readonly runId: string;
	readonly taskId: string;
	readonly threadId: string;
	readonly profileId: string;
	readonly role: string;
	readonly userId: string;
	readonly provider: string;
	readonly model: string;
	readonly modelFamily: string;
	readonly chainMetadata: Record<string, unknown>;
	readonly run: Run;
	readonly task: Task;
	readonly session: AgentSession;
	readonly profile: AgentProfile;
}

export function resolveRunPrincipal(store: ControlStore, runId: string): RunPrincipal {
	const run = store.runs.get(runId);
	if (!run) throw new ControlError("not_found", `run ${runId} not found`);
	const task = store.tasks.get(run.taskId);
	if (!task) throw new ControlError("not_found", `task ${run.taskId} not found`);
	const session = store.sessions.get(run.agentSessionId);
	if (!session) throw new ControlError("not_found", `agent session ${run.agentSessionId} not found`);
	const profile = store.profiles.get(run.recipientProfileId);
	if (!profile) throw new ControlError("not_found", `agent profile ${run.recipientProfileId} not found`);
	if (task.threadId !== session.threadId) {
		throw new ControlError("invalid_state", "run task and session thread do not match");
	}
	if (session.taskId !== task.id || session.profileId !== profile.id || session.role !== run.role) {
		throw new ControlError("invalid_state", "run session does not match the run task/profile/role");
	}
	const userId = session.userId ?? task.userId;
	if (!userId) throw new ControlError("invalid_state", `run ${run.id} has no owning user`);
	return {
		runId: run.id,
		taskId: task.id,
		threadId: task.threadId,
		profileId: profile.id,
		role: profile.role,
		userId,
		provider: run.provider,
		model: run.model,
		modelFamily: run.modelFamily,
		chainMetadata: run.chainMetadata,
		run,
		task,
		session,
		profile,
	};
}
