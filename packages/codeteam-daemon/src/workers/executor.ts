import { unlinkSync } from "node:fs";
import { mintInvocationCredential } from "../auth/mint.ts";
import { resolveInvocationTokenDir } from "../auth/tokens.ts";
import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import type { AgentExecutionResult, AgentExecutor, DispatchExecutionRequest } from "../dispatch/types.ts";
import { InterruptedExecutionError, RetryableExecutionError } from "../dispatch/types.ts";
import type { ObservabilityRuntime } from "../observability/runtime.ts";
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
	readonly observability?: ObservabilityRuntime | null;
}

export class RpcAgentExecutor implements AgentExecutor {
	readonly store: ControlStore;
	readonly harness: WorkerHarness;
	readonly dataDir: string;
	private readonly clock: () => number;
	private readonly observability: ObservabilityRuntime | null;

	constructor(options: RpcAgentExecutorOptions) {
		this.store = options.store;
		this.harness = options.harness;
		this.dataDir = options.dataDir;
		this.clock = options.clock ?? Date.now;
		this.observability = options.observability ?? null;
	}

	async execute(request: DispatchExecutionRequest, signal: AbortSignal): Promise<AgentExecutionResult> {
		const { run, task, session, target, sourceMessage } = request;
		if (run.status !== "running") {
			throw new InterruptedExecutionError("run_not_running", `run ${run.id} is ${run.status}`);
		}
		if (session.status !== "active") {
			throw new InterruptedExecutionError("session_not_active", `session ${session.id} is ${session.status}`);
		}
		if (!task.worktree) {
			throw new RetryableExecutionError("task_worktree_missing", `task ${task.id} has no worktree`);
		}
		if (
			run.taskId !== task.id ||
			run.agentSessionId !== session.id ||
			run.recipientProfileId !== target.id ||
			session.taskId !== task.id ||
			session.profileId !== target.id
		) {
			throw new ControlError("invalid_input", `dispatch context mismatch for run ${run.id}`);
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
		const runSpan = this.observability?.tracer.startRunSpan(run) ?? null;
		const startedAt = this.clock();
		const sink = new WorkerEventSink(this.store, run.id, {
			profileId: run.recipientProfileId,
			toolUsage: this.store.toolUsage,
			observability: this.observability,
			parentSpan: runSpan?.context,
		});
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
			const bodyMd = ensured.degradedReason
				? `> Continuity degraded: ${ensured.degradedReason}\n\n${summary.bodyMd}`
				: summary.bodyMd;
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
			if (sink.toolUsageWriteErrors > 0) {
				this.store.audit.append({
					actor: "system:worker",
					action: "tool_usage_write_degraded",
					subject: `run:${run.id}`,
					args: { writeErrors: sink.toolUsageWriteErrors },
				});
			}
			const latest = this.store.sessions.get(session.id);
			if (latest) {
				this.store.sessions.updateRuntimeBinding(session.id, {
					messageCount: latest.messageCount + 1,
					lastUsage: summary.usage,
				});
			}
			runSpan?.setAttribute("run.execution", "completed");
			runSpan?.setStatus("ok");
			this.recordRunMetrics(run, "executed", startedAt);
			return {
				bodyMd,
				usage: summary.usage,
				toolCalls: summary.toolCalls,
			};
		} catch (error) {
			const code = executionErrorCode(error);
			runSpan?.setAttribute("run.execution", "failed");
			runSpan?.setStatus("error", code);
			this.recordRunMetrics(run, "failed", startedAt);
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
			sink.close();
			if (runSpan && !runSpan.isEnded()) runSpan.end();
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

	private recordRunMetrics(
		run: DispatchExecutionRequest["run"],
		status: "executed" | "failed",
		startedAt: number,
	): void {
		const metrics = this.observability?.metrics;
		if (!metrics) return;
		metrics
			.counter("codeteam_run_executions_total", {
				role: run.role,
				provider: run.provider,
				model: run.model,
				status,
			})
			.add();
		metrics
			.histogram("codeteam_run_execution_duration_ms", {
				role: run.role,
				provider: run.provider,
				model: run.model,
			})
			.observe(Math.max(0, this.clock() - startedAt));
	}
}

function executionErrorCode(error: unknown): string {
	if (error instanceof InterruptedExecutionError || error instanceof RetryableExecutionError) return error.code;
	if (error instanceof ControlError) return error.code;
	return "execution_error";
}
