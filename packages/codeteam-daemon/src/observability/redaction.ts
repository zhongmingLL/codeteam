import { createHash, createHmac } from "node:crypto";
import type { TraceAttributeValue } from "./contracts.ts";

const CLASS_A_KEYS = new Set([
	"authorization",
	"cookie",
	"set-cookie",
	"x-api-key",
	"token",
	"apikey",
	"api_key",
	"secret",
	"password",
	"credential",
	"credentials",
	"private_key",
	"signature",
	"salt",
	"hmac_salt",
	"callbacktoken",
]);

const CLASS_B_KEYS = new Set([
	"prompt",
	"message.content",
	"message_content",
	"body_md",
	"body",
	"thinking",
	"toolinput",
	"tool_input",
	"tool_result",
	"tool_result_body",
	"command",
	"aggregated_output",
	"stdout",
	"stderr",
	"diff",
	"patch",
	"file_content",
	"filecontent",
	"content",
	"rich_block",
	"rich_blocks",
	"text",
	"output",
	"result",
	"args",
	"input",
	"request",
	"response",
	"payload",
	"data",
	"raw",
	"message",
	"messages",
	"error",
	"stack",
	"traceback",
]);

// Content-shaped keys are treated as Class B even when a new synonym appears.
// The long-string guard below is the second line of defense for unknown keys.
const CLASS_B_PATTERN =
	/(^|_)(prompt|content|body|diff|patch|file|files|command|stdout|stderr|output|result|args|input|message|messages|request|response|payload|raw|text|stack|traceback|md)(_|$)/i;

const CLASS_C_KEYS = new Set([
	"userid",
	"user_id",
	"threadid",
	"thread_id",
	"invocationid",
	"invocation_id",
	"sessionid",
	"session_id",
	"messageid",
	"message_id",
	"runid",
	"run_id",
	"taskid",
	"task_id",
	"callid",
	"call_id",
	"clientmessageid",
	"sourceid",
	"source_id",
	"queueentryid",
	"queue_entry_id",
	"handoffid",
	"handoff_id",
	"approvalid",
	"approval_id",
	"artifactid",
	"artifact_id",
	"reviewid",
	"review_id",
	"mergeid",
	"merge_id",
]);

export type TraceAttributeClassification = "id" | "string" | "number" | "boolean";

/**
 * Trace attributes are allowlisted, not passed through. Unknown keys are
 * dropped and counted. This is the primary defense against raw prompt/diff/
 * file content entering the trace ring or an OTLP exporter.
 */
export const TRACE_ATTRIBUTE_ALLOWLIST: ReadonlyMap<string, TraceAttributeClassification> = new Map([
	["invocation.id", "id"],
	["task.id", "id"],
	["thread.id", "id"],
	["tool.call.id", "id"],
	["profile.id", "string"],
	["role", "string"],
	["provider", "string"],
	["model", "string"],
	["model_family", "string"],
	["run.status", "string"],
	["run.execution", "string"],
	["run.attempt", "number"],
	["tool.name", "string"],
	["tool.category", "string"],
	["tool.phase", "string"],
	["tool.input.keys", "string"],
	["tool.result.status", "string"],
	["tool.duration_ms", "number"],
	["event.kind", "string"],
	["error.kind", "string"],
]);

/** Metric labels are bounded enums only. No run/thread/message identifiers. */
export const METRIC_LABEL_ALLOWLIST: ReadonlySet<string> = new Set([
	"role",
	"provider",
	"model",
	"model_family",
	"status",
	"tool.category",
	"tool.name",
	"event.kind",
]);

/**
 * Strict log field mode (the JsonlLogStore default). Unknown keys are treated
 * as content and replaced with a digest marker; only these operational fields
 * pass through. This closes the "short unknown string" gap that a key-based
 * denylist alone cannot cover.
 */
