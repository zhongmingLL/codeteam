import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("CLI naming compatibility", () => {
	it("prints the SuperAgentTeam usage and the codeteam alias", () => {
		const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
		const text = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
		expect(text).toContain("usage: superagentteam <command>");
		expect(text).toContain("codeteam is a compatibility alias");
	});

	it("keeps both executable names on the same CLI entry", () => {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			bin?: Record<string, string>;
		};
		expect(pkg.bin).toEqual({
			superagentteam: "./dist/cli.js",
			codeteam: "./dist/cli.js",
		});
	});
});
