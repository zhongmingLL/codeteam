import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ControlEvidenceSourceRef,
	ControlTable,
	Coverage,
	EvidenceDrillDown,
	EvidenceHit,
	EvidenceItem,
	EvidenceKind,
	EvidencePassage,
	EvidenceSourceRef,
	EvidenceStatus,
	ProvenanceTier,
	ReadResult,
	RecallResult,
} from "./contract.ts";
import type { MemoryDatabase } from "./database.ts";
import { MemoryError } from "./errors.ts";
import { sha256Hex } from "./hash.ts";
import { decodeKeywords } from "./keywords.ts";
import { redactSecrets } from "./redaction.ts";
import type { ControlEvidenceReader } from "./sources/control.ts";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const CONTROL_TABLES = new Set<ControlTable>(["tasks", "artifacts", "reviews", "verifications", "merges"]);

export interface MemoryRecallOptions {
	readonly controlReader?: ControlEvidenceReader | null;
	readonly workspaceId?: string;
	readonly collectionId?: string;
	readonly now?: () => number;
	readonly staleAfterMs?: number;
}

export interface SearchOptions {
	readonly query: string;
	readonly kinds?: readonly EvidenceKind[];
	readonly limit?: number;
}

interface EvidenceRow {
	readonly anchor: string;
	readonly kind: EvidenceKind;
	readonly status: EvidenceStatus;
	readonly title: string;
	readonly summary: string | null;
	readonly keywords: string | null;
	readonly source_kind: "file" | "control";
	readonly source_ref: string;
	readonly source_path: string | null;
	readonly source_hash: string;
	readonly source_updated_at: number | null;
	readonly provenance_tier: ProvenanceTier | null;
	readonly drill_down_json: string | null;
	readonly updated_at: number;
	readonly score?: number;
	readonly match_kind?: "fts" | "lexical_fallback";
}

interface PassageRow {
	readonly passage_id: string;
	readonly anchor: string;
	readonly ordinal: number;
	readonly content: string;
	readonly content_hash: string;
	readonly created_at: number;
}

interface CollectionRow {
	readonly id: string;
	readonly workspace_id: string;
	readonly root: string;
}

interface RunRow {
	readonly id: string;
	readonly status: "indexing" | "fresh" | "degraded" | "interrupted" | "failed";
	readonly started_at: number;
	readonly ended_at: number | null;
	readonly error_summary_json: string;
}

function parseDrillDown(value: string | null, sourceKind: "file" | "control", sourceRef: string): EvidenceDrillDown {
	if (value) {
		try {
			const parsed = JSON.parse(value) as Partial<EvidenceDrillDown>;
			if (sourceKind === "file" && parsed.kind === "file" && typeof parsed.path === "string") {
				return {
					kind: "file",
					sourceRef: typeof parsed.sourceRef === "string" ? parsed.sourceRef : sourceRef,
					path: parsed.path,
				};
			}
			if (
				sourceKind === "control" &&
				parsed.kind === "control" &&
				typeof parsed.table === "string" &&
				CONTROL_TABLES.has(parsed.table as ControlTable) &&
				typeof parsed.id === "string"
			) {
				return {
					kind: "control",
					sourceRef: typeof parsed.sourceRef === "string" ? parsed.sourceRef : sourceRef,
					table: parsed.table as ControlTable,
					id: parsed.id,
				};
			}
		} catch {
			// Fall through to the source-derived drill-down.
		}
	}
	if (sourceKind === "file") throw new MemoryError("parse_error", `evidence ${sourceRef} has no file drill-down`);
	throw new MemoryError("parse_error", `evidence ${sourceRef} has no control drill-down`);
}

function mapSource(row: EvidenceRow): EvidenceSourceRef {
	if (row.source_kind === "file") {
		return {
			kind: "file",
			ref: row.source_ref as `file:${string}`,
			path: row.source_path ?? "",
			sha256: row.source_hash,
			updatedAt: row.source_updated_at ?? row.updated_at,
		};
	}
	const drillDown = parseDrillDown(row.drill_down_json, "control", row.source_ref);
	if (drillDown.kind !== "control") throw new MemoryError("parse_error", `evidence ${row.source_ref} is not control`);
	const source: ControlEvidenceSourceRef = {
		kind: "control",
		ref: row.source_ref as ControlEvidenceSourceRef["ref"],
		table: drillDown.table,
		id: drillDown.id,
		sha256: row.source_hash,
		updatedAt: row.source_updated_at ?? row.updated_at,
	};
	return source;
}

