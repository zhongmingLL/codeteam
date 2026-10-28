import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ControlStore, openControlStore } from "../../src/index.ts";

export interface W5AFixture {
	readonly store: ControlStore;
	readonly dataDir: string;
	now(): number;
	advance(ms: number): number;
	cleanup(): void;
	createRun(input: {
		id: string;
		profileId: string;
		role: string;
		sessionId: string;
		sourceId: string;
		status?: "running" | "completed" | "canceled" | "interrupted" | "failed";
		chainMetadata?: Record<string, unknown>;
	}): ReturnType<ControlStore["runs"]["create"]>;
	createSourceMessage(bodyMd?: string): ReturnType<ControlStore["messages"]["append"]>;
}

export function createW5AFixture(): W5AFixture {
	const dataDir = mkdtempSync(join(tmpdir(), "codeteam-w5a-"));
	let current = 1_700_000_000_000;
	const store = openControlStore({ dataDir, clock: () => current });
	store.seedIdentity({
		eval: { provider: "test", model: "eval-model", modelFamily: "test-family" },
		compress: { provider: "test", model: "compress-model", modelFamily: "test-family" },
	});
	store.backlog.create({
		id: "backlog-1",
		userId: "user-1",
		title: "W5a fixture",
		summary: "W5a fixture",
		priority: "p1",
		tags: ["feature:F008"],
		createdByKind: "user",
		createdById: "user-1",
	});
	store.threads.create({ id: "thread-1", title: "W5a" });
	const profiles = [
		{ id: "profile:coder", role: "coder", displayName: "Coder" },
		{ id: "profile:reviewer-a", role: "reviewer", displayName: "Reviewer A" },
		{ id: "profile:reviewer-b", role: "reviewer", displayName: "Reviewer B" },
		{ id: "profile:verifier", role: "verifier", displayName: "Verifier" },
	] as const;
	for (const profile of profiles) {
		store.profiles.create({
			id: profile.id,
			role: profile.role,
			displayName: profile.displayName,
			provider: "test",
			model: `model-${profile.role}`,
			modelFamily: "test-family",
			toolPolicyProfile: "default",
		});
	}
	store.tasks.create({
		id: "task-1",
		kind: "work",
		threadId: "thread-1",
		title: "W5a",
		why: "W5a",
		ownerProfileId: "profile:coder",
		createdBy: "user-1",
		userId: "user-1",
		backlogItemId: "backlog-1",
	});
	for (const profile of profiles) {
		store.sessions.create({
			id: `session-${profile.role}${profile.id.endsWith("-a") ? "-a" : profile.id.endsWith("-b") ? "-b" : ""}`,
			threadId: "thread-1",
			taskId: "task-1",
			profileId: profile.id,
			role: profile.role,
			effectiveToolPolicy: "default",
			provider: "test",
			model: `model-${profile.role}`,
			modelFamily: "test-family",
			seq: 0,
			userId: "user-1",
		});
	}
	const createSourceMessage = (bodyMd = "source") =>
		store.messages.append({
			threadId: "thread-1",
			taskId: "task-1",
			authorKind: "user",
			authorId: "user-1",
			kind: "chat",
			bodyMd,
		});
	return {
		store,
		dataDir,
		now: () => current,
		advance: (ms) => {
			current += ms;
			return current;
		},
		cleanup: () => {
			store.close();
			rmSync(dataDir, { recursive: true, force: true });
		},
		createRun: (input) => {
			const run = store.runs.create({
				id: input.id,
				taskId: "task-1",
				role: input.role,
				agentSessionId: input.sessionId,
				sourceId: input.sourceId,
				recipientProfileId: input.profileId,
				provider: "test",
				model: `model-${input.role}`,
				modelFamily: "test-family",
				chainMetadata: input.chainMetadata,
			});
			if (input.status && input.status !== "running") {
				store.runs.terminal(run.id, { status: input.status });
				return store.runs.get(run.id)!;
			}
			return run;
		},
		createSourceMessage,
	};
}
