import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOrCreateTelemetrySalt } from "../src/observability/salt.ts";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "codeteam-salt-"));
	dirs.push(dir);
	return dir;
}

describe("W6c telemetry salt", () => {
	it("creates a 32-byte salt file with owner-only permissions", () => {
		const dataDir = tempDir();
		const result = loadOrCreateTelemetrySalt({ dataDir });
		expect(result.created).toBe(true);
		expect(result.salt).toHaveLength(32);
		expect(readFileSync(result.path)).toEqual(result.salt);
		if (process.platform !== "win32") {
			expect(statSync(result.path).mode & 0o777).toBe(0o600);
			expect(statSync(dataDir).mode & 0o777).toBe(0o700);
		}
		const again = loadOrCreateTelemetrySalt({ dataDir });
		expect(again.created).toBe(false);
		expect(again.salt).toEqual(result.salt);
	});

	it("fails closed when an existing salt is group/other readable", () => {
		if (process.platform === "win32") return;
		const dataDir = tempDir();
		const result = loadOrCreateTelemetrySalt({ dataDir });
		chmodSync(result.path, 0o644);
		expect(() => loadOrCreateTelemetrySalt({ dataDir })).toThrowError(
			"telemetry_salt_permissions_invalid: expected 0600",
		);
	});

	it("fails closed for a directory at the salt path", () => {
		const dataDir = tempDir();
		const path = join(dataDir, "telemetry-salt");
		mkdirSync(path);
		expect(() => loadOrCreateTelemetrySalt({ dataDir })).toThrowError("telemetry_salt_not_a_file");
	});
});
