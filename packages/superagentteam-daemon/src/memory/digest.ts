import type {
	DigestResult,
	SessionDigest,
	SessionDigestEvent,
	SessionDigestMerge,
	SessionDigestReview,
	SessionDigestVerification,
} from "./contract.ts";
import { MemoryError } from "./errors.ts";
import { redactSecrets } from "./redaction.ts";
import type { ControlEvidenceReader } from "./sources/control.ts";

type Row = Record<string, unknown>;

export interface BuildDigestOptions {
	readonly reader: ControlEvidenceReader | null;
	readonly runId?: string;
	readonly sessionId?: string;
	readonly maxEvents?: number;
}

function text(row: Row | undefined, key: string): string | null {
	if (!row) return null;
	const value = row[key];
	return typeof value === "string" ? value : null;
}

function number(row: Row | undefined, key: string): number | null {
	if (!row) return null;
	const value = row[key];
	return typeof value === "number" ? value : null;
}

function eventSummary(kind: string, payload: unknown): string {
	if (payload && typeof payload === "object" && !Array.isArray(payload)) {
		const record = payload as Record<string, unknown>;
		for (const key of ["messageId", "toolName", "name", "gate", "handoffId", "reviewId", "verificationId", "code"]) {
			const value = record[key];
			if (typeof value === "string" && value !== "") return `${kind}:${value}`;
		}
	}
	const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
	return `${kind}:${raw.length > 240 ? `${raw.slice(0, 237)}...` : raw}`;
}

function emptyDigest(sessionId: string): SessionDigest {
	return {
		runId: null,
		sessionId,
		taskId: null,
		threadId: "",
		role: "",
		provider: "",
		model: "",
		modelFamily: "",
		status: "unknown",
		startedAt: 0,
		terminalAt: null,
		task: null,
		eventCounts: {},
		events: [],
		reviews: [],
		verifications: [],
		merges: [],
		sourceRefs: [],
	};
}

