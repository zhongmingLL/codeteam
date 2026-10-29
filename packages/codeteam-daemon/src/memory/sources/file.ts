import { type Dirent, existsSync, readdirSync, readFileSync, type Stats, statSync } from "node:fs";
import { basename, join } from "node:path";
import type {
	EvidenceDrillDown,
	EvidenceKind,
	EvidenceSourceRef,
	EvidenceStatus,
	FileEvidenceSourceRef,
	ProvenanceTier,
} from "../contract.ts";
import { sha256Hex } from "../hash.ts";
import { evaluateMemoryPath, isAllowedEvidenceFile } from "../redaction.ts";

const ROOT_EVIDENCE_FILES = ["AGENTS.md", "CODETEAM.md", "README.md", "UPSTREAM.md", "KERNEL_GAPS.md"];
const SKIPPED_DIRS = new Set([
	"node_modules",
	"dist",
	"build",
	"target",
	".git",
	".worktrees",
	".cat-cafe",
	".codex",
	"coverage",
	".nyc_output",
	"vendor",
]);

export interface FileEvidenceDocument {
	readonly source: FileEvidenceSourceRef;
	readonly kind: EvidenceKind;
	readonly status: EvidenceStatus;
	readonly title: string;
	readonly summary: string | null;
	readonly keywords: readonly string[];
	readonly content: string;
	readonly provenanceTier: ProvenanceTier;
	readonly drillDown: EvidenceDrillDown;
	readonly metadata: Record<string, unknown>;
}

export interface RawFileEvidence {
	readonly absolutePath: string;
	readonly relativePath: string;
	readonly raw: string;
	readonly sha256: string;
	readonly updatedAt: number;
}

export type ReadFileEvidenceResult =
	| { readonly ok: true; readonly file: RawFileEvidence }
	| {
			readonly ok: false;
			readonly errorKind: "path_denied" | "max_file_bytes" | "parse_error";
			readonly detail: string;
	  };

export interface ReadFileEvidenceOptions {
	readonly root: string;
	readonly relativePath: string;
	readonly maxFileBytes: number;
	readonly denyPrefixes?: readonly string[];
}

export function listRepoEvidenceFiles(root: string): string[] {
	const files = new Set<string>();
	const docsRoot = join(root, "docs");
	if (existsSync(docsRoot) && statSync(docsRoot).isDirectory()) {
		walk(docsRoot, "docs", files);
	}
	for (const name of ROOT_EVIDENCE_FILES) {
		const absolute = join(root, name);
		if (existsSync(absolute) && statSync(absolute).isFile()) files.add(name);
	}
	return [...files].sort();
}

