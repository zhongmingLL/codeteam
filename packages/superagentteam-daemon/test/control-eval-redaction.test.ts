import { describe, expect, it } from "vitest";
import { assertNoEvalSecrets, ControlError, scanEvalContent } from "../src/index.ts";

describe("W6b eval secret scanning", () => {
	it("detects credentials in nested verdict text without returning the secret", () => {
		const findings = scanEvalContent(
			{
				phenomenon: "use password=SuperSecret123 to reproduce",
				findings: [{ claim: "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789" }],
				refs: ["-----BEGIN PRIVATE KEY-----"],
			},
			"packet",
		);
		expect(findings.map((finding) => finding.pattern)).toContain("assigned_secret");
		expect(findings.map((finding) => finding.pattern)).toContain("github_token");
		expect(findings.map((finding) => finding.pattern)).toContain("private_key");
		expect(JSON.stringify(findings)).not.toContain("SuperSecret123");
		expect(JSON.stringify(findings)).not.toContain("ghp_abcdefghijklmnop");
	});

	it("fails closed with a path-only error", () => {
		try {
			assertNoEvalSecrets({ evidencePacket: { summary: "AKIAABCDEFGHIJKLMNOP" } }, "verdict_packet");
			throw new Error("expected ControlError");
		} catch (error) {
			expect(error).toBeInstanceOf(ControlError);
			expect((error as ControlError).message).toContain("verdict_packet.evidencePacket.summary:aws_access_key");
			expect((error as ControlError).message).not.toContain("AKIAABCDEFGHIJKLMNOP");
		}
	});

	it("allows long paths and hashes that are not credentials", () => {
		const findings = scanEvalContent({
			refs: ["file:docs/plans/0016-w6b-eval-outcome-harness-eval.md"],
			sha: "0123456789abcdef0123456789abcdef01234567",
		});
		expect(findings).toEqual([]);
	});
});
