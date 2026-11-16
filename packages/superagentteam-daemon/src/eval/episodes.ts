import { createHash } from "node:crypto";
import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import type { Eval, Merge, Review, Run, Task, Verification } from "../control/stores/types.ts";
import type { ControlEvidenceSourceRef } from "../memory/contract.ts";
import type { TaskOutcomeEpisodeMetricsV1 } from "./contract.ts";

export interface MaterializeTaskOutcomeOptions {
	readonly taskIds?: readonly string[];
	readonly since?: number;
	readonly until?: number;
	readonly limit?: number;
}

export interface SkippedTaskOutcome {
	readonly taskId: string;
	readonly reason: string;
}

export interface MaterializeTaskOutcomeResult {
	readonly episodes: readonly Eval[];
	readonly created: number;
	readonly skipped: readonly SkippedTaskOutcome[];
}

const EXECUTION_ROLES = new Set(["coder", "architect"]);
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "canceled", "interrupted"]);

function hashPayload(payload: unknown): string {
	return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

function numericField(usage: Record<string, unknown> | null, keys: readonly string[]): number | null {
	if (!usage) return null;
	for (const key of keys) {
		const value = usage[key];
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	}
	return null;
}

function extractUsage(usage: Record<string, unknown> | null): {
	tokens: number | null;
	costUsd: number | null;
} {
	const total = numericField(usage, ["total_tokens", "totalTokens", "tokens"]);
	const input = numericField(usage, ["input_tokens", "inputTokens", "prompt_tokens"]);
	const output = numericField(usage, ["output_tokens", "outputTokens", "completion_tokens"]);
	const tokens = total ?? (input !== null && output !== null ? input + output : null);
	const costUsd = numericField(usage, ["cost_usd", "costUsd", "cost"]);
	return { tokens, costUsd };
}

function primaryTerminalRun(runs: readonly Run[]): Run | null {
	const terminal = runs.filter((run) => TERMINAL_RUN_STATUSES.has(run.status));
	if (terminal.length === 0) return null;
	const executionRuns = terminal.filter((run) => EXECUTION_ROLES.has(run.role));
	const candidates = executionRuns.length > 0 ? executionRuns : terminal;
	return [...candidates].sort((left, right) => {
		const leftAt = left.terminalAt ?? left.startedAt;
		const rightAt = right.terminalAt ?? right.startedAt;
		return rightAt - leftAt || right.id.localeCompare(left.id);
	})[0]!;
}

function countHumanInterventions(store: ControlStore, taskId: string): number {
	const row = store.database
		.prepare("SELECT COUNT(*) AS count FROM messages WHERE task_id = ? AND author_kind = 'user'")
		.get(taskId) as { count?: number } | undefined;
	return row?.count ?? 0;
}

function collectVerifications(reviews: readonly Review[], store: ControlStore): Verification[] {
	const verifications: Verification[] = [];
	for (const review of reviews) {
		for (const finding of review.findings) {
			verifications.push(...store.reviews.listVerifications(finding.id));
		}
	}
	return verifications;
}

function firstSuccessfulMerge(merges: readonly Merge[]): Merge | null {
	const succeeded = merges.filter((merge) => merge.status === "succeeded");
	if (succeeded.length === 0) return null;
	return [...succeeded].sort((left, right) => {
		const leftAt = left.mergedAt ?? left.createdAt;
		const rightAt = right.mergedAt ?? right.createdAt;
		return leftAt - rightAt || left.id.localeCompare(right.id);
	})[0]!;
}

function deriveOutcome(task: Task, merges: readonly Merge[]): TaskOutcomeEpisodeMetricsV1["outcome"] {
	if (merges.some((merge) => merge.status === "succeeded")) return "merged";
	if (task.disposition === "abandoned" || task.disposition === "canceled") return "abandoned";
	if (task.status === "blocked") return "blocked";
	if (task.status === "done") return "rejected";
	return "unknown";
}

function roundRatio(numerator: number, denominator: number): number | null {
	return denominator === 0 ? null : numerator / denominator;
}

export interface BuildTaskOutcomeEpisodeResult {
	readonly id: string;
	readonly metrics: TaskOutcomeEpisodeMetricsV1;
	readonly status: "ok" | "insufficient" | "no_data" | "degraded";
	readonly reasons: string[];
}

export function buildTaskOutcomeEpisode(store: ControlStore, task: Task, run: Run): BuildTaskOutcomeEpisodeResult {
	const reviews = store.reviews.listByTask(task.id);
	const merges = store.merges.listByTask(task.id);
	const verifications = collectVerifications(reviews, store);
	const budget = store.budgets.getByTask(task.id);
	const usage = extractUsage(run.usage);
	const tokens = usage.tokens ?? budget?.tokensUsed ?? null;
	const costUsd = usage.costUsd ?? budget?.costUsed ?? null;
	const latencyMs = run.terminalAt === null ? null : Math.max(0, run.terminalAt - run.startedAt);
	const findings = { total: 0, p1: 0, p2: 0, p3: 0 };
	for (const review of reviews) {
		for (const finding of review.findings) {
			findings.total += 1;
			if (finding.severity === "P1") findings.p1 += 1;
			else if (finding.severity === "P2") findings.p2 += 1;
			else findings.p3 += 1;
		}
	}
	const verificationCounts = { confirmed: 0, rejected: 0, blocked: 0 };
	for (const verification of verifications) {
		if (verification.status === "confirmed") verificationCounts.confirmed += 1;
		else if (verification.status === "rejected") verificationCounts.rejected += 1;
		else verificationCounts.blocked += 1;
	}
	const decidedVerifications = verificationCounts.confirmed + verificationCounts.rejected;
	const firstRound = [...reviews].sort(
		(left, right) => left.round - right.round || left.id.localeCompare(right.id),
	)[0];
	const firstPassReviewPass = firstRound ? (firstRound.round === 1 ? firstRound.verdict === "approve" : null) : null;
	const reviewRounds = reviews.reduce((max, review) => Math.max(max, review.round), 0);
	const firstMerge = firstSuccessfulMerge(merges);
	const timeToGreenMs = firstMerge
		? Math.max(0, (firstMerge.mergedAt ?? firstMerge.createdAt) - task.createdAt)
		: null;
	const successfulMerges = merges.filter((merge) => merge.status === "succeeded").length;
	const costPerMergedChangeUsd =
		budget && successfulMerges > 0 ? Number((budget.costUsed / successfulMerges).toFixed(6)) : null;
	const artifacts = store.artifacts.listByTask(task.id);
	const sourceRefs: ControlEvidenceSourceRef["ref"][] = [
		`task:${task.id}`,
		...reviews.map((review) => `review:${review.id}` as const),
		...verifications.map((verification) => `verification:${verification.id}` as const),
		...merges.map((merge) => `merge:${merge.id}` as const),
		...artifacts.map((artifact) => `artifact:${artifact.id}` as const),
	];
	const metrics: TaskOutcomeEpisodeMetricsV1 = {
		v: 1,
		kind: "task_outcome_episode",
		synthetic: false,
		taskId: task.id,
		runId: run.id,
		repo: task.repo ?? merges.find((merge) => merge.repo)?.repo ?? null,
		outcome: deriveOutcome(task, merges),
		firstPassReviewPass,
		reviewRounds,
		findings,
		verifications: verificationCounts,
		tokens,
		costUsd,
		latencyMs,
		humanInterventionCount: countHumanInterventions(store, task.id),
		codeMetrics: {
			reviewFalsePositiveRate: roundRatio(verificationCounts.rejected, decidedVerifications),
			findingSurvival: roundRatio(verificationCounts.confirmed, decidedVerifications),
			timeToGreenMs,
			costPerMergedChangeUsd,
		},
		sourceRefs: [...new Set(sourceRefs)],
		windowStartMs: task.createdAt,
		windowEndMs: Math.max(run.terminalAt ?? run.startedAt, task.updatedAt, task.createdAt + 1),
	};
	const reasons: string[] = [];
	let status: BuildTaskOutcomeEpisodeResult["status"] = "ok";
	if (run.status !== "completed") {
		status = "degraded";
		reasons.push(`run_${run.status}`);
	} else if (reviews.length === 0 && merges.length === 0) {
		status = "no_data";
		reasons.push("no_review_evidence", "no_merge_evidence");
	} else if (reviews.length === 0) {
		status = "insufficient";
		reasons.push("no_review_evidence");
	}
	return {
		id: `eval-task-outcome-${hashPayload(metrics)}`,
		metrics,
		status,
		reasons,
	};
}

export function materializeTaskOutcomeEpisodes(
	store: ControlStore,
	options: MaterializeTaskOutcomeOptions = {},
): MaterializeTaskOutcomeResult {
	let tasks: Task[];
	if (options.taskIds && options.taskIds.length > 0) {
		tasks = options.taskIds.map((taskId) => {
			const task = store.tasks.get(taskId);
			if (!task) throw new ControlError("not_found", `task ${taskId} not found`);
			return task;
		});
	} else {
		tasks = store.tasks
			.list()
			.filter((task) => options.since === undefined || task.createdAt >= options.since)
			.filter((task) => options.until === undefined || task.createdAt <= options.until)
			.slice(0, options.limit ?? 500);
	}
	const episodes: Eval[] = [];
	const skipped: SkippedTaskOutcome[] = [];
	let created = 0;
	for (const task of tasks) {
		const run = primaryTerminalRun(store.runs.list({ taskId: task.id }));
		if (!run) {
			skipped.push({ taskId: task.id, reason: "no_terminal_run" });
			continue;
		}
		const episode = buildTaskOutcomeEpisode(store, task, run);
		const existing = store.evals.get(episode.id);
		if (existing) {
			episodes.push(existing);
			continue;
		}
		try {
			const record = store.evals.create({
				id: episode.id,
				taskId: task.id,
				provider: run.provider,
				model: run.model,
				role: run.role,
				metrics: episode.metrics as unknown as Record<string, unknown>,
				bundleId: `task-outcome:${task.id}`,
				measurementRef: `task:${task.id}`,
				windowStartMs: episode.metrics.windowStartMs,
				windowEndMs: episode.metrics.windowEndMs,
				status: episode.status,
				reasons: episode.reasons,
			});
			episodes.push(record);
			created += 1;
		} catch (error) {
			if (error instanceof ControlError && error.code === "conflict") {
				const raced = store.evals.get(episode.id);
				if (raced) {
					episodes.push(raced);
					continue;
				}
			}
			throw error;
		}
	}
	return { episodes, created, skipped };
}
