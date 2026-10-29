import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalDomainRegistryEntry, VerdictHandoffPacketV1 } from "../../src/eval/contract.ts";
import { publishEvalVerdict } from "../../src/eval/publish.ts";
import { type ControlStore, openControlStore } from "../../src/index.ts";

export const HEAD_SHA = "a".repeat(40);
export const BASE_SHA = "b".repeat(40);
export const MERGE_SHA = "c".repeat(40);

export interface EvalFixture {
	readonly store: ControlStore;
	readonly dataDir: string;
	readonly entry: EvalDomainRegistryEntry;
	now(): number;
	advance(ms: number): number;
	cleanup(): void;
}

export function createEvalFixture(): EvalFixture {
	const dataDir = mkdtempSync(join(tmpdir(), "codeteam-eval-"));
	let current = 1_700_000_000_000;
	const store = openControlStore({ dataDir, clock: () => current });
	store.seedIdentity({
		eval: {
			profileId: "profile:eval",
			provider: "eval-provider",
			model: "eval-model",
			modelFamily: "eval-family",
		},
		compress: { provider: "test", model: "compress-model", modelFamily: "test-family" },
	});
	store.profiles.create({
		id: "profile:owner",
		role: "coder",
		displayName: "Owner",
		provider: "owner-provider",
		model: "glm-owner",
		modelFamily: "glm",
		toolPolicyProfile: "default",
	});
	store.profiles.create({
		id: "profile:reviewer",
		role: "reviewer",
		displayName: "Reviewer",
		provider: "reviewer-provider",
		model: "qwen-reviewer",
		modelFamily: "qwen",
		toolPolicyProfile: "default",
	});
	store.threads.create({ id: "thread:eval-domain", title: "Eval domain" });
	store.threads.create({ id: "thread:work", title: "Work" });
	const entry: EvalDomainRegistryEntry = {
		domainId: "eval:test-domain",
		descriptionForHuman: "Test domain",
		systemThreadId: "thread:eval-domain",
		evalAgent: "profile:eval",
		frequency: "daily",
		triggerPolicy: { kind: "time_only", maxDetectionDelayHours: 24 },
		sourceAdapter: "task_outcome",
		sourceRefsKind: "task",
		sla: { acknowledgementHours: 24, reevaluationHours: 168 },
		enabled: true,
	};
	return {
		store,
		dataDir,
		entry,
		now: () => current,
		advance: (ms) => {
			current += ms;
			return current;
		},
		cleanup: () => {
			store.close();
			rmSync(dataDir, { recursive: true, force: true });
		},
	};
}

export function makeVerdictPacket(overrides: Partial<VerdictHandoffPacketV1> = {}): VerdictHandoffPacketV1 {
	const base: VerdictHandoffPacketV1 = {
		v: 1,
		id: "verdict-1",
		domainId: "eval:test-domain",
		bundleId: "bundle-1",
		createdAt: 1_700_000_000_000,
		phenomenon: "review quality fluctuates",
		harnessUnderEval: { featureId: "F014", componentId: "review", name: "review quality" },
		evidencePacket: {
			sourceRefs: ["review:review-1"],
			summary: "one review round with one confirmed finding",
			measurement: {
				status: "ok",
				method: "fixture",
				windowStartMs: 1_700_000_000_000,
				windowEndMs: 1_700_000_100_000,
				measurementRef: "measurement:1",
				reasons: [],
			},
		},
		rootCauseHypothesis: "review prompt is under-specified",
		verdict: "fix",
		findingKey: "review-quality-1",
		findings: [
			{
				severity: "P2",
				claim: "review misses a seeded bug",
				evidenceRefs: ["review:review-1"],
				requiredAction: "add a falsifier",
			},
		],
		ownerAsk: {
			targetFeatureId: "F014",
			targetOwnerProfileId: "profile:owner",
			requestedAction: "add a falsifier",
		},
		acceptanceReevalPlan: {
			nextEvalAt: 1_700_000_000_000 + 7 * 24 * 60 * 60 * 1000,
			closureCondition: "next review round catches the seeded bug",
		},
		counterarguments: ["fixture size is small"],
		governance: { cvoAcceptRequired: false, cvoSuppressed: false },
	};
	return { ...base, ...overrides };
}

export function publishFixturePacket(
	fixture: EvalFixture,
	overrides: Partial<VerdictHandoffPacketV1> = {},
): ReturnType<typeof publishEvalVerdict> {
	const packet = makeVerdictPacket(overrides);
	return publishEvalVerdict(fixture.store, {
		entry: fixture.entry,
		packet,
		actor: { kind: "eval", id: "profile:eval" },
		dataDir: fixture.dataDir,
	});
}

export interface OutcomeSeed {
	readonly taskId: string;
	readonly runId: string;
	readonly reviewId: string;
	readonly findingId: string;
	readonly mergeId: string;
}

