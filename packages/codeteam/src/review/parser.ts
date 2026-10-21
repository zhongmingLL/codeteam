import type { EvidenceKind, FindingSeverity, ReviewFinding, ReviewVerdict, ReviewVerdictKind } from "./types.ts";

const VERDICTS: readonly ReviewVerdictKind[] = ["approve", "changes_requested", "blocked"];
const SEVERITIES: readonly FindingSeverity[] = ["P1", "P2", "P3"];
const EVIDENCE_KINDS: readonly EvidenceKind[] = [
	"red_test",
	"repro_command",
	"static_check",
	"code_reading",
	"judgment",
];

export class ReviewParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReviewParseError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new ReviewParseError(`review field ${key} must be a non-empty string`);
	}
	return value;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new ReviewParseError(`review field ${key} must be a string`);
	return value;
}

function readOptionalNumber(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new ReviewParseError(`review field ${key} must be a finite number`);
	}
	return value;
}

function readEnum<T extends string>(record: Record<string, unknown>, key: string, values: readonly T[]): T {
	const value = readString(record, key);
	if (!values.includes(value as T)) {
		throw new ReviewParseError(`review field ${key} has invalid value ${value}`);
	}
	return value as T;
}

function parseFinding(value: unknown): ReviewFinding {
	if (!isRecord(value)) throw new ReviewParseError("review finding must be an object");
	const rawSeverity = readEnum(value, "severity", SEVERITIES);
	const evidenceKind = readEnum(value, "evidenceKind", EVIDENCE_KINDS);
	const falsifier = readOptionalString(value, "falsifier") ?? "";
	const executable =
		(evidenceKind === "red_test" || evidenceKind === "repro_command" || evidenceKind === "static_check") &&
		falsifier.trim().length > 0;
	const severity = (rawSeverity === "P1" || rawSeverity === "P2") && !executable ? "P3" : rawSeverity;
	const file = readOptionalString(value, "file");
	const line = readOptionalNumber(value, "line");
	return {
		severity,
		...(file === undefined ? {} : { file }),
		...(line === undefined ? {} : { line }),
		claim: readString(value, "claim"),
		evidenceKind,
		falsifier,
		requiredAction: readString(value, "requiredAction"),
	};
}

export function parseReviewVerdict(text: string): ReviewVerdict {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) {
		throw new ReviewParseError("review response does not contain a JSON object");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch (error) {
		throw new ReviewParseError(`review response is not valid JSON: ${String(error)}`);
	}
	if (!isRecord(parsed)) throw new ReviewParseError("review response must be a JSON object");
	const verdict = readEnum(parsed, "verdict", VERDICTS);
	const rawFindings = parsed.findings;
	if (rawFindings === undefined) return { verdict, findings: [] };
	if (!Array.isArray(rawFindings)) throw new ReviewParseError("review findings must be an array");
	return { verdict, findings: rawFindings.map(parseFinding) };
}
