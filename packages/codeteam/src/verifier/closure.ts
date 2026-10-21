import type { ReviewFinding } from "../review/types.ts";
import type { FindingVerification, VerificationStatus } from "./types.ts";

export type FindingClosureStatus = "resolved" | "rejected" | "blocked" | "still_confirmed";

export interface FindingClosure {
	finding: ReviewFinding;
	initialStatus: VerificationStatus;
	finalStatus: VerificationStatus;
	status: FindingClosureStatus;
	reason: string;
}

function statusAt(verifications: FindingVerification[], index: number): VerificationStatus | undefined {
	return verifications.find((entry) => entry.audit.index === index)?.status;
}

/**
 * Close each finding against evidence from the revision where it was raised and
 * the revision after the fix. A confirmed finding is resolved only when the same
 * falsifier no longer confirms on the fixed revision.
 */
export function closeFindings(
	findings: ReviewFinding[],
	initial: FindingVerification[],
	final: FindingVerification[],
): FindingClosure[] {
	return findings.map((finding, index) => {
		const before = statusAt(initial, index);
		const after = statusAt(final, index);
		if (before === undefined || after === undefined) {
			return {
				finding,
				initialStatus: before ?? "blocked",
				finalStatus: after ?? "blocked",
				status: "blocked",
				reason: "missing verification result",
			};
		}
		if (before === "blocked" || after === "blocked") {
			return {
				finding,
				initialStatus: before,
				finalStatus: after,
				status: "blocked",
				reason: "verifier could not execute the falsifier",
			};
		}
		if (before === "rejected") {
			return {
				finding,
				initialStatus: before,
				finalStatus: after,
				status: "rejected",
				reason: "initial evidence did not support the finding",
			};
		}
		if (before === "confirmed" && after === "rejected") {
			return {
				finding,
				initialStatus: before,
				finalStatus: after,
				status: "resolved",
				reason: "the falsifier no longer confirms after the fix",
			};
		}
		return {
			finding,
			initialStatus: before,
			finalStatus: after,
			status: "still_confirmed",
			reason: "the falsifier still confirms after the fix",
		};
	});
}
