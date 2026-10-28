import { randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	fchmodSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	type Stats,
	statSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";

export const TELEMETRY_SALT_FILE = "telemetry-salt";
export const TELEMETRY_SALT_BYTES = 32;

export interface TelemetrySaltOptions {
	readonly dataDir: string;
	/** Override for tests; defaults to <dataDir>/telemetry-salt. */
	readonly path?: string;
}

export interface TelemetrySalt {
	readonly salt: Buffer;
	readonly path: string;
	readonly created: boolean;
}

/**
 * Load or create the local HMAC salt. The file is owner-only (0600) and the
 * data directory is owner-only (0700). Existing POSIX files readable by group
 * or others fail closed instead of being silently repaired: the salt protects
 * trace pseudonymization, so a permission drift must be visible.
 */
export function loadOrCreateTelemetrySalt(options: TelemetrySaltOptions): TelemetrySalt {
	mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
	chmodSync(options.dataDir, 0o700);
	const path = options.path ?? join(options.dataDir, TELEMETRY_SALT_FILE);
	const existing = readSalt(path);
	if (existing) return { salt: existing, path, created: false };
	const salt = randomBytes(TELEMETRY_SALT_BYTES);
	try {
		const fd = openSync(path, "wx", 0o600);
		try {
			writeSync(fd, salt);
			fsyncSync(fd);
			if (process.platform !== "win32") fchmodSync(fd, 0o600);
		} finally {
			closeSync(fd);
		}
		return { salt, path, created: true };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			const raced = readSalt(path);
			if (raced) return { salt: raced, path, created: false };
		}
		throw new Error(`telemetry_salt_create_failed: ${error instanceof Error ? error.message : String(error)}`, {
			cause: error,
		});
	}
}

function readSalt(path: string): Buffer | null {
	let stat: Stats;
	try {
		stat = statSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new Error(`telemetry_salt_stat_failed: ${error instanceof Error ? error.message : String(error)}`, {
			cause: error,
		});
	}
	if (!stat.isFile()) throw new Error("telemetry_salt_not_a_file");
	if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
		throw new Error("telemetry_salt_permissions_invalid: expected 0600");
	}
	const salt = readFileSync(path);
	if (salt.length < 16) throw new Error("telemetry_salt_too_short");
	return salt;
}
