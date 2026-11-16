import type { W5AFixture } from "./w5a-fixture.ts";

export interface WorkSeed {
	readonly workId: string;
	readonly attemptId: string;
}

const UNKNOWN_CHECKS = {
	remoteMainSynced: "unknown" as const,
	qualityGatePassed: "unknown" as const,
	reviewApproved: "unknown" as const,
	visionGuardDone: "unknown" as const,
};

export function seedWork(base: W5AFixture, backlogItemId = "backlog-1", featureId = "F008"): WorkSeed {
	const backlog = base.store.backlog.get(backlogItemId);
	if (!backlog) throw new Error(`backlog ${backlogItemId} not found`);
	base.store.sops.upsert({
		backlogItemId,
		featureId,
		stage: "impl",
		batonHolder: "profile:coder",
		resumeCapsule: { goal: "ship W5d", done: [], currentFocus: "managed work" },
		checks: UNKNOWN_CHECKS,
		updatedBy: "profile:coder",
	});
	return base.store.sops.workIdentity(backlogItemId, backlog.userId);
}

export function addCoderProfile(base: W5AFixture, id = "profile:coder-b"): { profileId: string; sessionId: string } {
	base.store.profiles.create({
		id,
		role: "coder",
		displayName: "Coder B",
		provider: "test",
		model: "model-coder",
		modelFamily: "test-family",
		toolPolicyProfile: "default",
	});
	const sessionId = `session-${id.replace(/[^a-z0-9]+/gi, "-")}`;
	base.store.sessions.create({
		id: sessionId,
		threadId: "thread-1",
		taskId: "task-1",
		profileId: id,
		role: "coder",
		effectiveToolPolicy: "default",
		provider: "test",
		model: "model-coder",
		modelFamily: "test-family",
		seq: 0,
		userId: "user-1",
	});
	return { profileId: id, sessionId };
}

export function createSecondBacklog(base: W5AFixture, id = "backlog-2"): WorkSeed {
	base.store.backlog.create({
		id,
		userId: "user-1",
		title: "W5d second backlog",
		summary: "second managed work identity",
		priority: "p2",
		tags: ["feature:F008"],
		createdByKind: "user",
		createdById: "user-1",
	});
	return seedWork(base, id);
}
