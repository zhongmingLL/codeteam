import { isAbsolute } from "node:path";
import { parse } from "yaml";

export const SOURCE_KINDS = ["repo-local", "vendored"] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface CuratedSkillEntry {
	skillId: string;
	path: string;
	sourceKind: SourceKind;
	category: string;
	notFor: string[];
	output: string;
	next: string | null;
	sopStep: string;
}

export type CatalogDiagnosticCode =
	| "manifest_invalid"
	| "manifest_missing"
	| "catalog_missing"
	| "duplicate_skill_id"
	| "path_absolute"
	| "path_escape"
	| "skill_missing"
	| "frontmatter_invalid"
	| "name_mismatch"
	| "secret_detected"
	| "skill_too_large"
	| "dangling_next";

export interface CatalogDiagnostic {
	severity: "error" | "warning";
	code: CatalogDiagnosticCode;
	message: string;
	skillId?: string;
	path?: string;
}

export interface ParsedManifest {
	entries: CuratedSkillEntry[];
	diagnostics: CatalogDiagnostic[];
}

const ENTRY_KEYS = new Set(["skillId", "path", "sourceKind", "category", "not_for", "output", "next", "sop_step"]);

const REQUIRED_STRING_KEYS = ["skillId", "path", "sourceKind", "category", "output", "sop_step"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

function structuralPathDiagnostic(skillId: string, path: string): CatalogDiagnostic | null {
	if (isAbsolute(path) || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\")) {
		return {
			severity: "error",
			code: "path_absolute",
			skillId,
			path,
			message: `skill "${skillId}" uses an absolute path; manifest paths must stay inside the catalog root`,
		};
	}
	if (path.split(/[\\/]/).includes("..")) {
		return {
			severity: "error",
			code: "path_escape",
			skillId,
			path,
			message: `skill "${skillId}" uses ".."; manifest paths must stay inside the catalog root`,
		};
	}
	return null;
}

export function parseManifest(raw: string): ParsedManifest {
	const diagnostics: CatalogDiagnostic[] = [];
	const entries: CuratedSkillEntry[] = [];

	let document: unknown;
	try {
		document = parse(raw);
	} catch (error) {
		return {
			entries,
			diagnostics: [
				{
					severity: "error",
					code: "manifest_invalid",
					message: `manifest is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
				},
			],
		};
	}

	const rawSkills = isRecord(document) ? document.skills : undefined;
	const skills = rawSkills == null ? [] : rawSkills;
	if (!isRecord(document) || document.version !== 1 || !Array.isArray(skills)) {
		return {
			entries,
			diagnostics: [
				{
					severity: "error",
					code: "manifest_invalid",
					message: "manifest must be an object with `version: 1` and a `skills` array",
				},
			],
		};
	}

	const seen = new Set<string>();
	for (const [index, rawEntry] of skills.entries()) {
		if (!isRecord(rawEntry)) {
			diagnostics.push({
				severity: "error",
				code: "manifest_invalid",
				message: `skills[${index}] must be an object`,
			});
			continue;
		}

		const unknownKeys = Object.keys(rawEntry).filter((key) => !ENTRY_KEYS.has(key));
		if (unknownKeys.length > 0) {
			diagnostics.push({
				severity: "error",
				code: "manifest_invalid",
				skillId: typeof rawEntry.skillId === "string" ? rawEntry.skillId : undefined,
				message: `skills[${index}] has unknown keys (${unknownKeys.join(", ")}); description/triggers belong in SKILL.md frontmatter`,
			});
			continue;
		}

		const missingKeys = REQUIRED_STRING_KEYS.filter((key) => !nonEmptyString(rawEntry[key]));
		if (missingKeys.length > 0) {
			diagnostics.push({
				severity: "error",
				code: "manifest_invalid",
				skillId: typeof rawEntry.skillId === "string" ? rawEntry.skillId : undefined,
				message: `skills[${index}] is missing required string fields: ${missingKeys.join(", ")}`,
			});
			continue;
		}

		const skillId = rawEntry.skillId as string;
		const path = rawEntry.path as string;
		const sourceKind = rawEntry.sourceKind as string;
		if (!(SOURCE_KINDS as readonly string[]).includes(sourceKind)) {
			diagnostics.push({
				severity: "error",
				code: "manifest_invalid",
				skillId,
				message: `skill "${skillId}" has unsupported sourceKind "${sourceKind}" (expected ${SOURCE_KINDS.join(" | ")})`,
			});
			continue;
		}

		const notFor = rawEntry.not_for;
		if (!Array.isArray(notFor) || notFor.length === 0 || !notFor.every(nonEmptyString)) {
			diagnostics.push({
				severity: "error",
				code: "manifest_invalid",
				skillId,
				message: `skill "${skillId}" must declare a non-empty not_for string array`,
			});
			continue;
		}

		const next = rawEntry.next ?? null;
		if (next !== null && !nonEmptyString(next)) {
			diagnostics.push({
				severity: "error",
				code: "manifest_invalid",
				skillId,
				message: `skill "${skillId}" has an invalid next reference`,
			});
			continue;
		}

		const pathDiagnostic = structuralPathDiagnostic(skillId, path);
		if (pathDiagnostic) {
			diagnostics.push(pathDiagnostic);
			continue;
		}

		if (seen.has(skillId)) {
			diagnostics.push({
				severity: "error",
				code: "duplicate_skill_id",
				skillId,
				message: `duplicate skillId "${skillId}" in manifest`,
			});
			continue;
		}
		seen.add(skillId);

		entries.push({
			skillId,
			path,
			sourceKind: sourceKind as SourceKind,
			category: rawEntry.category as string,
			notFor: notFor as string[],
			output: rawEntry.output as string,
			next: next as string | null,
			sopStep: rawEntry.sop_step as string,
		});
	}

	return { entries, diagnostics };
}
