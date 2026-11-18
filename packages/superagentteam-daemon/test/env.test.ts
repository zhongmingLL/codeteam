import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveControlDataDir } from "../src/control/database.ts";
import { defaultDataDir, envValue, resolveDataDir } from "../src/env.ts";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "superagentteam-env-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("environment resolution", () => {
	it("reads only SUPERAGENTTEAM_* names and ignores legacy CODETEAM_* names", () => {
		expect(envValue({ SUPERAGENTTEAM_DATA_DIR: "new", CODETEAM_DATA_DIR: "old" }, "DATA_DIR")).toBe("new");
		expect(envValue({ CODETEAM_DATA_DIR: "old" }, "DATA_DIR")).toBeUndefined();
		expect(envValue({}, "DATA_DIR")).toBeUndefined();
	});

	it("resolves explicit, env, and new-home data roots without reading the legacy root", () => {
		const home = tempDir();
		const explicit = join(home, "explicit");
		const next = join(home, ".superagentteam");
		const legacy = join(home, ".codeteam");
		mkdirSync(legacy);

		expect(resolveDataDir(explicit, { HOME: home })).toBe(explicit);
		expect(resolveDataDir(undefined, { HOME: home, SUPERAGENTTEAM_DATA_DIR: "/new/env" })).toBe("/new/env");
		expect(resolveDataDir(undefined, { HOME: home, CODETEAM_DATA_DIR: "/old/env" })).toBe(next);
		expect(resolveDataDir(undefined, { HOME: home })).toBe(next);
		expect(defaultDataDir({ HOME: home })).toBe(next);
	});

	it("lets the control database start only from the new env name", () => {
		const home = tempDir();
		const newDir = join(home, "new-data");
		const oldDir = join(home, "old-data");
		const previousHome = process.env.HOME;
		const previousNew = process.env.SUPERAGENTTEAM_DATA_DIR;
		const previousOld = process.env.CODETEAM_DATA_DIR;
		try {
			process.env.HOME = home;
			process.env.SUPERAGENTTEAM_DATA_DIR = newDir;
			delete process.env.CODETEAM_DATA_DIR;
			expect(resolveControlDataDir()).toBe(newDir);

			delete process.env.SUPERAGENTTEAM_DATA_DIR;
			process.env.CODETEAM_DATA_DIR = oldDir;
			expect(resolveControlDataDir()).toBe(join(home, ".superagentteam"));
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousNew === undefined) delete process.env.SUPERAGENTTEAM_DATA_DIR;
			else process.env.SUPERAGENTTEAM_DATA_DIR = previousNew;
			if (previousOld === undefined) delete process.env.CODETEAM_DATA_DIR;
			else process.env.CODETEAM_DATA_DIR = previousOld;
		}
	});
});
