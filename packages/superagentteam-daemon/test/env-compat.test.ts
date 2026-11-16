import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveControlDataDir } from "../src/control/database.ts";
import {
	aliasLegacyEnv,
	defaultDataDir,
	envValue,
	legacyDataDir,
	resolveDataDir,
} from "../src/env.ts";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "superagentteam-env-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("environment compatibility", () => {
	it("prefers SUPERAGENTTEAM_* over the legacy CODETEAM_* fallback", () => {
		expect(envValue({ SUPERAGENTTEAM_DATA_DIR: "new", CODETEAM_DATA_DIR: "old" }, "DATA_DIR")).toBe("new");
		expect(envValue({ CODETEAM_DATA_DIR: "old" }, "DATA_DIR")).toBe("old");
		expect(envValue({}, "DATA_DIR")).toBeUndefined();
	});

	it("mirrors new env names onto legacy names without overwriting explicit legacy values", () => {
		const env: NodeJS.ProcessEnv = {
			SUPERAGENTTEAM_DATA_DIR: "/new/data",
			SUPERAGENTTEAM_HEARTBEAT_MS: "5000",
			CODETEAM_HEARTBEAT_MS: "9000",
		};
		aliasLegacyEnv(env);

		expect(env.CODETEAM_DATA_DIR).toBe("/new/data");
		expect(env.CODETEAM_HEARTBEAT_MS).toBe("9000");
	});

	it("resolves explicit, env, legacy-home, and new-home data roots in order", () => {
		const home = tempDir();
		const explicit = join(home, "explicit");
		const next = join(home, ".superagentteam");
		const legacy = join(home, ".codeteam");

		expect(resolveDataDir(explicit, { HOME: home })).toBe(explicit);
		expect(resolveDataDir(undefined, { HOME: home, SUPERAGENTTEAM_DATA_DIR: "/new/env" })).toBe("/new/env");
		expect(resolveDataDir(undefined, { HOME: home, CODETEAM_DATA_DIR: "/old/env" })).toBe("/old/env");
		expect(resolveDataDir(undefined, { HOME: home })).toBe(next);
		expect(defaultDataDir({ HOME: home })).toBe(next);
		expect(legacyDataDir({ HOME: home })).toBe(legacy);

		mkdirSync(legacy);
		expect(resolveDataDir(undefined, { HOME: home })).toBe(legacy);
		mkdirSync(next);
		expect(resolveDataDir(undefined, { HOME: home })).toBe(next);
	});

	it("lets the control database start from either env name", () => {
		const home = tempDir();
		const newDir = join(home, "new-data");
		const oldDir = join(home, "old-data");
		const previousNew = process.env.SUPERAGENTTEAM_DATA_DIR;
		const previousOld = process.env.CODETEAM_DATA_DIR;
		try {
			process.env.SUPERAGENTTEAM_DATA_DIR = newDir;
			delete process.env.CODETEAM_DATA_DIR;
			expect(resolveControlDataDir()).toBe(newDir);

			delete process.env.SUPERAGENTTEAM_DATA_DIR;
			process.env.CODETEAM_DATA_DIR = oldDir;
			expect(resolveControlDataDir()).toBe(oldDir);
		} finally {
			if (previousNew === undefined) delete process.env.SUPERAGENTTEAM_DATA_DIR;
			else process.env.SUPERAGENTTEAM_DATA_DIR = previousNew;
			if (previousOld === undefined) delete process.env.CODETEAM_DATA_DIR;
			else process.env.CODETEAM_DATA_DIR = previousOld;
		}
	});
});
