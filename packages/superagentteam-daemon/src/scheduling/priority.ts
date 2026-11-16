import type { BacklogPriority } from "../control/stores/types.ts";

export function backlogQueuePriority(priority: BacklogPriority): "urgent" | "normal" {
	return priority === "p0" || priority === "p1" ? "urgent" : "normal";
}

export function queuePriorityRank(priority: "urgent" | "normal"): number {
	return priority === "urgent" ? 0 : 1;
}
