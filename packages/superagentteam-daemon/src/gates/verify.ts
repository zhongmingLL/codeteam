import type { Review, Verification } from "../control/stores/types.ts";
import { latestVerification, verificationIsOpen } from "./review.ts";
import { type GateFinding, type GateResult, gateResult } from "./types.ts";

export interface VerifyGateInput {
	readonly taskId: string;
	readonly headSha: string;
	readonly baseSha: string | null;
	readonly reviews: readonly Review[];
	readonly verifications: (findingId: string) => readonly Verification[];
	readonly now?: number;
}

export function evaluateVerifyGate(input: VerifyGateInput): GateResult {
	const findings: GateFinding[] = [];
	const evidenceRefs: string[] = [];
	const current = input.reviews.filter(
		(review) => review.headSha === input.headSha && review.baseSha !== null && review.baseSha === input.baseSha,
	);
	const executableFindings = current.flatMap((review) =>
		review.findings.filter((finding) => finding.severity === "P1" || finding.severity === "P2"),
	);
	if (executableFindings.length === 0) {
		return gateResult("verify", [], evidenceRefs, "no open P1/P2 findings require falsifier evidence");
	}
	const now = input.now ?? Date.now();
	for (const finding of executableFindings) {
		const latest = latestVerification(input.verifications(finding.id));
		if (!latest) {
			findings.push({
				code: "missing_falsifier_verification",
				severity: finding.severity,
				message: `${finding.severity} finding has no falsifier verification`,
				evidenceRef: `finding:${finding.id}`,
			});
			continue;
		}
		evidenceRefs.push(`verification:${latest.id}`);
		if (!latest.command || latest.exitCode === null) {
			findings.push({
				code: "verification_missing_command_evidence",
				severity: "P2",
				message: "verification is missing the falsifier command or exit code",
				evidenceRef: `verification:${latest.id}`,
			});
		}
		const state = verificationIsOpen(latest, now);
		if (state === "closed") continue;
		if (state === "open") {
			findings.push({
				code: latest.status === "blocked" ? "falsifier_blocked_expired" : "falsifier_confirmed",
				severity: finding.severity,
				message:
					latest.status === "blocked"
						? `${finding.severity} falsifier is blocked and past its expiry`
						: `${finding.severity} falsifier confirms the finding`,
				evidenceRef: `verification:${latest.id}`,
			});
		} else {
			findings.push({
				code: "falsifier_blocked",
				severity: "P2",
				message: `${finding.severity} falsifier is blocked; verify gate cannot close it yet`,
				evidenceRef: `verification:${latest.id}`,
			});
		}
	}
	return gateResult("verify", findings, evidenceRefs, `P1/P2 findings: ${executableFindings.length}`);
}
