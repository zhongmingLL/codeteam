import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { resolveInstallation } from "../installation.ts";
import type { EvidenceSourceRef } from "./contract.ts";
import { type MemoryDatabase, resolveMemoryMaxFileBytes } from "./database.ts";
import { MemoryError } from "./errors.ts";
import { sha256Hex } from "./hash.ts";
import { MemoryIndexLock, memoryLockPath } from "./lock.ts";
import { redactSecrets, scanSecrets } from "./redaction.ts";
import { type ControlEvidenceDocument, ControlEvidenceReader } from "./sources/control.ts";
import {
	chunkPassages,
	type FileEvidenceDocument,
	listRepoEvidenceFiles,
	parseMarkdownDocument,
	readFileEvidence,
} from "./sources/file.ts";

export type IndexMode = "full" | "incremental";
export type IndexErrorKind = "path_denied" | "secret_redacted" | "max_file_bytes" | "parse_error";

export interface MemoryIndexOptions {
	readonly root: string;
	readonly dataDir?: string;
	readonly controlDbPath?: string;
	readonly workspaceId?: string;
	readonly collectionId?: string;
	readonly mode?: IndexMode;
	readonly maxFileBytes?: number;
	readonly denyPrefixes?: readonly string[];
	readonly secretMode?: "skip" | "redact";
	readonly now?: () => number;
}

export interface IndexErrorSummary {
	readonly sourcePath: string | null;
	readonly errorKind: IndexErrorKind;
	readonly detail: string;
}

export interface IndexRunSummary {
	readonly runId: string;
	readonly status: "fresh" | "degraded" | "failed";
	readonly mode: IndexMode;
	readonly startedAt: number;
	readonly endedAt: number;
	readonly sourceCount: number;
	readonly skippedCount: number;
	readonly errorCount: number;
	readonly errors: readonly IndexErrorSummary[];
	readonly counts: { readonly file: number; readonly control: number };
	readonly controlAvailable: boolean;
	readonly controlTables: readonly string[];
	readonly controlMissingTables: readonly string[];
}

interface EvidenceDocument {
	readonly source: EvidenceSourceRef;
	readonly kind: FileEvidenceDocument["kind"];
	readonly status: FileEvidenceDocument["status"];
	readonly title: string;
	readonly summary: string | null;
	readonly keywords: readonly string[];
	readonly content: string;
	readonly provenanceTier: FileEvidenceDocument["provenanceTier"];
	readonly drillDown: FileEvidenceDocument["drillDown"];
	readonly metadata: Record<string, unknown>;
}

interface ExistingEvidence {
	readonly source_hash: string;
}

function controlDbPath(options: MemoryIndexOptions): string | null {
	if (options.controlDbPath && options.controlDbPath.trim() !== "") return options.controlDbPath;
	const dataDir = options.dataDir ?? process.env.CODETEAM_DATA_DIR;
	return dataDir && dataDir.trim() !== "" ? join(dataDir, "control.db") : null;
}

function redactedDocument(document: ControlEvidenceDocument, content: string): ControlEvidenceDocument {
	return {
		...document,
		content,
	};
}

export class MemoryIndexer {
	private readonly memory: MemoryDatabase;
	private readonly options: MemoryIndexOptions;

	constructor(memory: MemoryDatabase, options: MemoryIndexOptions) {
		this.memory = memory;
		this.options = options;
	}

