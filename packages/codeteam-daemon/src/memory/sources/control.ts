import { existsSync, readFileSync, type Stats, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
	ControlEvidenceSourceRef,
	ControlTable,
	EvidenceDrillDown,
	EvidenceKind,
	EvidenceStatus,
	ProvenanceTier,
} from "../contract.ts";
import { sha256Hex } from "../hash.ts";
import { evaluateMemoryPath } from "../redaction.ts";

export interface ControlEvidenceDocument {
	readonly source: ControlEvidenceSourceRef;
	readonly kind: EvidenceKind;
	readonly status: EvidenceStatus;
	readonly title: string;
	readonly summary: string | null;
	readonly keywords: readonly string[];
	readonly content: string;
	readonly provenanceTier: ProvenanceTier;
	readonly drillDown: EvidenceDrillDown;
	readonly metadata: Record<string, unknown>;
	readonly contentPath?: string;
}

export interface ControlScanIssue {
	readonly sourceRef: string | null;
	readonly errorKind: "path_denied" | "max_file_bytes" | "parse_error";
	readonly detail: string;
}

export interface ControlScanResult {
	readonly available: boolean;
	readonly documents: readonly ControlEvidenceDocument[];
	readonly issues: readonly ControlScanIssue[];
	readonly tables: readonly string[];
	readonly missingTables: readonly string[];
}

const CONTROL_TABLES = new Set<ControlTable>(["tasks", "artifacts", "reviews", "verifications", "merges"]);

type Row = Record<string, unknown>;

function text(row: Row, key: string): string | null {
	const value = row[key];
	return typeof value === "string" ? value : null;
}

function number(row: Row, key: string): number | null {
	const value = row[key];
	return typeof value === "number" ? value : null;
}

function statusForTask(status: string | null): EvidenceStatus {
	if (status === "done") return "done";
	if (status === "blocked") return "review";
	return "active";
}

function statusForReview(verdict: string | null): EvidenceStatus {
	if (verdict === "approve") return "done";
	if (verdict === "changes_requested" || verdict === "blocked") return "review";
	return "active";
}

function statusForVerification(status: string | null): EvidenceStatus {
	if (status === "confirmed") return "done";
	if (status === "rejected") return "invalidated";
	if (status === "blocked") return "review";
	return "active";
}

function statusForMerge(status: string | null): EvidenceStatus {
	if (status === "succeeded") return "done";
	if (status === "failed") return "invalidated";
	return "review";
}

function tableExists(database: DatabaseSync, table: string): boolean {
	const row = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
		| { name?: string }
		| undefined;
	return row?.name === table;
}

function controlSource(table: ControlTable, id: string, content: string, updatedAt: number): ControlEvidenceSourceRef {
	const prefix = table === "tasks" ? "task" : table.slice(0, -1);
	return {
		kind: "control",
		ref: `${prefix}:${id}` as ControlEvidenceSourceRef["ref"],
		table,
		id,
		sha256: sha256Hex(content),
		updatedAt,
	};
}

function doc(
	table: ControlTable,
	id: string,
	kind: EvidenceKind,
	status: EvidenceStatus,
	title: string,
	summary: string | null,
	keywords: readonly string[],
	content: string,
	provenanceTier: ProvenanceTier,
	updatedAt: number,
	metadata: Record<string, unknown>,
	contentPath?: string,
): ControlEvidenceDocument {
	const source = controlSource(table, id, content, updatedAt);
	return {
		source,
		kind,
		status,
		title,
		summary,
		keywords,
		content,
		provenanceTier,
		drillDown: { kind: "control", sourceRef: source.ref, table, id },
		metadata,
		contentPath,
	};
}

function readArtifactContent(
	path: string | null,
	artifactRoot: string,
	maxFileBytes: number,
): { content: string | null; issue: ControlScanIssue | null; contentPath?: string } {
	if (!path) return { content: null, issue: null };
	const decision = evaluateMemoryPath(path, { root: artifactRoot });
	if (!decision.allowed) {
		return {
			content: null,
			issue: { sourceRef: null, errorKind: "path_denied", detail: `${decision.reason}:${decision.detail}` },
		};
	}
	let stats: Stats;
	try {
		stats = statSync(decision.absolutePath);
	} catch {
		return { content: null, issue: null };
	}
	if (!stats.isFile()) return { content: null, issue: null };
	if (stats.size > maxFileBytes) {
		return {
			content: null,
			issue: {
				sourceRef: null,
				errorKind: "max_file_bytes",
				detail: `size=${stats.size};max=${maxFileBytes}`,
			},
		};
	}
	let buffer: Buffer;
	try {
		buffer = readFileSync(decision.absolutePath);
	} catch {
		return { content: null, issue: null };
	}
	if (buffer.subarray(0, 8192).includes(0)) return { content: null, issue: null, contentPath: path };
	return { content: buffer.toString("utf8"), issue: null, contentPath: path };
}

