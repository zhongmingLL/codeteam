import type { DatabaseSync } from "node:sqlite";
import type { AgentStreamEvent } from "@superagentteam/shared/types";
import { OperatorMessageIngress } from "../a2a/router.ts";
import type { AgentRegistry } from "../agent/registry.ts";
import { RunAgentTurn } from "../agent/turn.ts";
import { InvocationCredentialStore } from "../auth/store.ts";
import { HistoryAssembler } from "../history/assembler.ts";
import { InvocationOwnerReaper, type RecoveryDeps, TurnExecutionStartupReconciler } from "../invocation/recovery.ts";
import { ResponseRecoveryService } from "../invocation/settlement.ts";
import { InvocationAttemptStore, InvocationRecordStore, TurnExecutionStore } from "../invocation/store.ts";
import { AgentReadStateStore, MessageStore } from "../message/store.ts";
import { QueueProcessor } from "../queue/processor.ts";
import { QueueLedgerStore } from "../queue/store.ts";
import { InvocationTracker } from "../queue/tracker.ts";
import { ResponseDraftStore } from "../response/store.ts";
import { AgentSessionStore } from "../session/store.ts";
import { ThreadStore } from "../thread/store.ts";
import { MultiMentionOrchestrator } from "../multi-mention/orchestrator.ts";
import { MultiMentionStore } from "../multi-mention/store.ts";
import { WorkerPool, type WorkerSpawnPort } from "../worker/pool.ts";
import { WorkerBindingStore, WorkerStore } from "../worker/store.ts";
import { A2AToolService } from "./tool-service.ts";

// F018 R2-d composition root: one wiring point for the daemon (and the E2E
// suite) — ingress, processor, runAgentTurn, pool, reaper, startup
// reconciler, T4 recovery. Everything above the stores is constructed here.

export interface A2ARuntimeDeps {
	db: DatabaseSync;
	registry: AgentRegistry;
	spawn: WorkerSpawnPort;
	onStreamEvent?: (event: AgentStreamEvent) => void;
	clock?: () => number;
	processStartedAt?: number;
	promptTimeoutMs?: number;
}

export interface A2ARuntime {
	threads: ThreadStore;
	messages: MessageStore;
	readState: AgentReadStateStore;
	sessions: AgentSessionStore;
	credentials: InvocationCredentialStore;
	drafts: ResponseDraftStore;
	multiMention: MultiMentionStore;
	a2aTools: A2AToolService;
	multiMentionOrchestrator: MultiMentionOrchestrator;
	records: InvocationRecordStore;
	turns: TurnExecutionStore;
	attempts: InvocationAttemptStore;
	queue: QueueLedgerStore;
	tracker: InvocationTracker;
	workerStore: WorkerStore;
	pool: WorkerPool;
	ingress: OperatorMessageIngress;
	processor: QueueProcessor;
	startup: TurnExecutionStartupReconciler;
	reaper: InvocationOwnerReaper;
	recovery: ResponseRecoveryService;
}

export function buildA2ARuntime(deps: A2ARuntimeDeps): A2ARuntime {
	const clock = deps.clock ?? Date.now;
	const db = deps.db;
	const threads = new ThreadStore(db);
	const messages = new MessageStore(db);
	const readState = new AgentReadStateStore(db);
	const sessions = new AgentSessionStore(db);
	const credentials = new InvocationCredentialStore(db);
	const drafts = new ResponseDraftStore(db);
	const multiMention = new MultiMentionStore(db);
	const records = new InvocationRecordStore(db);
	const turns = new TurnExecutionStore(db);
	const attempts = new InvocationAttemptStore(db);
	const queue = new QueueLedgerStore(db);
	const tracker = new InvocationTracker(clock);
	const workerStore = new WorkerStore(db);
	const bindingStore = new WorkerBindingStore(db);
	const pool = new WorkerPool({ workers: workerStore, bindings: bindingStore, spawn: deps.spawn, clock });
	const assembler = new HistoryAssembler({ messages, readState });
	const ingress = new OperatorMessageIngress({ db, registry: deps.registry, threads, messages, queue });
	const a2aTools = new A2AToolService({ db, registry: deps.registry, threads, messages, queue, credentials, clock });
	const multiMentionOrchestrator = new MultiMentionOrchestrator({
		db,
		registry: deps.registry,
		threads,
		messages,
		queue,
		credentials,
		attempts,
		turns,
		store: multiMention,
		clock,
	});
	const runAgentTurn = new RunAgentTurn({
		db,
		assembler,
		pool,
		attempts,
		sessions,
		drafts,
		threads,
		turns,
		credentials,
		readState,
		messages,
		onStreamEvent: deps.onStreamEvent,
		clock,
		promptTimeoutMs: deps.promptTimeoutMs,
	});
	const processor = new QueueProcessor({
		db,
		registry: deps.registry,
		queue,
		records,
		turns,
		attempts,
		sessions,
		credentials,
		drafts,
		messages,
		threads,
		tracker,
		dispatchTarget: runAgentTurn,
		multiMention,
		multiMentionOrchestrator,
		capacity: { check: (threadId, targets) => pool.checkCapacityFor(threadId, targets) },
		clock,
	});
	const settlementDeps = {
		db,
		turns,
		attempts,
		credentials,
		sessions,
		readState,
		messages,
		drafts,
		multiMention,
		threads,
		clock,
	};
	const recoveryDeps: RecoveryDeps = {
		...settlementDeps,
		queue,
		workers: workerStore,
		releaseSlot: (threadId, agentId, turnExecutionId) => {
			tracker.complete(threadId, agentId, turnExecutionId);
		},
		listStaleSlots: (now, minAgeMs) => tracker.listStaleSlots(now, minAgeMs),
		isWorkerLive: (turnExecutionId) => {
			// EXACT owner fence (§3.10.2): judge by the attempt's own worker
			// binding — the session's CURRENT binding may belong to a newer
			// worker and must not keep an old zombie alive. draining with a
			// valid lease counts live (finalizing providers); unreadable →
			// throw → defer.
			const attempt = attempts.getByTurnExecutionId(turnExecutionId);
			if (!attempt || !attempt.workerId) return false;
			const worker = workerStore.get(attempt.workerId);
			if (!worker) return false;
			if (worker.state === "retired" || worker.state === "stale") return false;
			return worker.leaseExpiresAt > clock();
		},
		processStartedAt: deps.processStartedAt ?? clock(),
		settleMultiMention: (now) => {
			multiMentionOrchestrator.settleExpired(now);
		},
		recoverMultiMention: (now) => {
			multiMentionOrchestrator.recover(now);
		},
	};
	return {
		threads,
		messages,
		readState,
		sessions,
		credentials,
		drafts,
		multiMention,
		a2aTools,
		multiMentionOrchestrator,
		records,
		turns,
		attempts,
		queue,
		tracker,
		workerStore,
		pool,
		ingress,
		processor,
		startup: new TurnExecutionStartupReconciler(recoveryDeps),
		reaper: new InvocationOwnerReaper(recoveryDeps),
		recovery: new ResponseRecoveryService(settlementDeps),
	};
}