export function buildSessionDigest(options: BuildDigestOptions): DigestResult {
	const reader = options.reader;
	if (!reader || !reader.available() || !reader.hasTable("runs") || !reader.hasTable("agent_sessions")) {
		return { found: false, reason: "control_db_absent" };
	}
	const database = reader.database;
	const run = options.runId
		? (database.prepare("SELECT * FROM runs WHERE id = ?").get(options.runId) as Row | undefined)
		: undefined;
	if (options.runId && !run) return { found: false, reason: "run_not_found" };
	const sessionId = options.sessionId ?? text(run, "agent_session_id");
	if (!sessionId) throw new MemoryError("invalid_input", "runId or sessionId is required");
	const session = database.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(sessionId) as Row | undefined;
	if (options.sessionId && !session) return { found: false, reason: "session_not_found" };
	const latestRun =
		run ??
		(options.sessionId
			? (database
					.prepare("SELECT * FROM runs WHERE agent_session_id = ? ORDER BY started_at DESC LIMIT 1")
					.get(sessionId) as Row | undefined)
			: undefined);
	const taskId = text(latestRun, "task_id") ?? text(session, "task_id");
	const task = taskId
		? (database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Row | undefined)
		: undefined;
	const threadId = text(session, "thread_id") ?? text(task, "thread_id") ?? "";
	const digest: SessionDigest = {
		...emptyDigest(sessionId),
		runId: text(latestRun, "id"),
		taskId,
		threadId,
		role: text(latestRun, "role") ?? text(session, "role") ?? "",
		provider: text(latestRun, "provider") ?? text(session, "provider") ?? "",
		model: text(latestRun, "model") ?? text(session, "model") ?? "",
		modelFamily: text(latestRun, "model_family") ?? text(session, "model_family") ?? "",
		status: text(latestRun, "status") ?? text(session, "status") ?? "unknown",
		startedAt: number(latestRun, "started_at") ?? number(session, "created_at") ?? 0,
		terminalAt: number(latestRun, "terminal_at"),
		task: task
			? {
					id: taskId ?? "",
					title: redactSecrets(text(task, "title") ?? "").text,
					why: redactSecrets(text(task, "why") ?? "").text,
					status: text(task, "status") ?? "",
				}
			: null,
	};

	const eventRows = latestRun
		? (database
				.prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY seq ASC")
				.all(text(latestRun, "id") ?? "") as unknown as Row[])
		: [];
	const eventCounts: Record<string, number> = {};
	for (const row of eventRows) {
		const kind = text(row, "kind") ?? "unknown";
		eventCounts[kind] = (eventCounts[kind] ?? 0) + 1;
	}
	const maxEvents = Math.min(Math.max(options.maxEvents ?? 200, 1), 500);
	const events: SessionDigestEvent[] = eventRows.slice(0, maxEvents).map((row) => {
		const kind = text(row, "kind") ?? "unknown";
		let payload: unknown = {};
		try {
			payload = JSON.parse(text(row, "payload_json") ?? "{}") as unknown;
		} catch {
			payload = text(row, "payload_json") ?? "";
		}
		return {
			seq: number(row, "seq") ?? 0,
			kind,
			summary: redactSecrets(eventSummary(kind, payload)).text,
			at: number(row, "ts") ?? 0,
		};
	});

	const reviewRows =
		taskId && reader.hasTable("reviews")
			? (database
					.prepare("SELECT * FROM reviews WHERE task_id = ? ORDER BY created_at DESC LIMIT 20")
					.all(taskId) as unknown as Row[])
			: [];
	const reviews: SessionDigestReview[] = [];
	const verifications: SessionDigestVerification[] = [];
	const sourceRefs = new Set<string>();
	if (latestRun && text(latestRun, "id")) sourceRefs.add(`run:${text(latestRun, "id")}`);
	sourceRefs.add(`session:${sessionId}`);
	if (taskId) sourceRefs.add(`task:${taskId}`);
	if (threadId) sourceRefs.add(`thread:${threadId}`);
	if (latestRun && text(latestRun, "response_message_id")) {
		sourceRefs.add(`message:${text(latestRun, "response_message_id")}`);
	}
	for (const review of reviewRows) {
		const reviewId = text(review, "id");
		if (!reviewId) continue;
		sourceRefs.add(`review:${reviewId}`);
		const findingRows = reader.hasTable("findings")
			? (database
					.prepare("SELECT * FROM findings WHERE review_id = ? ORDER BY finding_index")
					.all(reviewId) as unknown as Row[])
			: [];
		reviews.push({
			id: reviewId,
			verdict: text(review, "verdict") ?? "unknown",
			headSha: text(review, "head_sha") ?? "",
			findingCount: findingRows.length,
			findings: findingRows.map(
				(finding) =>
					redactSecrets(
						`[${text(finding, "severity") ?? "P?"}] ${text(finding, "claim") ?? ""} -> ${text(finding, "required_action") ?? ""}`,
					).text,
			),
		});
		if (reader.hasTable("verifications")) {
			const verificationRows = database
				.prepare("SELECT * FROM verifications WHERE producing_review_id = ? ORDER BY created_at DESC LIMIT 50")
				.all(reviewId) as unknown as Row[];
			for (const verification of verificationRows) {
				const verificationId = text(verification, "id");
				if (!verificationId) continue;
				const command = text(verification, "command");
				sourceRefs.add(`verification:${verificationId}`);
				verifications.push({
					id: verificationId,
					findingId: text(verification, "finding_id") ?? "",
					status: text(verification, "status") ?? "unknown",
					headSha: text(verification, "head_sha") ?? "",
					command: command ? redactSecrets(command).text : null,
					exitCode: number(verification, "exit_code"),
				});
			}
		}
	}
	const mergeRows =
		taskId && reader.hasTable("merges")
			? (database
					.prepare("SELECT * FROM merges WHERE task_id = ? ORDER BY created_at DESC LIMIT 20")
					.all(taskId) as unknown as Row[])
			: [];
	const merges: SessionDigestMerge[] = [];
	for (const merge of mergeRows) {
		const mergeId = text(merge, "id");
		if (!mergeId) continue;
		sourceRefs.add(`merge:${mergeId}`);
		merges.push({
			id: mergeId,
			baseSha: text(merge, "base_sha") ?? "",
			headSha: text(merge, "head_sha") ?? "",
			mergeSha: text(merge, "merge_sha") ?? "",
			status: text(merge, "status") ?? "unknown",
			receiptRef: text(merge, "receipt_ref") ?? "",
		});
	}
	return {
		found: true,
		digest: {
			...digest,
			eventCounts,
			events,
			reviews,
			verifications,
			merges,
			sourceRefs: [...sourceRefs].sort(),
		},
	};
}
