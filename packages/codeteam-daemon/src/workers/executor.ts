import { unlinkSync } from "node:fs";
import { mintInvocationCredential } from "../auth/mint.ts";
import { resolveInvocationTokenDir } from "../auth/tokens.ts";
import type { ControlStore } from "../control/store.ts";
import type { AgentExecutionResult, AgentExecutor, DispatchExecutionRequest } from "../dispatch/types.ts";
import { InterruptedExecutionError, RetryableExecutionError } from "../dispatch/types.ts";
import { WorkerEventSink } from "./event-sink.ts";
import { type WorkerHarness, WorkerStartError } from "./harness.ts";
import { buildWorkerPrompt } from "./prompt.ts";
import { RpcProcessExitError, RpcProtocolError, RpcTimeoutError } from "./rpc-client.ts";
import { allowedToolsForRole } from "./tool-policy.ts";

export interface RpcAgentExecutorOptions {
	readonly store: ControlStore;
	readonly harness: WorkerHarness;
	readonly dataDir: string;
	readonly clock?: () => number;
}

export class RpcAgentExecutor implements AgentExecutor {
	readonly store: ControlStore;
	readonly harness: WorkerHarness;
	readonly dataDir: string;
	private readonly clock: () => number;

	constructor(options: RpcAgentExecutorOptions) {
		this.store = options.store;
		this.harness = options.harness;
		this.dataDir = options.dataDir;
		this.clock = options.clock ?? Date.now;
	}

	async execute(request: DispatchExecutionRequest, signal: AbortSignal): Promise<AgentExecutionResult> {
		const { run, task, session, sourceMessage } = request;
		if (run.status !== "running") {
			throw new InterruptedExecutionError("run_not_running", `run ${run.id} is ${run.status}`);
		}
		if (session.status !== "active") {
			throw new InterruptedExecutionError("session_not_active", `session ${session.id} is ${session.status}`);
		}
		if (!task.worktree) {
			throw new RetryableExecutionError("task_worktree_missing", `task ${task.id} has no worktree`);
		}
		if (signal.aborted) throw new InterruptedExecutionError("aborted", "run was aborted before execution");
		let ensured: Awaited<ReturnType<WorkerHarness["ensureWorker"]>>;
		try {
			ensured = await this.harness.ensureWorker({ sessionId: session.id, task, runId: run.id });
		} catch (error) {
			if (error instanceof WorkerStartError) {
				throw new RetryableExecutionError(error.code, error.message, { cause: error });
			}
			throw error;
		}
		const handle = ensured.handle;
		this.store.runs.attachWorker(run.id, handle.worker.id);
		const tokenDir = resolveInvocationTokenDir(this.dataDir);
		const minted = mintInvocationCredential(this.store, {
			runId: run.id,
			tokenDir,
			toolPolicy: { allowedTools: [...allowedToolsForRole(session.role)] },
		});
		const sink = new WorkerEventSink(this.store, run.id);
		const off = handle.connection.onEvent((event) => sink.handle(event));
		try {
			if (ensured.degradedReason) {
				this.store.runs.appendEvent(run.id, "error", {
					phase: "session_reattach_failed",
					reason: ensured.degradedReason,
				});
			}
			const prompt = buildWorkerPrompt({
				task,
				session: ensured.handle.session,
				sourceMessage,
				continuityCapsule: ensured.handle.session.continuityCapsule,
				degradedContinuity: ensured.degradedReason,
			});
			const result = await this.harness.prompt(handle, {
				runId: run.id,
				token: minted.token,
				prompt,
				signal,
			});
			const summary = sink.summary(result.aborted ? "Execution aborted." : "");
			if (sink.errorMessage) {
				throw new RetryableExecutionError("model_error", sink.errorMessage);
			}
			if (sink.eventWriteErrors > 0) {
				this.store.audit.append({
					actor: "system:worker",
					action: "worker_event_reflow_degraded",
					subject: `run:${run.id}`,
					args: { writeErrors: sink.eventWriteErrors },
				});
			}
			const latest = this.store.sessions.get(session.id);
			if (latest) {
				this.store.sessions.updateRuntimeBinding(session.id, {
					messageCount: latest.messageCount + 1,
					lastUsage: summary.usage,
				});
			}
			return {
				bodyMd: summary.bodyMd,
				usage: summary.usage,
				toolCalls: summary.toolCalls,
			};
		} catch (error) {
			if (signal.aborted) throw error;
			if (error instanceof RpcProcessExitError) {
				throw new InterruptedExecutionError("worker_crashed", error.message, { cause: error });
			}
			if (error instanceof RpcTimeoutError) {
				throw new RetryableExecutionError("worker_timeout", error.message, { cause: error });
			}
			if (error instanceof RpcProtocolError) {
				throw new RetryableExecutionError("worker_protocol_error", error.message, { cause: error });
			}
			if (error instanceof WorkerStartError) {
				throw new RetryableExecutionError(error.code, error.message, { cause: error });
			}
			throw error;
		} finally {
			off();
			if (minted.tokenPath) {
				try {
					unlinkSync(minted.tokenPath);
				} catch {
					// The terminal tombstone remains authoritative.
				}
			}
			this.store.audit.append({
				actor: "system:worker",
				action: "worker_run_finished",
				subject: `run:${run.id}`,
				args: { workerId: handle.worker.id, at: this.clock() },
			});
		}
	}
}
