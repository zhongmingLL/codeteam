import type {
	EvidenceKind,
	RecallResult,
	RetrievalRequest,
	RetrievalTrigger,
	RetrievalTriggerInput,
	TriggerRecallResult,
} from "./contract.ts";

interface TriggerSpec {
	readonly kinds: readonly EvidenceKind[];
	readonly rationale: string;
	readonly maxItems: number;
}

const TRIGGERS: Record<RetrievalTrigger, TriggerSpec> = {
	kickoff: {
		kinds: ["feature", "plan", "decision", "architecture", "lesson", "task", "merge"],
		rationale: "project conventions, related prior tasks and known pitfalls",
		maxItems: 6,
	},
	design: {
		kinds: ["architecture", "decision", "plan", "feature", "lesson"],
		rationale: "architecture, decisions and affected modules",
		maxItems: 6,
	},
	impl: {
		kinds: ["architecture", "decision", "plan", "feature", "lesson", "task", "artifact"],
		rationale: "current files, related tests, recent diffs and coding conventions",
		maxItems: 8,
	},
	review: {
		kinds: ["review", "verification", "feature", "plan", "decision", "lesson"],
		rationale: "acceptance criteria, impact surface and prior finding patterns",
		maxItems: 8,
	},
	verify: {
		kinds: ["verification", "review", "artifact", "plan", "feature"],
		rationale: "verification commands, environment constraints and regression samples",
		maxItems: 6,
	},
	merge: {
		kinds: ["merge", "review", "verification", "plan", "feature", "artifact"],
		rationale: "risk list and rollback plan",
		maxItems: 6,
	},
	completion: {
		kinds: ["task", "artifact", "merge", "review", "verification", "feature", "plan", "lesson"],
		rationale: "delivery evidence, residual gaps and lessons",
		maxItems: 8,
	},
};

function fileTokens(files: readonly string[] | undefined): string[] {
	if (!files) return [];
	const tokens = new Set<string>();
	for (const file of files) {
		for (const part of file.split(/[\\/]/)) {
			for (const token of part.split(/[._-]/)) {
				if (token.length >= 3) tokens.add(token);
			}
		}
	}
	return [...tokens];
}

export function buildTriggerRequest(trigger: RetrievalTrigger, input: RetrievalTriggerInput = {}): RetrievalRequest {
	const spec = TRIGGERS[trigger];
	const parts = [
		input.query,
		input.taskTitle,
		input.taskWhy,
		input.featureId,
		input.risk,
		...fileTokens(input.files),
	].filter((part): part is string => typeof part === "string" && part.trim() !== "");
	const query = [...new Set(parts.map((part) => part.trim()))].join(" ");
	return {
		trigger,
		query: query === "" ? trigger : query,
		kinds: spec.kinds,
		limit: Math.min(Math.max(input.limit ?? spec.maxItems, 1), 20),
		rationale: spec.rationale,
	};
}

export function renderTriggerContext(result: RecallResult, maxChars = 6000): string {
	const lines: string[] = [];
	for (const item of result.items) {
		const stale = item.stale ? ` [stale: ${item.staleReasons.join(",")}]` : "";
		lines.push(`- ${item.title} [${item.source.ref}] (${item.kind}, ${item.status})${stale}`);
		const excerpt = item.passage.replace(/\s+/g, " ").trim();
		if (excerpt !== "") lines.push(`  ${excerpt.length > 240 ? `${excerpt.slice(0, 237)}...` : excerpt}`);
	}
	if (lines.length === 0) {
		lines.push(
			`- no indexed evidence in scope (indexStatus=${result.coverage.indexStatus}; reasons=${result.coverage.reasons.join(",") || "none"})`,
		);
	}
	const header = `## Evidence (${result.coverage.scope}; indexStatus=${result.coverage.indexStatus})\n`;
	const body = `${header}${lines.join("\n")}`;
	return body.length > maxChars ? `${body.slice(0, maxChars - 3)}...` : body;
}

export function triggerKinds(trigger: RetrievalTrigger): readonly EvidenceKind[] {
	return TRIGGERS[trigger].kinds;
}

export function retrieveForTrigger(
	trigger: RetrievalTrigger,
	input: RetrievalTriggerInput,
	search: (options: { query: string; kinds: readonly EvidenceKind[]; limit: number }) => RecallResult,
): TriggerRecallResult {
	const request = buildTriggerRequest(trigger, input);
	const result = search({ query: request.query, kinds: request.kinds, limit: request.limit });
	return { trigger, request, result, contextBlock: renderTriggerContext(result) };
}
