import { describe, expect, it } from "vitest";
import type { ReviewFinding } from "../review/types.ts";
import { closeFindings } from "./closure.ts";
import type { FindingVerification, VerificationStatus } from "./types.ts";

const finding: ReviewFinding = {
	severity: "P1",
	file: "src/stats.js",
	claim: "mode returns the maximum value",
	evidenceKind: "static_check",
	falsifier: "grep -F -n 'values[values.length - 1]' src/stats.js",
	falsifierExpected: "zero",
	requiredAction: "count frequencies",
};

function verification(index: number, status: VerificationStatus): FindingVerification {
	return {
		finding,
		status,
		reason: status,
		audit: {
			index,
			finding,
			mode: "repro",
			cwd: "/tmp/work",
			command: finding.falsifier,
			status,
			reason: status,
		},
	};
}

describe("finding closure", () => {
	it("resolves a confirmed finding when the falsifier no longer confirms after the fix", () => {
		const [closure] = closeFindings([finding], [verification(0, "confirmed")], [verification(0, "rejected")]);
		expect(closure?.status).toBe("resolved");
	});

	it("keeps a still-confirmed finding open", () => {
		const [closure] = closeFindings([finding], [verification(0, "confirmed")], [verification(0, "confirmed")]);
		expect(closure?.status).toBe("still_confirmed");
	});

	it("rejects a finding whose initial evidence did not confirm it", () => {
		const [closure] = closeFindings([finding], [verification(0, "rejected")], [verification(0, "rejected")]);
		expect(closure?.status).toBe("rejected");
	});

	it("marks a finding blocked when the verifier cannot execute it", () => {
		const [closure] = closeFindings([finding], [verification(0, "blocked")], [verification(0, "rejected")]);
		expect(closure?.status).toBe("blocked");
	});

	it("marks missing evidence as blocked", () => {
		const [closure] = closeFindings([finding], [], [verification(0, "rejected")]);
		expect(closure?.status).toBe("blocked");
		expect(closure?.reason).toBe("missing verification result");
	});
});