function walk(absoluteDir: string, relativeDir: string, files: Set<string>): void {
	let entries: Dirent[];
	try {
		entries = readdirSync(absoluteDir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (entry.isSymbolicLink()) continue;
		const relative = `${relativeDir}/${entry.name}`;
		if (entry.isDirectory()) {
			if (SKIPPED_DIRS.has(entry.name)) continue;
			walk(join(absoluteDir, entry.name), relative, files);
			continue;
		}
		if (!entry.isFile()) continue;
		if (!isAllowedEvidenceFile(relative)) continue;
		files.add(relative);
	}
}

export function readFileEvidence(options: ReadFileEvidenceOptions): ReadFileEvidenceResult {
	const decision = evaluateMemoryPath(options.relativePath, {
		root: options.root,
		denyPrefixes: options.denyPrefixes,
	});
	if (!decision.allowed) {
		return { ok: false, errorKind: "path_denied", detail: `${decision.reason}:${decision.detail}` };
	}
	let stats: Stats;
	try {
		stats = statSync(decision.absolutePath);
	} catch (error) {
		return { ok: false, errorKind: "parse_error", detail: `stat_failed:${String(error)}` };
	}
	if (!stats.isFile()) {
		return { ok: false, errorKind: "parse_error", detail: "not_a_file" };
	}
	if (stats.size > options.maxFileBytes) {
		return {
			ok: false,
			errorKind: "max_file_bytes",
			detail: `size=${stats.size};max=${options.maxFileBytes}`,
		};
	}
	let buffer: Buffer;
	try {
		buffer = readFileSync(decision.absolutePath);
	} catch (error) {
		return { ok: false, errorKind: "parse_error", detail: `read_failed:${String(error)}` };
	}
	if (buffer.subarray(0, 8192).includes(0)) {
		return { ok: false, errorKind: "parse_error", detail: "binary_content" };
	}
	return {
		ok: true,
		file: {
			absolutePath: decision.absolutePath,
			relativePath: decision.relativePath,
			raw: buffer.toString("utf8"),
			sha256: sha256Hex(buffer),
			updatedAt: Math.floor(stats.mtimeMs),
		},
	};
}

export function inferEvidenceKind(relativePath: string): EvidenceKind {
	const normalized = relativePath.replaceAll("\\", "/");
	if (normalized.startsWith("docs/features/")) return "feature";
	if (normalized.startsWith("docs/decisions/")) return "decision";
	if (normalized.startsWith("docs/plans/")) return "plan";
	if (normalized.startsWith("docs/lessons/")) return "lesson";
	if (normalized.startsWith("docs/architecture/")) return "architecture";
	if (normalized.startsWith("docs/research/")) return "research";
	if (normalized.startsWith("docs/discussions/")) return "discussion";
	if (normalized.startsWith("docs/reuse/")) return "architecture";
	if (normalized.startsWith("docs/reports/")) return "research";
	if (normalized.startsWith("docs/upstream/")) return "architecture";
	return "architecture";
}

export function mapDocumentStatus(status: string | undefined): EvidenceStatus {
	const normalized = (status ?? "").trim().toLowerCase();
	if (normalized === "done" || normalized === "closed" || normalized === "approved") return "done";
	if (normalized === "review" || normalized === "reviewed" || normalized === "in_review" || normalized === "draft") {
		return "review";
	}
	if (normalized === "archived") return "archived";
	if (normalized === "invalidated") return "invalidated";
	if (normalized === "superseded") return "superseded";
	if (normalized === "drifted") return "drifted";
	if (normalized === "stale") return "stale";
	if (normalized === "historical" || normalized === "frozen") return "historical";
	if (normalized === "retired" || normalized === "sunset") return "retired";
	return "active";
}

function provenanceForKind(kind: EvidenceKind): ProvenanceTier {
	if (kind === "decision" || kind === "architecture" || kind === "feature") return "authoritative";
	if (kind === "plan" || kind === "lesson") return "derived";
	return "soft_clue";
}

export interface ParsedMarkdown {
	readonly frontmatter: Record<string, string | string[]>;
	readonly body: string;
	readonly title: string;
	readonly summary: string | null;
	readonly keywords: readonly string[];
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, string | string[]>; body: string } {
	if (!raw.startsWith("---")) return { frontmatter: {}, body: raw };
	const lines = raw.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return { frontmatter: {}, body: raw };
	let end = -1;
	for (let index = 1; index < lines.length; index += 1) {
		if (lines[index]?.trim() === "---") {
			end = index;
			break;
		}
	}
	if (end < 0) return { frontmatter: {}, body: raw };
	const frontmatter: Record<string, string | string[]> = {};
	for (const line of lines.slice(1, end)) {
		const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (!match) continue;
		const key = match[1]!;
		const value = match[2]!.trim();
		if (value === "") continue;
		if (value.startsWith("[") && value.endsWith("]")) {
			frontmatter[key] = value
				.slice(1, -1)
				.split(",")
				.map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
				.filter((entry) => entry !== "");
		} else {
			frontmatter[key] = value.replace(/^["']|["']$/g, "");
		}
	}
	return {
		frontmatter,
		body: lines
			.slice(end + 1)
			.join("\n")
			.replace(/^\n+/, ""),
	};
}

function firstHeading(body: string): string | null {
	for (const line of body.split(/\r?\n/)) {
		const match = /^#\s+(.+?)\s*$/.exec(line);
		if (match) return match[1]!.replace(/^["']|["']$/g, "").trim();
	}
	return null;
}

function firstParagraph(body: string): string | null {
	const paragraphs = body.split(/\r?\n\s*\r?\n/);
	for (const paragraph of paragraphs) {
		const trimmed = paragraph.trim();
		if (trimmed === "") continue;
		if (trimmed.startsWith("#") || trimmed.startsWith("---") || trimmed.startsWith(">")) continue;
		const flattened = trimmed.replace(/\s+/g, " ");
		return flattened.length > 500 ? `${flattened.slice(0, 497)}...` : flattened;
	}
	return null;
}

function derivedKeywords(title: string, frontmatter: Record<string, string | string[]>): string[] {
	const keywords = new Set<string>();
	const add = (value: string): void => {
		const trimmed = value.trim();
		if (trimmed !== "") keywords.add(trimmed);
	};
	for (const key of ["tags", "keywords", "feature_ids", "featureIds", "related_features"]) {
		const value = frontmatter[key];
		if (Array.isArray(value)) {
			for (const entry of value) add(entry);
		} else if (typeof value === "string") {
			for (const entry of value.split(",")) add(entry);
		}
	}
	for (const token of title.match(/[A-Za-z0-9][A-Za-z0-9_-]*/g) ?? []) {
		if (token.length >= 2) add(token);
	}
	return [...keywords].slice(0, 24);
}

export function parseMarkdownDocument(
	relativePath: string,
	raw: string,
	sha256: string,
	updatedAt: number,
): FileEvidenceDocument {
	const { frontmatter, body } = parseFrontmatter(raw);
	const kind = inferEvidenceKind(relativePath);
	const title =
		(typeof frontmatter.title === "string" ? frontmatter.title : null) ??
		firstHeading(body) ??
		basename(relativePath).replace(/\.md$/i, "");
	const summary = typeof frontmatter.summary === "string" ? frontmatter.summary : firstParagraph(body);
	const status = mapDocumentStatus(typeof frontmatter.status === "string" ? frontmatter.status : undefined);
	const sourceRef = `file:${relativePath}` as const;
	const source: FileEvidenceSourceRef = {
		kind: "file",
		ref: sourceRef,
		path: relativePath,
		sha256,
		updatedAt,
	};
	return {
		source,
		kind,
		status,
		title,
		summary,
		keywords: derivedKeywords(title, frontmatter),
		content: body,
		provenanceTier: provenanceForKind(kind),
		drillDown: { kind: "file", sourceRef, path: relativePath },
		metadata: {
			frontmatter,
			headings: (body.match(/^#{1,6}\s+.+$/gm) ?? []).slice(0, 40),
		},
	};
}

export function chunkPassages(content: string, maxChars = 1200, overlap = 150): string[] {
	const normalized = content.replace(/\r\n/g, "\n").trim();
	if (normalized === "") return [""];
	const paragraphs = normalized.split(/\n\s*\n/).filter((paragraph) => paragraph.trim() !== "");
	const chunks: string[] = [];
	let current = "";
	const flush = (): void => {
		const trimmed = current.trim();
		if (trimmed !== "") chunks.push(trimmed);
		current = trimmed.length > overlap ? `...${trimmed.slice(-overlap)}` : "";
	};
	for (const paragraph of paragraphs) {
		if (paragraph.length > maxChars) {
			if (current.trim() !== "") flush();
			for (let offset = 0; offset < paragraph.length; offset += maxChars - overlap) {
				const slice = paragraph.slice(offset, offset + maxChars);
				if (slice.trim() !== "") chunks.push(slice.trim());
				if (offset + maxChars >= paragraph.length) break;
			}
			current = "";
			continue;
		}
		const candidate = current === "" ? paragraph : `${current}\n\n${paragraph}`;
		if (candidate.length > maxChars) {
			flush();
			current = paragraph;
		} else {
			current = candidate;
		}
	}
	if (current.trim() !== "") chunks.push(current.trim());
	return chunks.length > 0 ? chunks : [""];
}

export function fileSourceRef(relativePath: string, sha256: string, updatedAt: number): EvidenceSourceRef {
	return {
		kind: "file",
		ref: `file:${relativePath}`,
		path: relativePath,
		sha256,
		updatedAt,
	};
}
