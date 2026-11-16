import {
	chmodSync,
	closeSync,
	existsSync,
	fchmodSync,
	fstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import type { LogEntry, LogLevel, LogTailQuery, LogTailResult } from "./contracts.ts";
import type { Redactor } from "./redaction.ts";

export const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_LOG_MAX_ROTATED_FILES = 5;
export const DEFAULT_LOG_RETENTION_DAYS = 14;
const MAX_LOG_LINE_BYTES = 64 * 1024;
const LOG_EVENT = /^[a-z0-9_.-]{1,80}$/;
const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export interface JsonlLogStoreOptions {
	readonly dataDir: string;
	readonly redactor: Redactor;
	readonly maxBytes?: number;
	readonly maxRotatedFiles?: number;
	readonly retentionDays?: number;
	readonly now?: () => number;
	/** Default true. Unknown field keys are redacted rather than passed through. */
	readonly strictFields?: boolean;
}

export interface JsonlLogStoreStats {
	readonly path: string;
	readonly fileCount: number;
	readonly bytes: number;
	readonly writeErrors: number;
}

/**
 * Local JSONL log store. Files are owner-only, rotated by size, and pruned by
 * retention. A/B content is redacted before serialization; the logger never
 * accepts raw prompt/diff/file content by design.
 */
export class JsonlLogStore {
	readonly dir: string;
	readonly path: string;
	private readonly redactor: Redactor;
	private readonly maxBytes: number;
	private readonly maxRotatedFiles: number;
	private readonly retentionDays: number;
	private readonly now: () => number;
	private readonly strictFields: boolean;
	private fd: number;
	private writeErrors = 0;

	constructor(options: JsonlLogStoreOptions) {
		this.dir = join(options.dataDir, "logs");
		this.path = join(this.dir, "daemon.log");
		this.redactor = options.redactor;
		this.maxBytes = Math.max(1024, options.maxBytes ?? DEFAULT_LOG_MAX_BYTES);
		this.maxRotatedFiles = Math.max(1, options.maxRotatedFiles ?? DEFAULT_LOG_MAX_ROTATED_FILES);
		this.retentionDays = Math.max(0, options.retentionDays ?? DEFAULT_LOG_RETENTION_DAYS);
		this.now = options.now ?? Date.now;
		this.strictFields = options.strictFields ?? true;
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		chmodSync(this.dir, 0o700);
		this.fd = this.openLogFile();
		this.prune();
	}

	append(level: LogLevel, event: string, fields: Record<string, unknown> = {}): LogEntry {
		if (!LOG_LEVELS.includes(level)) throw new Error(`invalid_log_level: ${level}`);
		if (!LOG_EVENT.test(event)) throw new Error(`invalid_log_event: ${event}`);
		const entry: LogEntry = {
			ts: new Date(this.now()).toISOString(),
			level,
			event,
			fields: this.redactor.redactLogFields(fields, { strict: this.strictFields }),
		};
		const line = this.serialize(entry);
		try {
			this.rotateIfNeeded(Buffer.byteLength(line));
			writeSync(this.fd, line);
		} catch {
			this.writeErrors += 1;
		}
		return entry;
	}

	tail(query: LogTailQuery = {}): LogTailResult {
		const limit = clampLimit(query.limit);
		const files = this.listFilesNewestFirst();
		const entries: LogEntry[] = [];
		let scannedFiles = 0;
		let truncated = false;
		const sinceMs = query.since ? Date.parse(query.since) : Number.NaN;
		for (const file of files) {
			scannedFiles += 1;
			const lines = readFileSync(file, "utf8")
				.split("\n")
				.filter((line) => line !== "");
			for (let index = lines.length - 1; index >= 0; index -= 1) {
				const entry = parseEntry(lines[index]!);
				if (!entry) continue;
				if (query.level && entry.level !== query.level) continue;
				if (Number.isFinite(sinceMs) && Date.parse(entry.ts) < sinceMs) continue;
				if (entries.length >= limit) {
					truncated = true;
					break;
				}
				entries.push(entry);
			}
			if (truncated) break;
		}
		entries.reverse();
		return { entries, truncated, scannedFiles };
	}

	stats(): JsonlLogStoreStats {
		const files = this.listFilesNewestFirst();
		let bytes = 0;
		for (const file of files) {
			try {
				bytes += statSync(file).size;
			} catch {
				// A concurrent rotation may remove the file between listing and stat.
			}
		}
		return { path: this.path, fileCount: files.length, bytes, writeErrors: this.writeErrors };
	}

	prune(): void {
		if (this.retentionDays <= 0) return;
		const cutoff = this.now() - this.retentionDays * 24 * 60 * 60 * 1000;
		for (const file of this.listFilesNewestFirst()) {
			if (file === this.path) continue;
			try {
				if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true });
			} catch {
				// Already removed by another process; retention is best effort.
			}
		}
	}

	close(): void {
		try {
			closeSync(this.fd);
		} catch {
			// Already closed.
		}
	}

	private serialize(entry: LogEntry): string {
		let line = `${JSON.stringify(entry)}\n`;
		if (Buffer.byteLength(line) > MAX_LOG_LINE_BYTES) {
			const bytes = Buffer.byteLength(JSON.stringify(entry.fields));
			line = `${JSON.stringify({ ...entry, fields: { truncated: true, bytes } })}\n`;
		}
		return line;
	}

	private rotateIfNeeded(nextBytes: number): void {
		let size: number;
		try {
			size = fstatSync(this.fd).size;
		} catch {
			this.fd = this.openLogFile();
			return;
		}
		if (size === 0 || size + nextBytes <= this.maxBytes) return;
		closeSync(this.fd);
		rmSync(`${this.path}.${this.maxRotatedFiles}`, { force: true });
		for (let index = this.maxRotatedFiles - 1; index >= 1; index -= 1) {
			const from = `${this.path}.${index}`;
			if (existsSync(from)) renameSync(from, `${this.path}.${index + 1}`);
		}
		if (existsSync(this.path)) renameSync(this.path, `${this.path}.1`);
		this.fd = this.openLogFile();
		this.prune();
	}

	private openLogFile(): number {
		const fd = openSync(this.path, "a", 0o600);
		if (process.platform !== "win32") fchmodSync(fd, 0o600);
		return fd;
	}

	private listFilesNewestFirst(): string[] {
		if (!existsSync(this.dir)) return [];
		const names = readdirSync(this.dir)
			.filter((name) => name === "daemon.log" || /^daemon\.log\.\d+$/.test(name))
			.sort((a, b) => {
				if (a === "daemon.log") return -1;
				if (b === "daemon.log") return 1;
				return Number(a.slice("daemon.log.".length)) - Number(b.slice("daemon.log.".length));
			});
		return names.map((name) => join(this.dir, name));
	}
}

function parseEntry(line: string): LogEntry | null {
	try {
		const parsed = JSON.parse(line) as Record<string, unknown>;
		if (typeof parsed.ts !== "string" || typeof parsed.level !== "string" || typeof parsed.event !== "string") {
			return null;
		}
		if (!LOG_LEVELS.includes(parsed.level as LogLevel)) return null;
		const fields =
			parsed.fields && typeof parsed.fields === "object" && !Array.isArray(parsed.fields)
				? (parsed.fields as Record<string, unknown>)
				: {};
		return { ts: parsed.ts, level: parsed.level as LogLevel, event: parsed.event, fields };
	} catch {
		return null;
	}
}

function clampLimit(limit: number | undefined): number {
	if (limit === undefined) return 100;
	if (!Number.isFinite(limit)) return 100;
	return Math.min(Math.max(Math.trunc(limit), 1), 1000);
}
