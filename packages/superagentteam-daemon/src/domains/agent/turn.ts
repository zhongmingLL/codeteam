import type { DatabaseSync } from "node:sqlite";
import type { AgentStreamEvent } from "@superagentteam/shared/types";
import { runInTransaction } from "../../infrastructure/db/database.ts";
import type { InvocationCredentialStore } from "../auth/store.ts";
import { buildThreadPrompt, type HistoryAssembler } from "../history/assembler.ts";
import { RouteResponseCommitter, TurnExecutionLifecycle } from "../invocation/settlement.ts";
import type { InvocationAttemptStore, TurnExecutionStore } from "../invocation/store.ts";
import type { AgentReadStateStore, MessageStore } from "../message/store.ts";
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
	/** R2-c settlement layers (T1 child terminal + T2 response commit). */
	turns: TurnExecutionStore;
	credentials: InvocationCredentialStore;
	readState: AgentReadStateStore;
	messages: MessageStore;
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

	private settlementDeps() {
		return {
			db: this.deps.db,
			turns: this.deps.turns,
			attempts: this.deps.attempts,
			credentials: this.deps.credentials,
			sessions: this.deps.sessions,
			readState: this.deps.readState,
			messages: this.deps.messages,
			drafts: this.deps.drafts,
			threads: this.deps.threads,
			clock: this.clock,
		};
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
		// P2-3 (review): ensure → bindPiSession live INSIDE the guarded region —
		// a failure between acquiring the worker and the try block must not
		// leak the worker (port contract: release before any throw).
		let handle: Awaited<ReturnType<WorkerPool["ensure"]>> | null = null;
		try {
			handle = await this.deps.pool.ensure(poolKey, session);
			this.deps.attempts.bindWorker(prepared.attemptId, handle.workerId);

			// Bind the pi session identity on first spawn (resume continuity).
			if (handle.piSessionId && handle.piSessionFile && session.piSessionId === null) {
				runInTransaction(this.deps.db, () => {
					this.deps.sessions.bindPiSession(session.id, {
						piSessionId: handle!.piSessionId,
						piSessionFile: handle!.piSessionFile,
						now,
					});
				});
			}

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

			// T1 child terminal (0010 §6.1.1 step 9): ONE transaction — child
			// terminal + attempt projection + response_pending + credential +
			// recordCompletedTurn + cursor ack (promptDelivered-gated).
			const lifecycle = new TurnExecutionLifecycle(this.settlementDeps());
			const t1 = lifecycle.invokeTerminal({
				turnExecutionId: prepared.turnExecutionId,
				status: "completed",
				endedAt: this.clock(),
				userVisibleOutput: summary.content.trim().length > 0,
			});
			if (t1.outcome === "not_found" || t1.outcome === "terminal_conflict") {
				throw new Error(`t1_failed: ${t1.outcome}`);
			}

			// T2 response commit (§3.9): separate transaction; failure leaves
			// response_pending for T4 — never fails the turn.
			try {
				new RouteResponseCommitter(this.settlementDeps()).commit({
					turnExecutionId: prepared.turnExecutionId,
					content: summary.content,
					thinking: summary.thinking,
				});
			} catch {
				// T4 owns recovery; the child is already terminal.
			}
		} finally {
			// 0010 §6.1.1 step 10 (R2-c): worker release AFTER T2 settlement —
			// the response R is committed (or safely response_pending) before
			// the carrier retires; the pi session file survives regardless.
			if (handle) {
				await this.deps.pool.release(handle, "turn-complete").catch(() => {});
			}
		}
	}
}