function mapItem(row: EvidenceRow): EvidenceItem {
	return {
		anchor: row.anchor,
		kind: row.kind,
		status: row.status,
		title: row.title,
		summary: row.summary,
		keywords: decodeKeywords(row.keywords),
		provenanceTier: row.provenance_tier ?? "derived",
		source: mapSource(row),
		drillDown: parseDrillDown(row.drill_down_json, row.source_kind, row.source_ref),
		updatedAt: row.updated_at,
	};
}

function mapPassage(row: PassageRow): EvidencePassage {
	return {
		passageId: row.passage_id,
		anchor: row.anchor,
		ordinal: row.ordinal,
		content: row.content,
		contentHash: row.content_hash,
		createdAt: row.created_at,
	};
}

function normalizeFtsQuery(query: string): string | null {
	const terms = query
		.trim()
		.split(/\s+/)
		.map((term) => term.replace(/["']/g, "").trim())
		.filter((term) => term.length >= 3);
	if (terms.length === 0) return null;
	return terms.map((term) => `"${term}"`).join(" OR ");
}

function likePattern(query: string): string {
	return `%${query.replace(/[\\%_]/g, "\\$&")}%`;
}

export class MemoryRecall {
	private readonly memory: MemoryDatabase;
	private readonly options: MemoryRecallOptions;

	constructor(memory: MemoryDatabase, options: MemoryRecallOptions = {}) {
		this.memory = memory;
		this.options = options;
	}

	coverage(): Coverage {
		const collection = this.collection();
		if (!collection) {
			return {
				workspaceId: this.options.workspaceId ?? "",
				collectionId: this.options.collectionId ?? "",
				scope: "indexed_scope_only",
				indexRunId: null,
				indexedAt: null,
				indexStatus: "never_run",
				stale: true,
				degraded: true,
				reasons: ["index_never_run"],
				counts: { evidence: 0, file: 0, control: 0 },
			};
		}
		const latest = this.memory.database
			.prepare(
				"SELECT id, status, started_at, ended_at, error_summary_json FROM index_runs WHERE workspace_id = ? ORDER BY started_at DESC LIMIT 1",
			)
			.get(collection.workspace_id) as RunRow | undefined;
		const counts = this.counts(collection.id);
		const reasons: string[] = [];
		let degraded = false;
		let stale = false;
		const now = this.options.now?.() ?? Date.now();
		const staleAfterMs = this.options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
		if (!latest) {
			reasons.push("index_never_run");
			degraded = true;
			stale = true;
		} else {
			if (latest.status === "indexing") {
				reasons.push("index_in_progress");
				stale = true;
			}
			if (latest.status === "failed") {
				reasons.push("index_failed");
				degraded = true;
			}
			if (latest.status === "interrupted") {
				reasons.push("index_interrupted");
				degraded = true;
			}
			if (latest.status === "degraded") {
				reasons.push("index_degraded");
				degraded = true;
			}
			if ((latest.ended_at ?? latest.started_at) + staleAfterMs < now) {
				reasons.push("index_stale");
				stale = true;
			}
			try {
				const summary = JSON.parse(latest.error_summary_json) as { controlAvailable?: boolean };
				if (summary.controlAvailable === false) {
					reasons.push("control_db_absent");
					degraded = true;
				}
			} catch {
				// A malformed summary is itself a degradation.
				reasons.push("index_summary_invalid");
				degraded = true;
			}
		}
		if (!this.options.controlReader && counts.control > 0 && !reasons.includes("control_db_absent")) {
			reasons.push("control_db_absent");
			degraded = true;
		}
		const indexedAt = latest ? (latest.ended_at ?? latest.started_at) : null;
		return {
			workspaceId: collection.workspace_id,
			collectionId: collection.id,
			scope: "indexed_scope_only",
			indexRunId: latest?.id ?? null,
			indexedAt,
			indexStatus: latest?.status ?? "never_run",
			stale,
			degraded,
			reasons: [...new Set(reasons)],
			counts,
		};
	}

	private collection(): CollectionRow | null {
		const collectionId = this.options.collectionId;
		const workspaceId = this.options.workspaceId;
		if (collectionId) {
			const row = this.memory.database
				.prepare("SELECT id, workspace_id, root FROM collections WHERE id = ?")
				.get(collectionId) as CollectionRow | undefined;
			return row ?? null;
		}
		if (workspaceId) {
			const row = this.memory.database
				.prepare("SELECT id, workspace_id, root FROM collections WHERE workspace_id = ? ORDER BY rowid LIMIT 1")
				.get(workspaceId) as CollectionRow | undefined;
			return row ?? null;
		}
		const row = this.memory.database
			.prepare("SELECT id, workspace_id, root FROM collections ORDER BY rowid LIMIT 1")
			.get() as CollectionRow | undefined;
		return row ?? null;
	}

	private counts(collectionId: string): { evidence: number; file: number; control: number } {
		const row = this.memory.database
			.prepare(
				`SELECT COUNT(*) AS evidence,
					COALESCE(SUM(CASE WHEN source_kind = 'file' THEN 1 ELSE 0 END), 0) AS file,
					COALESCE(SUM(CASE WHEN source_kind = 'control' THEN 1 ELSE 0 END), 0) AS control
				 FROM evidence_items WHERE collection_id = ?`,
			)
			.get(collectionId) as { evidence?: number; file?: number; control?: number } | undefined;
		return {
			evidence: Number(row?.evidence ?? 0),
			file: Number(row?.file ?? 0),
			control: Number(row?.control ?? 0),
		};
	}

	search(options: SearchOptions): RecallResult {
		const coverage = this.coverage();
		const collection = this.collection();
		const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
		const query = options.query.trim();
		if (!query || !collection) return { query, items: [], coverage };
		const kinds = options.kinds ? [...new Set(options.kinds)] : [];
		const ftsQuery = normalizeFtsQuery(query);
		const like = likePattern(query);
		const hits: EvidenceHit[] = [];
		const seen = new Set<string>();
		const kindClause = kinds.length > 0 ? ` AND e.kind IN (${kinds.map(() => "?").join(",")})` : "";

		if (ftsQuery) {
			try {
				const rows = this.memory.database
					.prepare(
						`SELECT e.anchor, e.kind, e.status, e.title, e.summary, e.keywords, e.source_kind, e.source_ref,
							e.source_path, e.source_hash, e.source_updated_at, e.provenance_tier, e.drill_down_json,
							e.updated_at, -bm25(evidence_fts) AS score
						 FROM evidence_fts JOIN evidence_items e ON e.rowid = evidence_fts.rowid
						 WHERE evidence_fts MATCH ? AND e.collection_id = ?${kindClause}
						 ORDER BY bm25(evidence_fts) LIMIT ?`,
					)
					.all(ftsQuery, collection.id, ...kinds, limit) as unknown as EvidenceRow[];
				for (const row of rows) {
					if (seen.has(row.anchor)) continue;
					seen.add(row.anchor);
					hits.push(this.hitFromRow(row, "fts", collection.root, ftsQuery, like));
				}
			} catch {
				// Malformed FTS queries fall through to the lexical path.
			}
		}

		if (hits.length < limit) {
			const fallbackLimit = limit - hits.length;
			const rows = this.memory.database
				.prepare(
					`SELECT anchor, kind, status, title, summary, keywords, source_kind, source_ref, source_path,
						source_hash, source_updated_at, provenance_tier, drill_down_json, updated_at, 0.5 AS score
					 FROM evidence_items e
					 WHERE e.collection_id = ? AND (e.title LIKE ? ESCAPE '\\' OR e.summary LIKE ? ESCAPE '\\' OR e.content LIKE ? ESCAPE '\\')${kindClause}
					 ORDER BY e.updated_at DESC LIMIT ?`,
				)
				.all(collection.id, like, like, like, ...kinds, fallbackLimit) as unknown as EvidenceRow[];
			for (const row of rows) {
				if (seen.has(row.anchor)) continue;
				seen.add(row.anchor);
				hits.push(this.hitFromRow(row, "lexical_fallback", collection.root, ftsQuery, like));
			}
		}

		return {
			query,
			items: hits.slice(0, limit),
			coverage,
		};
	}

	private hitFromRow(
		row: EvidenceRow,
		match: "fts" | "lexical_fallback",
		root: string,
		ftsQuery: string | null,
		like: string,
	): EvidenceHit {
		const passage = this.pickPassage(row.anchor, ftsQuery, like);
		const freshness = this.freshness(mapSource(row), root);
		const redactedPassage = redactSecrets(passage);
		const redactedSummary = row.summary ? redactSecrets(row.summary).text : null;
		return {
			anchor: row.anchor,
			kind: row.kind,
			status: row.status,
			title: redactSecrets(row.title).text,
			summary: redactedSummary,
			passage: redactedPassage.text,
			score: row.score ?? 0,
			match,
			source: mapSource(row),
			drillDown: parseDrillDown(row.drill_down_json, row.source_kind, row.source_ref),
			stale: freshness.stale,
			staleReasons: freshness.reasons,
		};
	}

	private pickPassage(anchor: string, ftsQuery: string | null, like: string): string {
		if (ftsQuery) {
			try {
				const row = this.memory.database
					.prepare(
						`SELECT p.content FROM evidence_passage_fts f JOIN evidence_passages p ON p.rowid = f.rowid
						 WHERE evidence_passage_fts MATCH ? AND p.anchor = ? ORDER BY bm25(evidence_passage_fts) LIMIT 1`,
					)
					.get(ftsQuery, anchor) as { content?: string } | undefined;
				if (row?.content) return row.content;
			} catch {
				// Fall through to lexical passage lookup.
			}
		}
		const lexical = this.memory.database
			.prepare(
				"SELECT content FROM evidence_passages WHERE anchor = ? AND content LIKE ? ESCAPE '\\' ORDER BY ordinal LIMIT 1",
			)
			.get(anchor, like) as { content?: string } | undefined;
		if (lexical?.content) return lexical.content;
		const first = this.memory.database
			.prepare("SELECT content FROM evidence_passages WHERE anchor = ? ORDER BY ordinal LIMIT 1")
			.get(anchor) as { content?: string } | undefined;
		return first?.content ?? "";
	}

	private freshness(source: EvidenceSourceRef, root: string): { stale: boolean; reasons: string[] } {
		if (source.kind === "file") {
			if (!source.path) return { stale: false, reasons: [] };
			const absolute = join(root, source.path);
			if (!existsSync(absolute)) return { stale: true, reasons: ["source_missing"] };
			try {
				const actual = sha256Hex(readFileSync(absolute));
				if (actual !== source.sha256) return { stale: true, reasons: ["source_changed"] };
				return { stale: false, reasons: [] };
			} catch {
				return { stale: true, reasons: ["source_missing"] };
			}
		}
		const reader = this.options.controlReader;
		if (!reader) return { stale: false, reasons: ["control_unavailable"] };
		const result = reader.isStale(source);
		return {
			stale: result.reasons.includes("source_missing") || result.reasons.includes("source_changed"),
			reasons: result.reasons,
		};
	}

	read(anchor: string): ReadResult {
		const coverage = this.coverage();
		const row = this.memory.database
			.prepare(
				`SELECT anchor, kind, status, title, summary, keywords, source_kind, source_ref, source_path,
					source_hash, source_updated_at, provenance_tier, drill_down_json, updated_at
				 FROM evidence_items WHERE anchor = ?`,
			)
			.get(anchor) as EvidenceRow | undefined;
		if (!row) return { found: false, anchor, coverage, reason: "not_indexed" };
		const item = mapItem(row);
		const passages = (
			this.memory.database
				.prepare(
					"SELECT passage_id, anchor, ordinal, content, content_hash, created_at FROM evidence_passages WHERE anchor = ? ORDER BY ordinal",
				)
				.all(anchor) as unknown as PassageRow[]
		).map(mapPassage);
		const collection = this.collection();
		const root = collection?.root ?? "";
		const contentRow = this.memory.database
			.prepare("SELECT content FROM evidence_items WHERE anchor = ?")
			.get(anchor) as { content?: string | null } | undefined;
		const contentRedaction = redactSecrets(contentRow?.content ?? "");
		const redactedPassages: EvidencePassage[] = [];
		const findingNames = new Set(contentRedaction.findings.map((finding) => finding.pattern));
		for (const passage of passages) {
			const redacted = redactSecrets(passage.content);
			for (const finding of redacted.findings) findingNames.add(finding.pattern);
			redactedPassages.push({ ...passage, content: redacted.text });
		}
		const freshness = this.freshness(item.source, root);
		return {
			found: true,
			item,
			content: contentRedaction.text,
			passages: redactedPassages,
			coverage,
			redacted: findingNames.size > 0,
			redactionFindings: [...findingNames],
			stale: freshness.stale,
			staleReasons: freshness.reasons,
		};
	}
}
