import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { type CatalogDiagnostic, type CuratedSkillEntry, parseManifest, type SourceKind } from "./manifest.ts";

export interface CuratedSkill extends CuratedSkillEntry {
	name: string;
	description: string;
	triggers: string[];
	dirPath: string;
	filePath: string;
}

export interface ResolvedCatalog {
	catalogRoot: string;
	manifestPath: string;
	skills: CuratedSkill[];
	skillPaths: string[];
	diagnostics: CatalogDiagnostic[];
}

export interface LoadCuratedCatalogOptions {
	catalogRoot: string;
	manifestPath?: string;
}

interface Frontmatter {
	name: string;
	description: string;
	triggers: string[];
}

const MAX_SCANNED_FILES = 200;
const MAX_SCANNED_FILE_BYTES = 512 * 1024;
const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024;

const SECRET_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
	{ label: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
	{ label: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
	{ label: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
	{ label: "github-fine-grained-token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
	{ label: "openai-token", pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
	{ label: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
];

function isInside(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function normalizeFrontmatterSource(content: string): string {
	return content
		.replace(/^\uFEFF/, "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n");
}

function parseFrontmatter(content: string): Frontmatter | null {
	const normalized = normalizeFrontmatterSource(content);
	if (!normalized.startsWith("---\n")) return null;
	const end = normalized.indexOf("\n---", 4);
	if (end === -1) return null;

	let raw: unknown;
	try {
		raw = parse(normalized.slice(4, end));
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;

	const record = raw as Record<string, unknown>;
	const name = record.name;
	const description = record.description;
	const triggers = record.triggers ?? [];
	if (typeof name !== "string" || name.trim() === "") return null;
	if (typeof description !== "string" || description.trim() === "") return null;
	if (typeof triggers === "string") {
		return { name, description, triggers: [triggers] };
	}
	if (!Array.isArray(triggers) || !triggers.every((trigger) => typeof trigger === "string")) return null;

	return { name, description, triggers: triggers as string[] };
}

function looksBinary(buffer: Buffer): boolean {
	const sample = buffer.subarray(0, 1024);
	return sample.includes(0);
}

function findUnsafeSymlinks(skillDir: string): string[] {
	const unsafe: string[] = [];

	const walk = (dir: string, depth: number): void => {
		if (depth > 8) return;
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			let stat: import("node:fs").Stats;
			try {
				stat = lstatSync(fullPath);
			} catch {
				continue;
			}
			if (stat.isSymbolicLink()) {
				let target: string;
				try {
					target = realpathSync(fullPath);
				} catch {
					unsafe.push(relative(skillDir, fullPath));
					continue;
				}
				if (!isInside(skillDir, target)) unsafe.push(relative(skillDir, fullPath));
				continue;
			}
			if (stat.isDirectory()) walk(fullPath, depth + 1);
		}
	};

	walk(skillDir, 0);
	return unsafe;
}

function scanDirectoryForSecrets(skillDir: string): string[] {
	const hits: string[] = [];
	let scanned = 0;

	const walk = (dir: string, depth: number): void => {
		if (depth > 8 || scanned >= MAX_SCANNED_FILES) return;
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (scanned >= MAX_SCANNED_FILES) return;
			if (entry.name === ".git" || entry.name === "node_modules") continue;
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(fullPath, depth + 1);
				continue;
			}
			if (!entry.isFile()) continue;
			let stat: import("node:fs").Stats;
			try {
				stat = statSync(fullPath);
			} catch {
				continue;
			}
			if (stat.size > MAX_SCANNED_FILE_BYTES && basename(fullPath) !== "SKILL.md") continue;
			let buffer: Buffer;
			try {
				buffer = readFileSync(fullPath);
			} catch {
				continue;
			}
			if (looksBinary(buffer)) continue;
			scanned += 1;
			const text = buffer.toString("utf8");
			for (const { label, pattern } of SECRET_PATTERNS) {
				if (pattern.test(text)) {
					hits.push(`${relative(skillDir, fullPath) || entry.name} (${label})`);
					break;
				}
			}
		}
	};

	walk(skillDir, 0);
	return hits;
}

function resolveSkill(
	realRoot: string,
	entry: CuratedSkillEntry,
	diagnostics: CatalogDiagnostic[],
): CuratedSkill | null {
	const declaredPath = resolve(realRoot, entry.path);
	if (!existsSync(declaredPath)) {
		diagnostics.push({
			severity: "error",
			code: "skill_missing",
			skillId: entry.skillId,
			path: declaredPath,
			message: `skill "${entry.skillId}" path does not exist: ${entry.path}`,
		});
		return null;
	}

	const realDir = realpathSync(declaredPath);
	if (!isInside(realRoot, realDir)) {
		diagnostics.push({
			severity: "error",
			code: "path_escape",
			skillId: entry.skillId,
			path: declaredPath,
			message: `skill "${entry.skillId}" resolves outside the catalog root: ${entry.path}`,
		});
		return null;
	}
	if (!statSync(realDir).isDirectory()) {
		diagnostics.push({
			severity: "error",
			code: "skill_missing",
			skillId: entry.skillId,
			path: declaredPath,
			message: `skill "${entry.skillId}" path must be a directory containing SKILL.md`,
		});
		return null;
	}

	const skillFile = join(realDir, "SKILL.md");
	if (!existsSync(skillFile) || !statSync(skillFile).isFile()) {
		diagnostics.push({
			severity: "error",
			code: "skill_missing",
			skillId: entry.skillId,
			path: declaredPath,
			message: `skill "${entry.skillId}" has no SKILL.md`,
		});
		return null;
	}

	const unsafeSymlinks = findUnsafeSymlinks(realDir);
	if (unsafeSymlinks.length > 0) {
		diagnostics.push({
			severity: "error",
			code: "path_escape",
			skillId: entry.skillId,
			path: realDir,
			message: `skill "${entry.skillId}" has symlinks that escape or cannot resolve: ${unsafeSymlinks.join(", ")}`,
		});
		return null;
	}

	const realFile = realpathSync(skillFile);
	if (!isInside(realRoot, realFile) || !isInside(realDir, realFile)) {
		diagnostics.push({
			severity: "error",
			code: "path_escape",
			skillId: entry.skillId,
			path: skillFile,
			message: `skill "${entry.skillId}" SKILL.md resolves outside its directory`,
		});
		return null;
	}

	if (statSync(realFile).size > MAX_SKILL_FILE_BYTES) {
		diagnostics.push({
			severity: "error",
			code: "skill_too_large",
			skillId: entry.skillId,
			path: realFile,
			message: `skill "${entry.skillId}" SKILL.md exceeds ${MAX_SKILL_FILE_BYTES} bytes and cannot be scanned reliably`,
		});
		return null;
	}

	const frontmatter = parseFrontmatter(readFileSync(realFile, "utf8"));
	if (!frontmatter) {
		diagnostics.push({
			severity: "error",
			code: "frontmatter_invalid",
			skillId: entry.skillId,
			path: realFile,
			message: `skill "${entry.skillId}" needs SKILL.md frontmatter with name, description, and string triggers`,
		});
		return null;
	}
	if (frontmatter.name !== entry.skillId) {
		diagnostics.push({
			severity: "error",
			code: "name_mismatch",
			skillId: entry.skillId,
			path: realFile,
			message: `skill "${entry.skillId}" declares frontmatter name "${frontmatter.name}"`,
		});
		return null;
	}

	const secretHits = scanDirectoryForSecrets(realDir);
	if (secretHits.length > 0) {
		diagnostics.push({
			severity: "error",
			code: "secret_detected",
			skillId: entry.skillId,
			path: realDir,
			message: `skill "${entry.skillId}" contains secret-shaped content: ${secretHits.join(", ")}`,
		});
		return null;
	}

	return {
		...entry,
		sourceKind: entry.sourceKind as SourceKind,
		name: frontmatter.name,
		description: frontmatter.description,
		triggers: frontmatter.triggers,
		dirPath: realDir,
		filePath: realFile,
	};
}

export function loadCuratedCatalog(options: LoadCuratedCatalogOptions): ResolvedCatalog {
	const diagnostics: CatalogDiagnostic[] = [];
	const manifestPath = options.manifestPath ?? join(options.catalogRoot, "manifest.yaml");

	let realRoot: string;
	try {
		realRoot = realpathSync(options.catalogRoot);
	} catch {
		return {
			catalogRoot: options.catalogRoot,
			manifestPath,
			skills: [],
			skillPaths: [],
			diagnostics: [
				{
					severity: "error",
					code: "catalog_missing",
					path: options.catalogRoot,
					message: `catalog root does not exist: ${options.catalogRoot}`,
				},
			],
		};
	}

	if (!existsSync(manifestPath)) {
		return {
			catalogRoot: realRoot,
			manifestPath,
			skills: [],
			skillPaths: [],
			diagnostics: [
				{
					severity: "error",
					code: "manifest_missing",
					path: manifestPath,
					message: `catalog manifest does not exist: ${manifestPath}`,
				},
			],
		};
	}

	const parsed = parseManifest(readFileSync(manifestPath, "utf8"));
	diagnostics.push(...parsed.diagnostics);

	const skills: CuratedSkill[] = [];
	for (const entry of parsed.entries) {
		const skill = resolveSkill(realRoot, entry, diagnostics);
		if (skill) skills.push(skill);
	}

	const loadedIds = new Set(skills.map((skill) => skill.skillId));
	for (const skill of skills) {
		if (skill.next !== null && !loadedIds.has(skill.next)) {
			diagnostics.push({
				severity: "warning",
				code: "dangling_next",
				skillId: skill.skillId,
				message: `skill "${skill.skillId}" points to next "${skill.next}", which is not in the resolved catalog`,
			});
		}
	}

	return {
		catalogRoot: realRoot,
		manifestPath,
		skills,
		skillPaths: skills.map((skill) => skill.dirPath),
		diagnostics,
	};
}