export interface OpenControlEvidenceReaderOptions {
	readonly path: string;
	readonly artifactRoot?: string;
	readonly timeoutMs?: number;
}

export class ControlEvidenceReader {
	readonly database: DatabaseSync;
	readonly path: string;
	readonly artifactRoot: string;

	private constructor(database: DatabaseSync, path: string, artifactRoot: string) {
		this.database = database;
		this.path = path;
		this.artifactRoot = artifactRoot;
	}

	static open(options: OpenControlEvidenceReaderOptions): ControlEvidenceReader | null {
		if (!existsSync(options.path)) return null;
		const database = new DatabaseSync(options.path, { readOnly: true, timeout: options.timeoutMs ?? 5000 });
		database.exec("PRAGMA busy_timeout = 5000");
		const artifactRoot = options.artifactRoot ?? join(dirname(options.path), "artifacts");
		return new ControlEvidenceReader(database, options.path, artifactRoot);
	}

	close(): void {
		this.database.close();
	}

	available(): boolean {
		return this.hasTable("tasks") || this.hasTable("artifacts") || this.hasTable("reviews");
	}

	hasTable(table: string): boolean {
		return tableExists(this.database, table);
	}

	private all(sql: string): Row[] {
		return this.database.prepare(sql).all() as unknown as Row[];
	}