export const STRICT_LOG_FIELD_ALLOWLIST: ReadonlySet<string> = new Set([
	"runid",
	"run_id",
	"threadid",
	"thread_id",
	"taskid",
	"task_id",
	"sessionid",
	"session_id",
	"messageid",
	"message_id",
	"invocationid",
	"invocation_id",
	"callid",
	"call_id",
	"clientmessageid",
	"client_message_id",
	"sourceid",
	"source_id",
	"queueentryid",
	"queue_entry_id",
	"handoffid",
	"handoff_id",
	"approvalid",
	"approval_id",
	"artifactid",
	"artifact_id",
	"reviewid",
	"review_id",
	"mergeid",
	"merge_id",
	"userid",
	"user_id",
	"role",
	"status",
	"provider",
	"model",
	"modelfamily",
	"model_family",
	"attempt",
	"durationms",
	"duration_ms",
	"iserror",
	"is_error",
	"count",
	"bytes",
	"size",
	"level",
	"event",
	"toolname",
	"tool_name",
	"category",
	"phase",
	"errorcode",
	"error_code",
	"code",
	"pid",
	"bootid",
	"boot_id",
	"deploymentid",
	"deployment_id",
	"installationid",
	"installation_id",
	"revision",
	"headsha",
	"head_sha",
	"basesha",
	"base_sha",
	"mergesha",
	"merge_sha",
	"traceid",
	"trace_id",
	"spanid",
	"span_id",
	"parentspanid",
	"parent_span_id",
	"__truncated_keys",
]);

const SAFE_NAME = /^[a-zA-Z0-9_.:/@+,-]{1,256}$/;
const SAFE_EVENT_NAME = /^[a-z0-9_.-]{1,64}$/;
const SAFE_STATUS_MESSAGE = /^[a-zA-Z0-9_.:-]{1,120}$/;
const MAX_SAFE_STRING_LENGTH = 512;
const MAX_ARRAY_ITEMS = 32;
const MAX_OBJECT_KEYS = 64;
const MAX_DEPTH = 6;

export interface RedactorOptions {
	/** HMAC salt. Required for trace pseudonymization; logs can run without it. */
	readonly salt?: string | Buffer | null;
}

export interface RedactLogFieldsOptions {
	/** Default false for the low-level helper; JsonlLogStore defaults to true. */
	readonly strict?: boolean;
}

export class Redactor {
	private readonly salt: Buffer | null;

	constructor(options: RedactorOptions = {}) {
		const salt = options.salt;
		if (salt === undefined || salt === null) {
			this.salt = null;
		} else {
			this.salt = typeof salt === "string" ? Buffer.from(salt, "utf8") : salt;
		}
	}

	get canPseudonymize(): boolean {
		return this.salt !== null && this.salt.length > 0;
	}

	hmacId(id: string): string {
		if (!this.salt) throw new Error("telemetry_salt_missing");
		return createHmac("sha256", this.salt).update(id).digest("hex").slice(0, 32);
	}

	contentRef(value: string): string {
		const digest = createHash("sha256").update(value).digest("hex").slice(0, 16);
		return `[content:sha256:${digest} len:${value.length}]`;
	}

	redactLogFields(fields: Record<string, unknown>, options?: RedactLogFieldsOptions): Record<string, unknown> {
		return redactLogFields(fields, this, options);
	}
}

export function createRedactor(options: RedactorOptions = {}): Redactor {
	return new Redactor(options);
}

export function isClassAKey(key: string): boolean {
	const lower = key.toLowerCase();
	return (
		CLASS_A_KEYS.has(lower) || lower.endsWith("_token") || lower.endsWith("_api_key") || lower.endsWith("_secret")
	);
}

export function isClassBKey(key: string): boolean {
	const lower = key.toLowerCase();
	if (CLASS_B_KEYS.has(lower) || CLASS_B_PATTERN.test(lower)) return true;
	return ["body", "content", "text", "output", "result", "args", "input", "message", "error", "stack", "md"].some(
		(suffix) => lower.endsWith(suffix) && lower !== suffix,
	);
}

export function isClassCKey(key: string): boolean {
	return CLASS_C_KEYS.has(key.toLowerCase());
}

export function redactLogFields(
	fields: Record<string, unknown>,
	redactor: Redactor,
	options: RedactLogFieldsOptions = {},
): Record<string, unknown> {
	const strict = options.strict ?? false;
	const result: Record<string, unknown> = {};
	let count = 0;
	for (const [key, value] of Object.entries(fields)) {
		if (count >= MAX_OBJECT_KEYS) break;
		result[key] = redactLogValue(key, value, redactor, 0, strict);
		count += 1;
	}
	if (Object.keys(fields).length > MAX_OBJECT_KEYS)
		result.__truncated_keys = Object.keys(fields).length - MAX_OBJECT_KEYS;
	return result;
}