export function seedOutcomeTask(
	store: ControlStore,
	options: { withReview?: boolean; withMerge?: boolean } = {},
): OutcomeSeed {
	const withReview = options.withReview ?? true;
	const withMerge = options.withMerge ?? true;
	store.backlog.create({
		id: "backlog-outcome",
		userId: "user-1",
		title: "Outcome task",
		summary: "outcome fixture",
		priority: "p1",
		tags: ["feature:F014"],
		createdByKind: "user",
		createdById: "user-1",
	});
	store.tasks.create({
		id: "task-outcome",
		kind: "work",
		threadId: "thread:work",
		title: "Outcome task",
		why: "fixture",
		ownerProfileId: "profile:owner",
		createdBy: "user-1",
		userId: "user-1",
		backlogItemId: "backlog-outcome",
		repo: "repo-a",
	});
	store.sessions.create({
		id: "session-author",
		threadId: "thread:work",
		taskId: "task-outcome",
		profileId: "profile:owner",
		role: "coder",
		effectiveToolPolicy: "default",
		provider: "owner-provider",
		model: "glm-owner",
		modelFamily: "glm",
		seq: 0,
		userId: "user-1",
	});
	store.sessions.create({
		id: "session-reviewer",
		threadId: "thread:work",
		taskId: "task-outcome",
		profileId: "profile:reviewer",
		role: "reviewer",
		effectiveToolPolicy: "default",
		provider: "reviewer-provider",
		model: "qwen-reviewer",
		modelFamily: "qwen",
		seq: 0,
		userId: "user-1",
	});
	const message = store.messages.append({
		threadId: "thread:work",
		taskId: "task-outcome",
		authorKind: "user",
		authorId: "user-1",
		kind: "chat",
		bodyMd: "please implement",
	});
	store.messages.append({
		threadId: "thread:work",
		taskId: "task-outcome",
		authorKind: "user",
		authorId: "user-1",
		kind: "chat",
		bodyMd: "one more thing",
	});
	const run = store.runs.create({
		id: "run-outcome",
		taskId: "task-outcome",
		role: "coder",
		agentSessionId: "session-author",
		sourceId: message.id,
		recipientProfileId: "profile:owner",
		provider: "owner-provider",
		model: "glm-owner",
		modelFamily: "glm",
		usage: { input_tokens: 100, output_tokens: 50, cost_usd: 0.25 },
	});
	store.budgets.create({ taskId: "task-outcome", tokensUsed: 150, costUsed: 0.5 });
	store.audit.append({
		actor: "profile:owner",
		action: "commit_created",
		subject: `commit:${HEAD_SHA}`,
		args: { headSha: HEAD_SHA, taskId: "task-outcome" },
	});
	let reviewId = "review-outcome";
	let findingId = "finding-outcome";
	if (withReview) {
		const review = store.reviews.create({
			id: reviewId,
			taskId: "task-outcome",
			runId: run.id,
			headSha: HEAD_SHA,
			baseSha: BASE_SHA,
			authorSessionId: "session-author",
			authorModel: "glm-owner",
			authorModelFamily: "glm",
			reviewerSessionId: "session-reviewer",
			reviewerModel: "qwen-reviewer",
			reviewerModelFamily: "qwen",
			authorProfileId: "profile:owner",
			reviewerProfileId: "profile:reviewer",
			riskClass: "code",
			reviewMode: "cross_family",
			verdict: "changes_requested",
			round: 1,
			stage: "review",
			envelope: {},
			decision: {},
			policy: {},
			findings: [
				{
					severity: "P2",
					claim: "missing test",
					evidenceKind: "repro_command",
					falsifier: "false",
					requiredAction: "add test",
				},
			],
		});
		reviewId = review.id;
		findingId = review.findings[0]!.id;
		store.reviews.verify({
			findingId,
			headSha: HEAD_SHA,
			producingReviewId: review.id,
			status: "confirmed",
			reason: "falsifier failed as expected",
			command: "false",
			exitCode: 1,
		});
	}
	let mergeId = "merge-outcome";
	if (withMerge) {
		const merge = store.merges.create({
			id: mergeId,
			taskId: "task-outcome",
			baseSha: BASE_SHA,
			headSha: HEAD_SHA,
			mergeSha: MERGE_SHA,
			policy: "routine",
			receiptRef: "receipt:1",
			executedBy: "service:merge-owner",
			gateEvidenceRef: "gate:1",
			reviewRef: withReview ? reviewId : null,
			status: "succeeded",
			repo: "repo-a",
		});
		mergeId = merge.id;
	}
	store.runs.terminal(run.id, {
		status: "completed",
		usage: { input_tokens: 100, output_tokens: 50, cost_usd: 0.25 },
	});
	store.tasks.setStatus("task-outcome", "done");
	return { taskId: "task-outcome", runId: run.id, reviewId, findingId, mergeId };
}
