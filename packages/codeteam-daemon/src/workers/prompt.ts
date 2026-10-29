import type { AgentProfile, AgentSession, Handoff, Message, Task } from "../control/stores/types.ts";

const ROLE_GUIDANCE: Record<string, string> = {
	coder: `You are the coder for one codeteam task. Work only in the assigned worktree. Make the smallest change that satisfies the task, run the relevant checks, and report exactly what changed and what you verified. Do not claim completion without command output.`,
	reviewer: `You are an independent reviewer for one codeteam task. Read the source message and the actual change evidence; do not trust the author's summary. State a clear stance (approve or changes requested) with severity for each finding. Do not modify the reviewed worktree.`,
	verifier: `You are the verifier for one codeteam task. Independently run the acceptance checks in the evidence worktree, record exact commands and outputs, and state whether the result is verified or still unproven.`,
};

export interface WorkerPromptInput {
	readonly task: Task;
	readonly session: AgentSession;
	readonly sourceMessage: Message;
	readonly continuityCapsule?: unknown;
	readonly degradedContinuity?: string | null;
	readonly peers?: readonly AgentProfile[];
	readonly handoff?: Handoff | null;
}

export function buildWorkerSystemPrompt(role: string): string {
	const guidance = ROLE_GUIDANCE[role] ?? ROLE_GUIDANCE.reviewer;
	const a2aGuidance =
		role === "coder" || role === "architect"
			? "Use handoff_create when you need another role to take responsibility; use a2a_send for discussion."
			: "When this run is assigned a handoff, call handoff_claim before the work and handoff_complete with evidence; use a2a_send for discussion.";
	return [
		"## codeteam worker contract",
		guidance,
		"",
		"- Tool policy is enforced by the codeteam worker extension. A blocked tool is final; do not try to bypass it with another tool.",
		"- If the control plane is unavailable, mutating tools are denied while read-only tools may continue.",
		`- ${a2aGuidance} Text @ is a visible marker, not a route.`,
		"- A2A targets are AgentProfile ids. If you are assigned a handoff, call handoff_claim before doing the work.",
		"- handoff_complete records a candidate only. Server-owned evidence decides the verified terminal; never claim that you verified it yourself.",
		"- Return a concise final response. Include evidence (commands, paths, SHAs) when relevant.",
	].join("\n");
}

export function buildWorkerPrompt(input: WorkerPromptInput): string {
	const sections = [
		`# Task ${input.task.id}`,
		`Title: ${input.task.title}`,
		`Why: ${input.task.why}`,
		`Role: ${input.session.role}`,
	];
	if (input.task.worktree) sections.push(`Worktree: ${input.task.worktree}`);
	if (input.task.branch) sections.push(`Branch: ${input.task.branch}`);
	if (input.task.baseSha) sections.push(`Base: ${input.task.baseSha}`);
	if (input.peers && input.peers.length > 0) {
		sections.push("", "## Peers");
		for (const peer of input.peers) {
			const restrictions =
				peer.restrictions && Object.keys(peer.restrictions).length > 0
					? ` restrictions=${JSON.stringify(peer.restrictions)}`
					: "";
			sections.push(
				`- ${peer.id} @${peer.displayName} role=${peer.role} modelFamily=${peer.modelFamily}${restrictions}`,
			);
		}
	}
	if (input.handoff) {
		const handoff = input.handoff;
		sections.push(
			"",
			"## Assigned handoff",
			`Handoff ID: ${handoff.id}`,
			`Subject: ${handoff.subject}`,
			`Action: ${handoff.actionFamily} / ${handoff.successorSlot}`,
			`Mode: ${handoff.mode}`,
			`Status: ${handoff.status}`,
			`Expected artifact: ${handoff.expectedArtifact}`,
			`Terminal predicate: ${JSON.stringify(handoff.terminalPredicate)}`,
		);
	}
	if (input.degradedContinuity) {
		sections.push(
			"",
			"## Continuity degraded",
			`${input.degradedContinuity} The previous pi session could not be re-attached; continue from the task capsule below and say what context may be missing.`,
		);
	}
	const capsule = capsuleText(input.continuityCapsule);
	if (capsule) sections.push("", "## Continuity capsule", capsule);
	else if (input.degradedContinuity) {
		sections.push(
			"",
			"## Continuity capsule",
			`No stored continuity capsule was available. Task capsule: ${input.task.title} — ${input.task.why}`,
		);
	}
	sections.push("", "## Source message", input.sourceMessage.bodyMd.trim() || "(empty source message)");
	sections.push(
		"",
		"## Delivery contract",
		"- Execute this run only.",
		"- Report the concrete result; do not fabricate verification.",
		"- If blocked, say exactly what is missing and what you tried.",
	);
	return sections.join("\n");
}

function capsuleText(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value.trim();
	if (typeof value !== "object") return "";
	try {
		return JSON.stringify(value, null, 2).trim();
	} catch {
		return "";
	}
}
