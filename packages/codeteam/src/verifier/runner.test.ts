import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReviewFinding } from "../review/types.ts";
import { verifyFinding, verifyVerdict } from "./runner.ts";

function createFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
	return {
		severity: "P1",
		file: "fixture.txt",
		claim: "fixture contains a bad line",
		evidenceKind: "static_check",
		falsifier: 'grep -n "bad line" fixture.txt',
		falsifierExpected: "zero",
		requiredAction: "remove the bad line",
		...overrides,
	};
}

describe("falsifier runner", () => {
	let workdir: string;
	let fixture: string;

	beforeEach(() => {
		workdir = mkdtempSync(join(tmpdir(), "codeteam-verifier-"));
		fixture = join(workdir, "fixture.txt");
		writeFileSync(fixture, "bad line\n");
		writeFileSync(join(workdir, "clean.txt"), "clean\n");
	});

	afterEach(() => {
		rmSync(workdir, { recursive: true, force: true });
	});

	it("confirms a finding when the falsifier exits with the expected code", () => {
		const result = verifyFinding(createFinding(), 0, { workdir });
		expect(result.status).toBe("confirmed");
		expect(result.audit.exitCode).toBe(0);
		expect(result.audit.stdoutTail).toContain("bad line");
		expect(result.audit.command).toContain("grep");
		expect(result.audit.executable).toBe("grep");
		expect(result.audit.args).toEqual(["-n", "bad line", "fixture.txt"]);
	});

	it("rejects a finding when the falsifier disagrees with the expectation", () => {
		const result = verifyFinding(createFinding({ falsifier: 'grep -n "missing" fixture.txt' }), 0, { workdir });
		expect(result.status).toBe("rejected");
		expect(result.audit.exitCode).not.toBe(0);
	});

	it("supports a nonzero expectation", () => {
		const result = verifyFinding(
			createFinding({ falsifier: 'grep -n "missing" fixture.txt', falsifierExpected: "nonzero" }),
			0,
			{ workdir },
		);
		expect(result.status).toBe("confirmed");
		expect(result.audit.expected).toBe("nonzero");
	});

	it("blocks dangerous commands without executing them", () => {
		const result = verifyFinding(createFinding({ falsifier: "rm -rf fixture.txt", falsifierExpected: "zero" }), 0, {
			workdir,
		});
		expect(result.status).toBe("blocked");
		expect(result.reason).toContain("allowlisted");
		expect(existsSync(fixture)).toBe(true);
	});

	it("blocks path escapes and secret paths before execution", () => {
		const pathEscape = verifyFinding(createFinding({ falsifier: "cat ../secret", falsifierExpected: "zero" }), 0, {
			workdir,
		});
		expect(pathEscape.status).toBe("blocked");
		const secret = verifyFinding(createFinding({ falsifier: "cat .env", falsifierExpected: "zero" }), 0, {
			workdir,
		});
		expect(secret.status).toBe("blocked");
	});

	it("blocks non-executable evidence and missing expectations", () => {
		const judgment = verifyFinding(
			createFinding({ evidenceKind: "judgment", falsifier: "", falsifierExpected: undefined }),
			0,
			{ workdir },
		);
		expect(judgment.status).toBe("blocked");

		const missingExpected = verifyFinding(
			createFinding({ evidenceKind: "static_check", falsifierExpected: undefined }),
			0,
			{ workdir },
		);
		expect(missingExpected.status).toBe("blocked");
		expect(missingExpected.reason).toContain("falsifierExpected");
	});

	it("can execute a node repro in repro mode and truncates output", () => {
		const result = verifyFinding(
			createFinding({
				evidenceKind: "repro_command",
				falsifier: "node -e \"console.log('x'.repeat(10000))\"",
				falsifierExpected: "zero",
			}),
			0,
			{ workdir, mode: "repro", outputLimitBytes: 100 },
		);
		expect(result.status).toBe("confirmed");
		expect(result.audit.stdoutTail?.length ?? 0).toBeLessThanOrEqual(100);
	});

	it("returns one verification per finding", () => {
		const results = verifyVerdict(
			{
				verdict: "changes_requested",
				findings: [
					createFinding(),
					createFinding({
						severity: "P3",
						evidenceKind: "judgment",
						falsifier: "",
						falsifierExpected: undefined,
					}),
				],
			},
			{ workdir },
		);
		expect(results.map((result) => result.status)).toEqual(["confirmed", "blocked"]);
	});
});