	run(): IndexRunSummary {
		const now = this.options.now ?? Date.now;
		const mode = this.options.mode ?? "incremental";
		const root = this.options.root;
		if (!existsSync(root) || !statSync(root).isDirectory()) {
			throw new MemoryError("invalid_input", `memory index root is not a directory: ${root}`);
		}
		const installation = resolveInstallation(root);
		const workspaceId = this.options.workspaceId ?? process.env.CODETEAM_WORKSPACE_ID ?? installation.installationId;
		const collectionId = this.options.collectionId ?? `project:${workspaceId}`;
		const maxFileBytes = resolveMemoryMaxFileBytes(this.options.maxFileBytes);
		const startedAt = now();
		const runId = `memrun:${startedAt}:${randomUUID()}`;
		const lock = MemoryIndexLock.acquire(memoryLockPath(this.memory.path), now);
		let controlReader: ControlEvidenceReader | null = null;
		const errors: IndexErrorSummary[] = [];
		const errorCounts: Record<string, number> = {};
		let sourceCount = 0;
		let skippedCount = 0;

		const recordError = (sourcePath: string | null, errorKind: IndexErrorKind, detail: string): void => {
			this.memory.database
				.prepare(
					"INSERT INTO index_errors (id, run_id, source_path, error_kind, detail, at) VALUES (?, ?, ?, ?, ?, ?)",
				)
				.run(randomUUID(), runId, sourcePath, errorKind, detail, now());
			errors.push({ sourcePath, errorKind, detail });
			errorCounts[errorKind] = (errorCounts[errorKind] ?? 0) + 1;
		};

		try {
			this.memory.verifyIsolation();
			this.memory.database
				.prepare("UPDATE index_runs SET status = 'interrupted', ended_at = ? WHERE status = 'indexing'")
				.run(startedAt);
			this.memory.database
				.prepare(
					`INSERT INTO collections (id, workspace_id, kind, display_name, root, sensitivity, status)
					 VALUES (?, ?, 'project', ?, ?, 'internal', 'active')
					 ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id,
						display_name = excluded.display_name, root = excluded.root, status = 'active'`,
				)
				.run(collectionId, workspaceId, basename(root) || "codeteam", root);

			const configuredControlPath = controlDbPath(this.options);
			controlReader = configuredControlPath ? ControlEvidenceReader.open({ path: configuredControlPath }) : null;
			const controlAvailable = controlReader?.available() ?? false;
			const sourceKind = controlAvailable ? "mixed" : "file";
			this.memory.database
				.prepare(
					`INSERT INTO index_runs (id, workspace_id, source_kind, mode, started_at, status, worker_pid, source_count, skipped_count, error_count, error_summary_json)
					 VALUES (?, ?, ?, ?, ?, 'indexing', ?, 0, 0, 0, '{}')`,
				)
				.run(runId, workspaceId, sourceKind, mode, startedAt, process.pid);

			const upsert = (document: EvidenceDocument, passages: readonly string[]): boolean => {
				const existing = this.memory.database
					.prepare(
						"SELECT source_hash FROM evidence_items WHERE workspace_id = ? AND source_kind = ? AND source_ref = ?",
					)
					.get(workspaceId, document.source.kind, document.source.ref) as ExistingEvidence | undefined;
				if (mode === "incremental" && existing?.source_hash === document.source.sha256) return false;
				const anchor = document.source.ref;
				this.memory.database.exec("BEGIN IMMEDIATE");
				try {
					this.memory.database.prepare("DELETE FROM evidence_items WHERE anchor = ?").run(anchor);
					this.memory.database
						.prepare(
							`INSERT INTO evidence_items (
								anchor, workspace_id, collection_id, kind, status, title, summary, keywords, content,
								source_kind, source_ref, source_path, source_hash, source_updated_at,
								provenance_tier, provenance_source, drill_down_json, metadata_json, updated_at
							) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						)
						.run(
							anchor,
							workspaceId,
							collectionId,
							document.kind,
							document.status,
							document.title,
							document.summary,
							document.keywords.join(" "),
							document.content,
							document.source.kind,
							document.source.ref,
							document.source.kind === "file" ? document.source.path : null,
							document.source.sha256,
							document.source.updatedAt,
							document.provenanceTier,
							document.source.kind === "file" ? "file" : document.source.table,
							JSON.stringify(document.drillDown),
							JSON.stringify(document.metadata),
							now(),
						);
					for (const [ordinal, content] of passages.entries()) {
						this.memory.database
							.prepare(
								"INSERT INTO evidence_passages (passage_id, anchor, ordinal, content, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
							)
							.run(`${anchor}:${ordinal}`, anchor, ordinal, content, sha256Hex(content), now());
					}
					this.memory.database.exec("COMMIT");
					return true;
				} catch (error) {
					try {
						this.memory.database.exec("ROLLBACK");
					} catch {
						// Preserve the original write failure.
					}
					throw error;
				}
			};

			const seenFile = new Set<string>();
			for (const relativePath of listRepoEvidenceFiles(root)) {
				const read = readFileEvidence({
					root,
					relativePath,
					maxFileBytes,
					denyPrefixes: this.options.denyPrefixes,
				});
				if (!read.ok) {
					recordError(relativePath, read.errorKind, read.detail);
					continue;
				}
				let raw = read.file.raw;
				const findings = scanSecrets(raw);
				if (findings.length > 0) {
					const patterns = [...new Set(findings.map((finding) => finding.pattern))].join(",");
					if ((this.options.secretMode ?? "skip") === "skip") {
						recordError(relativePath, "secret_redacted", `skipped:${patterns}`);
						continue;
					}
					raw = redactSecrets(raw).text;
					recordError(relativePath, "secret_redacted", `redacted:${patterns}`);
				}
				const document = parseMarkdownDocument(read.file.relativePath, raw, read.file.sha256, read.file.updatedAt);
				const passages = chunkPassages(document.content);
				sourceCount += 1;
				if (!upsert(document, passages)) skippedCount += 1;
				seenFile.add(document.source.ref);
			}

			const seenControl = new Set<string>();
			let controlTables: readonly string[] = [];
			let controlMissingTables: readonly string[] = [];
			if (controlReader && controlAvailable) {
				const scanned = controlReader.scan({ maxFileBytes });
				controlTables = scanned.tables;
				controlMissingTables = scanned.missingTables;
				for (const issue of scanned.issues) {
					recordError(issue.sourceRef, issue.errorKind, issue.detail);
				}
				for (const table of scanned.missingTables) {
					recordError(null, "parse_error", `control_table_missing:${table}`);
				}
				for (const scannedDocument of scanned.documents) {
					let document: ControlEvidenceDocument = scannedDocument;
					const findings = scanSecrets(document.content);
					if (findings.length > 0) {
						const patterns = [...new Set(findings.map((finding) => finding.pattern))].join(",");
						if ((this.options.secretMode ?? "skip") === "skip") {
							recordError(document.source.ref, "secret_redacted", `skipped:${patterns}`);
							continue;
						}
						document = redactedDocument(document, redactSecrets(document.content).text);
						recordError(document.source.ref, "secret_redacted", `redacted:${patterns}`);
					}
					const passages = chunkPassages(document.content);
					sourceCount += 1;
					if (!upsert(document, passages)) skippedCount += 1;
					seenControl.add(document.source.ref);
				}
			}

			if (mode === "full") {
				this.prune(collectionId, "file", seenFile);
				if (controlAvailable) this.prune(collectionId, "control", seenControl);
			}

			const counts = {
				file: this.countEvidence(collectionId, "file"),
				control: this.countEvidence(collectionId, "control"),
			};
			const endedAt = now();
			const status = errors.length > 0 ? "degraded" : "fresh";
			const errorSummary = JSON.stringify({
				byKind: errorCounts,
				controlAvailable,
				controlTables,
				controlMissingTables,
				mode,
			});
			this.memory.database
				.prepare(
					"UPDATE index_runs SET ended_at = ?, status = ?, source_count = ?, skipped_count = ?, error_count = ?, error_summary_json = ? WHERE id = ?",
				)
				.run(endedAt, status, sourceCount, skippedCount, errors.length, errorSummary, runId);
			return {
				runId,
				status,
				mode,
				startedAt,
				endedAt,
				sourceCount,
				skippedCount,
				errorCount: errors.length,
				errors,
				counts,
				controlAvailable,
				controlTables,
				controlMissingTables,
			};
		} catch (error) {
			const endedAt = now();
			try {
				this.memory.database
					.prepare(
						"UPDATE index_runs SET ended_at = ?, status = 'failed', error_count = ?, error_summary_json = ? WHERE id = ?",
					)
					.run(
						endedAt,
						Math.max(1, errors.length),
						JSON.stringify({ byKind: errorCounts, fatal: String(error) }),
						runId,
					);
			} catch {
				// Preserve the original failure.
			}
			if (error instanceof MemoryError) throw error;
			throw new MemoryError("index_failed", `memory index failed: ${String(error)}`, { cause: error });
		} finally {
			controlReader?.close();
			lock.release();
		}
	}

	private prune(collectionId: string, sourceKind: "file" | "control", seen: ReadonlySet<string>): void {
		const rows = this.memory.database
			.prepare("SELECT anchor FROM evidence_items WHERE collection_id = ? AND source_kind = ?")
			.all(collectionId, sourceKind) as unknown as { anchor: string }[];
		const stale = rows.filter((row) => !seen.has(row.anchor));
		if (stale.length === 0) return;
		this.memory.database.exec("BEGIN IMMEDIATE");
		try {
			const remove = this.memory.database.prepare("DELETE FROM evidence_items WHERE anchor = ?");
			for (const row of stale) remove.run(row.anchor);
			this.memory.database.exec("COMMIT");
		} catch (error) {
			try {
				this.memory.database.exec("ROLLBACK");
			} catch {
				// Preserve the original delete failure.
			}
			throw error;
		}
	}

	private countEvidence(collectionId: string, sourceKind: "file" | "control"): number {
		const row = this.memory.database
			.prepare("SELECT COUNT(*) AS count FROM evidence_items WHERE collection_id = ? AND source_kind = ?")
			.get(collectionId, sourceKind) as { count?: number } | undefined;
		return Number(row?.count ?? 0);
	}
}
