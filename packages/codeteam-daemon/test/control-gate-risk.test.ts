import { describe, expect, it } from "vitest";
import { classifyRisk, parseGitNumstat } from "../src/gates/risk.ts";
import { evaluateRiskConsistency } from "../src/gates/risk-consistency.ts";

function file(path: string, additions = 1, deletions = 0) {
	return { path, additions, deletions };
}

describe("codeteam five-axis risk classifier", () => {
	it("classifies docs-only changes as the docs lane", () => {
		const risk = classifyRisk({ changedFiles: [file("docs/plans/0009.md", 20, 2), file("README.md", 2, 1)] });
		expect(risk.axes).toEqual([]);
		expect(risk.lane).toBe("docs");
		expect(risk.assurance).toBe("light");
		expect(risk.mismatches).toEqual([]);
	});

	it("escalates auth, migrations, and gate harness changes to critical", () => {
		for (const path of [
			"packages/codeteam-daemon/src/auth/operator.ts",
			"packages/codeteam-daemon/src/control/migrations/010-merge.ts",
			"packages/codeteam-daemon/src/gates/service.ts",
			"packages/codeteam-daemon/src/review/policy.ts",
		]) {
			const risk = classifyRisk({ changedFiles: [file(path, 5, 1)] });
			expect(risk.assurance).toBe("critical");
			expect(risk.lane).toBe("standard");
			expect(risk.axes.length).toBeGreaterThan(0);
		}
	});

	it("classifies tiny behavior-only changes as product_fast and larger ones as small_change", () => {
		const tiny = classifyRisk({ changedFiles: [file("packages/codeteam-daemon/src/cli/args.ts", 40, 2)] });
		expect([...tiny.axes].sort()).toEqual(["behavior", "contract"]);
		expect(tiny.lane).toBe("standard");
		const pureBehavior = classifyRisk({
			changedFiles: [file("packages/codeteam-pi-adapter/src/session/session.ts", 40, 2)],
		});
		expect(pureBehavior.axes).toEqual(["behavior"]);
		expect(pureBehavior.lane).toBe("product_fast");
		const larger = classifyRisk({
			changedFiles: [file("packages/codeteam-pi-adapter/src/session/session.ts", 300, 20)],
		});
		expect(larger.lane).toBe("small_change");
	});

	it("only escalates declared risk; lower declarations become P1/P2 mismatches", () => {
		const risk = classifyRisk({
			changedFiles: [file("packages/codeteam-daemon/src/auth/operator.ts", 5, 0)],
			declaredLane: "docs",
			declaredAssurance: "light",
			declaredAxes: [],
		});
		expect(risk.mismatches.map((mismatch) => mismatch.code)).toEqual([
			"declared_assurance_understated",
			"declared_lane_understated",
			"declared_axes_incomplete",
			"declared_axes_incomplete",
			"declared_axes_incomplete",
		]);
		const result = evaluateRiskConsistency(risk);
		expect(result.status).toBe("block");
	});

	it("escalates large diffs and parses git numstat", () => {
		const files = parseGitNumstat("10\t2\tsrc/a.ts\n0\t5\tdocs/b.md\n");
		expect(files).toEqual([
			{ path: "src/a.ts", additions: 10, deletions: 2 },
			{ path: "docs/b.md", additions: 0, deletions: 5 },
		]);
		const risk = classifyRisk({ changedFiles: [file("packages/codeteam-pi-adapter/src/a.ts", 1300, 0)] });
		expect(risk.assurance).toBe("high");
	});

	it("adds an advisory when no lane/assurance/axes were declared", () => {
		const result = evaluateRiskConsistency(classifyRisk({ changedFiles: [file("docs/a.md", 1, 0)] }));
		expect(result.status).toBe("advisory");
		expect(result.findings.map((finding) => finding.code)).toContain("risk_declaration_missing");
	});
});
