import type { DatabaseSync } from "node:sqlite";
import type { AgentStreamEvent } from "@superagentteam/shared/types";
import { runInTransaction } from "../../infrastructure/db/database.ts";
import { buildThreadPrompt, type HistoryAssembler } from "../history/assembler.ts";
import type { InvocationAttemptStore } from "../invocation/store.ts";
import type { DispatchTargetPort, PreparedDispatch } from "../queue/processor.ts";
import { ResponseEventSink } from "../response/sink.ts";
import type { ResponseDraftStore } from "../response/store.ts";
import type { AgentSessionStore } from "../session/store.ts";
import type { ThreadStore } from "../thread/store.ts";
import type { WorkerPool } from "../worker/pool.ts";
import type { WorkerPoolKey } from "../worker/store.ts";

// F018 R2-b runAgentTurn (0007 §3.5 / 0010 §6.1.1 steps 2-8): the real
// DispatchTargetPort. loadHistory (no ack) → acquire worker → build prompt →
// prompt RPC (markPromptDelivered from onAccepted) → stream into
// response_drafts + ephemeral AgentStreamEvents → usage to the attempt.
// T1 child-terminal / T2 settlement are R2-c; on failure this port throws
// CLEAN (the R2-a processor convergence owns turn/attempt/credential/R).

export interface RunAgentTurnDeps {
	db: DatabaseSync;
	assembler: HistoryAssembler;
	pool: WorkerPool;
	attempts: InvocationAttemptStore;
	sessions: AgentSessionStore;
	drafts: ResponseDraftStore;
	threads: ThreadStore;
	onStreamEvent?: (event: AgentStreamEvent) => void;
	clock?: () => number;
	promptTimeoutMs?: number;
}

export class RunAgentTurn implements DispatchTargetPort {
	private readonly deps: RunAgentTurnDeps;
	private readonly clock: () => number;

	constructor(deps: RunAgentTurnDeps) {
		this.deps = deps;
		this.clock = deps.clock ?? Date.now;
	}

	async dispatch(prepared: PreparedDispatch): Promise<void> {
		const now = this.clock();
		const session = this.deps.sessions.get(prepared.agentSessionId);
		if (!session || session.status !== "active") {
			throw new Error(`turn_session_not_active: ${prepared.agentId}`);
		}
		const attempt = this.deps.attempts.get(prepared.attemptId);
		if (!attempt || attempt.deliveryState !== "appended") {
			throw new Error(`turn_attempt_not_appended: ${prepared.attemptId}`);
		}

		// Step 2: history window (read-only cursor — ack happens in T1).
		const window = this.deps.assembler.loadHistory(prepared.threadId, prepared.agentId);

		// Step 3: acquire the ephemeral worker and bind it to the attempt.
		const poolKey: WorkerPoolKey = {
			projectPath: this.deps.threads.get(prepared.threadId)?.projectPath ?? "",
			accountRef: prepared.agentConfig.accountRef,
			provider: prepared.provider,
			model: prepared.model,
		};
		const handle = await this.deps.pool.ensure(poolKey, session);
		this.deps.attempts.bindWorker(prepared.attemptId, handle.workerId);

		// Bind the pi session identity on first spawn (resume continuity).
		if (handle.piSessionId && handle.piSessionFile && session.piSessionId === null) {
			runInTransaction(this.deps.db, () => {
				this.deps.sessions.bindPiSession(session.id, {
					piSessionId: handle.piSessionId,
					piSessionFile: handle.piSessionFile,
					now,
				});
			});
		}

		try {
			// Step 4: prompt (thread/participants/recent; no task scaffolding).
			const thread = this.deps.threads.get(prepared.threadId);
			if (!thread) throw new Error(`turn_thread_missing: ${prepared.threadId}`);
			const prompt = buildThreadPrompt({
				thread,
				participants: this.deps.threads.listParticipants(prepared.threadId),
				rows: window.rows,
				selfAgentId: prepared.agentId,
			});

			const sink = new ResponseEventSink({
				drafts: this.deps.drafts,
				attemptId: prepared.attemptId,
				turnExecutionId: prepared.turnExecutionId,
				parentInvocationId: prepared.parentInvocationId,
				threadId: prepared.threadId,
				agentId: prepared.agentId,
				createdAt: now,
				onStreamEvent: this.deps.onStreamEvent,
				onFirstVisibleOutput: () => {
					runInTransaction(this.deps.db, () => {
						this.deps.sessions.recordUserVisibleOutput(
							prepared.agentSessionId,
							prepared.turnExecutionId,
							this.clock(),
						);
					});
				},
				clock: this.clock,
			});
			const offEvent = handle.connection.onEvent((event) => sink.handle(event));

			try {
				// Step 5: prompt RPC. markPromptDelivered fires from onAccepted —
				// the provider has the payload; later failures still ack
				// (0010 §6.1.3 row 7 semantics live in T1/R2-c).
				await handle.connection.promptAndWait(prompt, {
					timeoutMs: this.deps.promptTimeoutMs ?? 300_000,
					onAccepted: () => {
						runInTransaction(this.deps.db, () => {
							this.deps.attempts.markPromptDelivered(prepared.attemptId, {
								deliveryBoundarySeq: window.boundarySeq,
								now: this.clock(),
							});
						});
					},
				});
			} finally {
				offEvent();
			}

			const summary = sink.summary();
			if (summary.errorMessage) {
				// Clean throw: the R2-a processor convergence terminalizes the
				// chain (turn/attempt/credential/R) and restores the target.
				throw new Error(`turn_provider_error: ${summary.errorMessage}`);
			}
			if (summary.usage) {
				this.deps.attempts.recordUsage(prepared.attemptId, summary.usage);
			}
			// Success: the durable response body lives in the draft; T1/T2
			// (R2-c) terminalize the child and commit the response R.
		} finally {
			// warmTtl=0 retire. NOTE (R2-c): 0010 §6.1.1 step 10 releases the
			// worker AFTER T2 R-settlement; until T2 lands, the draft already
			// holds the full snapshot and the pi session file survives worker
			// retirement, so this early release is safe and revisited in R2-c.
			await this.deps.pool.release(handle, "turn-complete").catch(() => {});
		}
	}
}