	scan(options: { maxFileBytes: number }): ControlScanResult {
		const documents: ControlEvidenceDocument[] = [];
		const issues: ControlScanIssue[] = [];
		const tables: string[] = [];
		const missingTables: string[] = [];
		const required = ["tasks", "artifacts", "reviews", "findings", "verifications", "merges"] as const;
		for (const table of required) {
			if (this.hasTable(table)) tables.push(table);
			else missingTables.push(table);
		}

		const taskRows = this.hasTable("tasks") ? this.all("SELECT * FROM tasks ORDER BY updated_at DESC") : [];
		for (const row of taskRows) {
			const id = text(row, "id");
			if (!id) continue;
			const title = text(row, "title") ?? id;
			const why = text(row, "why") ?? "";
			const status = text(row, "status");
			const relatedFeature = text(row, "related_feature_id");
			const repo = text(row, "repo");
			const risk = text(row, "risk");
			const lane = text(row, "lane");
			const content = [
				`Task: ${title}`,
				`Why: ${why}`,
				`Status: ${status ?? "unknown"}`,
				`Feature: ${relatedFeature ?? "none"}`,
				`Repo: ${repo ?? "none"}`,
				`Risk: ${risk ?? "none"}`,
				`Lane: ${lane ?? "none"}`,
			].join("\n");
			documents.push(
				doc(
					"tasks",
					id,
					"task",
					statusForTask(status),
					title,
					[status, relatedFeature, repo, risk, lane]
						.filter((entry): entry is string => Boolean(entry))
						.join(" · "),
					[relatedFeature, repo, risk, lane, "task"].filter((entry): entry is string => Boolean(entry)),
					content,
					"authoritative",
					number(row, "updated_at") ?? number(row, "created_at") ?? 0,
					{ table: "tasks", id, threadId: text(row, "thread_id"), status },
				),
			);
		}

		const artifactRows = this.hasTable("artifacts")
			? this.all("SELECT * FROM artifacts ORDER BY created_at DESC")
			: [];
		for (const row of artifactRows) {
			const id = text(row, "id");
			if (!id) continue;
			const artifactKind = text(row, "kind") ?? "artifact";
			const mediaType = text(row, "media_type") ?? "application/octet-stream";
			const bytes = number(row, "bytes") ?? 0;
			const artifactPath = text(row, "path");
			const artifactSha = text(row, "sha256");
			const read = readArtifactContent(artifactPath, this.artifactRoot, options.maxFileBytes);
			if (read.issue) issues.push({ ...read.issue, sourceRef: `artifact:${id}` });
			const content = [
				`Artifact: ${id}`,
				`Task: ${text(row, "task_id") ?? "none"}`,
				`Kind: ${artifactKind}`,
				`Media: ${mediaType}`,
				`Bytes: ${bytes}`,
				`SHA256: ${artifactSha ?? "unknown"}`,
				read.content ? `\n${read.content}` : "",
			].join("\n");
			documents.push(
				doc(
					"artifacts",
					id,
					"artifact",
					"active",
					`Artifact ${artifactKind}: ${id}`,
					`task ${text(row, "task_id") ?? "unknown"} · ${mediaType} · ${bytes} bytes`,
					[artifactKind, mediaType, text(row, "task_id")].filter((entry): entry is string => Boolean(entry)),
					content,
					"derived",
					number(row, "created_at") ?? 0,
					{
						table: "artifacts",
						id,
						taskId: text(row, "task_id"),
						provenance: text(row, "provenance_json"),
						artifactSha256: artifactSha,
						contentIndexed: read.content !== null,
					},
					read.contentPath,
				),
			);
		}

		const findingRows = this.hasTable("findings")
			? this.all("SELECT * FROM findings ORDER BY review_id, finding_index")
			: [];
		const findingsByReview = new Map<string, Row[]>();
		for (const row of findingRows) {
			const reviewId = text(row, "review_id");
			if (!reviewId) continue;
			const list = findingsByReview.get(reviewId) ?? [];
			list.push(row);
			findingsByReview.set(reviewId, list);
		}

		const reviewRows = this.hasTable("reviews") ? this.all("SELECT * FROM reviews ORDER BY created_at DESC") : [];
		for (const row of reviewRows) {
			const id = text(row, "id");
			if (!id) continue;
			const verdict = text(row, "verdict");
			const headSha = text(row, "head_sha") ?? "";
			const findings = findingsByReview.get(id) ?? [];
			const findingLines = findings.map((finding) => {
				const severity = text(finding, "severity") ?? "P?";
				const claim = text(finding, "claim") ?? "";
				const file = text(finding, "file");
				const line = number(finding, "line");
				const required = text(finding, "required_action") ?? "";
				const location = file ? `${file}${line ? `:${line}` : ""}` : "no file";
				return `- [${severity}] ${claim} (${location}) -> ${required}`;
			});
			const content = [
				`Review: ${id}`,
				`Verdict: ${verdict ?? "unknown"}`,
				`Head: ${headSha}`,
				`Base: ${text(row, "base_sha") ?? "unknown"}`,
				`Mode: ${text(row, "review_mode") ?? "unknown"}`,
				`Reviewer: ${text(row, "reviewer_model") ?? "unknown"} (${text(row, "reviewer_model_family") ?? "unknown"})`,
				`Findings: ${findings.length}`,
				...findingLines,
			].join("\n");
			documents.push(
				doc(
					"reviews",
					id,
					"review",
					statusForReview(verdict),
					`Review ${verdict ?? "unknown"}: ${id}`,
					`${text(row, "reviewer_model") ?? "unknown"} @ ${headSha.slice(0, 12)} · ${findings.length} findings`,
					[
						verdict,
						text(row, "reviewer_model"),
						text(row, "reviewer_model_family"),
						text(row, "risk_class"),
					].filter((entry): entry is string => Boolean(entry)),
					content,
					"authoritative",
					number(row, "created_at") ?? 0,
					{ table: "reviews", id, taskId: text(row, "task_id"), verdict, headSha, findingCount: findings.length },
				),
			);
		}

		const reviewById = new Map(reviewRows.map((row) => [text(row, "id") ?? "", row]));
		const findingById = new Map(findingRows.map((row) => [text(row, "id") ?? "", row]));
		const verificationRows = this.hasTable("verifications")
			? this.all("SELECT * FROM verifications ORDER BY created_at DESC")
			: [];
		for (const row of verificationRows) {
			const id = text(row, "id");
			if (!id) continue;
			const status = text(row, "status");
			const finding = findingById.get(text(row, "finding_id") ?? "");
			const review = reviewById.get(text(row, "producing_review_id") ?? "");
			const command = text(row, "command");
			const exitCode = number(row, "exit_code");
			const content = [
				`Verification: ${id}`,
				`Status: ${status ?? "unknown"}`,
				`Head: ${text(row, "head_sha") ?? "unknown"}`,
				`Finding: ${text(row, "finding_id") ?? "unknown"}`,
				`Claim: ${finding ? text(finding, "claim") : "unknown"}`,
				`Command: ${command ?? "none"}`,
				`Cwd: ${text(row, "cwd") ?? "none"}`,
				`Exit: ${exitCode ?? "n/a"}`,
				`Reason: ${text(row, "reason") ?? ""}`,
				text(row, "stdout_tail") ? `Stdout: ${text(row, "stdout_tail")}` : "",
				text(row, "stderr_tail") ? `Stderr: ${text(row, "stderr_tail")}` : "",
			].join("\n");
			documents.push(
				doc(
					"verifications",
					id,
					"verification",
					statusForVerification(status),
					`Verification ${status ?? "unknown"}: ${id}`,
					`${command ?? "no command"} · exit ${exitCode ?? "n/a"}`,
					[status, command, finding ? text(finding, "severity") : null].filter((entry): entry is string =>
						Boolean(entry),
					),
					content,
					"authoritative",
					number(row, "created_at") ?? 0,
					{
						table: "verifications",
						id,
						taskId: review ? text(review, "task_id") : null,
						findingId: text(row, "finding_id"),
						status,
					},
				),
			);
		}

		const mergeRows = this.hasTable("merges") ? this.all("SELECT * FROM merges ORDER BY created_at DESC") : [];
		for (const row of mergeRows) {
			const id = text(row, "id");
			if (!id) continue;
			const status = text(row, "status") ?? "unknown";
			const baseSha = text(row, "base_sha") ?? "";
			const headSha = text(row, "head_sha") ?? "";
			const mergeSha = text(row, "merge_sha") ?? "";
			const content = [
				`Merge: ${id}`,
				`Status: ${status}`,
				`Base: ${baseSha}`,
				`Head: ${headSha}`,
				`Merge: ${mergeSha}`,
				`Policy: ${text(row, "policy") ?? "unknown"}`,
				`Receipt: ${text(row, "receipt_ref") ?? "unknown"}`,
				`Repo: ${text(row, "repo") ?? "none"}`,
				`PR: ${text(row, "pr_ref") ?? "none"}`,
				`Hard gate: ${number(row, "hard_gate") ?? "unknown"}`,
			].join("\n");
			documents.push(
				doc(
					"merges",
					id,
					"merge",
					statusForMerge(status),
					`Merge ${status}: ${id}`,
					`${baseSha.slice(0, 12)}..${headSha.slice(0, 12)} -> ${mergeSha.slice(0, 12)} · ${text(row, "policy") ?? "unknown"}`,
					[status, text(row, "repo"), text(row, "pr_ref"), text(row, "approved_by")].filter(
						(entry): entry is string => Boolean(entry),
					),
					content,
					"authoritative",
					number(row, "created_at") ?? 0,
					{ table: "merges", id, taskId: text(row, "task_id"), status, mergeSha },
				),
			);
		}

		return {
			available: true,
			documents,
			issues,
			tables,
			missingTables,
		};
	}