function redactLogValue(key: string, value: unknown, redactor: Redactor, depth: number, strict: boolean): unknown {
	if (isClassAKey(key)) return "[REDACTED]";
	if (isClassBKey(key)) {
		if (typeof value === "string") return redactor.contentRef(value);
		return `[content:${typeOf(value)}]`;
	}
	if (strict) {
		if (!STRICT_LOG_FIELD_ALLOWLIST.has(key.toLowerCase())) return contentMarker(value, redactor);
		if (value !== null && typeof value === "object") return `[content:${typeOf(value)}]`;
	}
	return boundValue(value, redactor, depth, strict);
}

function contentMarker(value: unknown, redactor: Redactor): string {
	return typeof value === "string" ? redactor.contentRef(value) : `[content:${typeOf(value)}]`;
}

function boundValue(value: unknown, redactor: Redactor, depth: number, strict: boolean): unknown {
	if (value === null) return null;
	if (depth > MAX_DEPTH) return "[max_depth]";
	if (typeof value === "string") {
		if (value.length > MAX_SAFE_STRING_LENGTH) return redactor.contentRef(value);
		return value;
	}
	if (typeof value === "number") return Number.isFinite(value) ? value : "[non_finite_number]";
	if (typeof value === "boolean") return value;
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return "[unsupported]";
	if (Array.isArray(value)) {
		const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => boundValue(item, redactor, depth + 1, strict));
		if (value.length > MAX_ARRAY_ITEMS) items.push(`[truncated ${value.length - MAX_ARRAY_ITEMS}]`);
		return items;
	}
	if (typeof value === "object") {
		const result: Record<string, unknown> = {};
		const entries = Object.entries(value as Record<string, unknown>);
		for (const [key, item] of entries.slice(0, MAX_OBJECT_KEYS)) {
			result[key] = redactLogValue(key, item, redactor, depth + 1, strict);
		}
		if (entries.length > MAX_OBJECT_KEYS) result.__truncated_keys = entries.length - MAX_OBJECT_KEYS;
		return result;
	}
	return "[unsupported]";
}

export function redactTraceAttributes(
	attributes: Record<string, unknown>,
	redactor: Redactor,
): { attributes: Record<string, TraceAttributeValue>; dropped: number } {
	const result: Record<string, TraceAttributeValue> = {};
	let dropped = 0;
	for (const [key, value] of Object.entries(attributes)) {
		const classification = TRACE_ATTRIBUTE_ALLOWLIST.get(key);
		if (!classification) {
			dropped += 1;
			continue;
		}
		const redacted = redactTraceValue(classification, value, redactor);
		if (redacted === undefined) {
			dropped += 1;
			continue;
		}
		result[key] = redacted;
	}
	return { attributes: result, dropped };
}

function redactTraceValue(
	classification: TraceAttributeClassification,
	value: unknown,
	redactor: Redactor,
): TraceAttributeValue | undefined {
	if (classification === "number") {
		return typeof value === "number" && Number.isFinite(value) ? value : undefined;
	}
	if (classification === "boolean") {
		return typeof value === "boolean" ? value : undefined;
	}
	if (typeof value !== "string") return undefined;
	if (classification === "id") {
		if (!redactor.canPseudonymize) return undefined;
		return redactor.hmacId(value);
	}
	if (value.length === 0 || value.length > 256) return undefined;
	if (!SAFE_NAME.test(value)) return undefined;
	return value;
}

export function sanitizeSpanName(name: string): string | undefined {
	return SAFE_NAME.test(name) && name.length <= 128 ? name : undefined;
}

export function sanitizeEventName(name: string): string | undefined {
	return SAFE_EVENT_NAME.test(name) ? name : undefined;
}

export function sanitizeStatusMessage(message: string): string {
	return SAFE_STATUS_MESSAGE.test(message) ? message : "[redacted]";
}

function typeOf(value: unknown): string {
	if (Array.isArray(value)) return "array";
	if (value === null) return "null";
	return typeof value;
}
