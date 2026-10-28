import type { CustodyEvent, Handoff, HandoffHolderClaim } from "../control/stores/types.ts";

export type BlockedOnResolve = "completes" | "bounces_back_to_owner";

export interface CustodyBlocked {
	readonly onResolve: BlockedOnResolve;
	readonly ownerProfileId: string | null;
}

export interface CustodyProjection {
	readonly handoffId: string;
	readonly subjectRef: string;
	readonly generation: number;
	readonly status: Handoff["status"];
	readonly holderProfileIds: readonly string[];
	readonly blocked: CustodyBlocked | null;
	readonly expired: boolean;
	readonly completed: boolean;
	readonly lastSeq: number;
	readonly anomalies: readonly string[];
}

function profileFromActor(actorRef: string): string | null {
	return actorRef.startsWith("profile:") ? actorRef.slice("profile:".length) : null;
}

function blockedOnResolve(handoff: Handoff): BlockedOnResolve | null {
	if (handoff.kind !== "blocker") return null;
	const value = handoff.payload.blockedOnResolve;
	return value === "completes" || value === "bounces_back_to_owner" ? value : null;
}

export function projectCustody(
	handoff: Handoff,
	events: readonly CustodyEvent[],
	claims: readonly HandoffHolderClaim[] = [],
): CustodyProjection {
	const anomalies: string[] = [];
	const sorted = [...events].sort((left, right) => left.seq - right.seq);
	const holders = new Set<string>();
	let status: Handoff["status"] = "pending";
	let lastSeq = 0;

	for (const event of sorted) {
		if (event.handoffId !== handoff.id) anomalies.push(`event ${event.id} belongs to another handoff`);
		if (event.generation !== handoff.generation) {
			anomalies.push(`event ${event.id} generation ${event.generation} != ${handoff.generation}`);
		}
		if (event.seq !== lastSeq + 1) anomalies.push(`event ${event.id} seq ${event.seq} is not contiguous`);
		lastSeq = Math.max(lastSeq, event.seq);
		const actorProfile = profileFromActor(event.actorRef);
		switch (event.kind) {
			case "handoff.created":
				if (status !== "pending" || holders.size > 0) anomalies.push(`created event after live state`);
				status = "pending";
				break;
			case "handoff.dispatched":
				if (status !== "pending" && status !== "claimed") anomalies.push(`dispatched after terminal state`);
				break;
			case "handoff.claimed":
				if (!actorProfile) {
					anomalies.push(`claimed event ${event.id} has no profile actor`);
				} else {
					holders.add(actorProfile);
				}
				status = "claimed";
				break;
			case "handoff.returned": {
				if (!actorProfile) anomalies.push(`returned event ${event.id} has no profile actor`);
				else holders.delete(actorProfile);
				if (holders.size === 0 && status !== "consumed" && status !== "withdrawn" && status !== "expired") {
					status = "pending";
				}
				break;
			}
			case "handoff.replaced": {
				const previous =
					typeof event.payload.previousProfileId === "string" ? event.payload.previousProfileId : null;
				const replacement =
					typeof event.payload.replacementProfileId === "string" ? event.payload.replacementProfileId : null;
				if (previous) holders.delete(previous);
				if (replacement) holders.add(replacement);
				if (holders.size > 0 && status !== "consumed" && status !== "withdrawn" && status !== "expired") {
					status = "claimed";
				}
				break;
			}
			case "handoff.completion_candidate":
				break;
			case "handoff.completed":
				status = "consumed";
				holders.clear();
				break;
			case "handoff.parallel_unfinished":
				break;
			case "handoff.withdrawn":
				status = "withdrawn";
				holders.clear();
				break;
			case "handoff.expired":
				status = "expired";
				holders.clear();
				break;
			case "handoff.recovered": {
				const active = Array.isArray(event.payload.activeProfileIds)
					? event.payload.activeProfileIds.filter((value): value is string => typeof value === "string")
					: [];
				holders.clear();
				for (const profileId of active) holders.add(profileId);
				if (status !== "consumed" && status !== "withdrawn" && status !== "expired") {
					status = holders.size > 0 ? "claimed" : "pending";
				}
				break;
			}
		}
	}

	const activeClaims = claims.filter((claim) => claim.status === "active").map((claim) => claim.profileId);
	const claimHolders = [...new Set(activeClaims)].sort();
	const projectedHolders = [...holders].sort();
	if (claimHolders.length > 0 && projectedHolders.join(",") !== claimHolders.join(",")) {
		anomalies.push(`custody events project holders [${projectedHolders}] but claims are [${claimHolders}]`);
	}
	if (status !== handoff.status) {
		anomalies.push(`custody events project status ${status} but handoff is ${handoff.status}`);
	}
	if (handoff.status === "pending" && projectedHolders.length > 0) {
		anomalies.push("handoff is pending but custody events still project holders");
	}
	if (handoff.status === "claimed" && projectedHolders.length === 0 && claimHolders.length === 0) {
		anomalies.push("handoff is claimed but no holder is projected");
	}

	const onResolve = blockedOnResolve(handoff);
	if (handoff.kind === "blocker" && !onResolve) {
		anomalies.push("blocker handoff is missing blockedOnResolve");
	}
	const blocked =
		onResolve && (handoff.status === "pending" || handoff.status === "claimed")
			? { onResolve, ownerProfileId: handoff.predecessorProfileId }
			: null;

	return {
		handoffId: handoff.id,
		subjectRef: handoff.subjectRef,
		generation: handoff.generation,
		status,
		holderProfileIds: projectedHolders,
		blocked,
		expired: status === "expired",
		completed: status === "consumed",
		lastSeq,
		anomalies,
	};
}