	isStale(source: ControlEvidenceSourceRef): { stale: boolean; reasons: string[] } {
		if (!CONTROL_TABLES.has(source.table)) return { stale: false, reasons: ["control_unavailable"] };
		if (!this.hasTable(source.table)) return { stale: false, reasons: ["control_unavailable"] };
		try {
			if (source.table === "artifacts") {
				const row = this.database.prepare("SELECT sha256, path FROM artifacts WHERE id = ?").get(source.id) as
					| { sha256?: string; path?: string }
					| undefined;
				if (!row) return { stale: true, reasons: ["source_missing"] };
				if (!row.path || !existsSync(row.path)) return { stale: true, reasons: ["source_missing"] };
				let actual: string;
				try {
					actual = sha256Hex(readFileSync(row.path));
				} catch {
					return { stale: true, reasons: ["source_missing"] };
				}
				if (row.sha256 && actual !== row.sha256) return { stale: true, reasons: ["source_changed"] };
				return { stale: false, reasons: [] };
			}
			const timestampColumn = source.table === "tasks" ? "updated_at" : "created_at";
			const row = this.database
				.prepare(`SELECT ${timestampColumn} AS timestamp FROM ${source.table} WHERE id = ?`)
				.get(source.id) as { timestamp?: number } | undefined;
			if (!row) return { stale: true, reasons: ["source_missing"] };
			if (typeof row.timestamp === "number" && row.timestamp > source.updatedAt) {
				return { stale: true, reasons: ["source_changed"] };
			}
			return { stale: false, reasons: [] };
		} catch {
			return { stale: false, reasons: ["control_unavailable"] };
		}
	}
}
