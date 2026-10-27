import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	assessInvocationLiveness,
	ControlError,
	type ControlStore,
	extractInvocationToken,
	formatInvocationToken,
	mintInvocationCredential,
	openControlStore,
	resolveInvocationToken,
	resolveInvocationTokenDir,
	revokeCredentialsForRun,
	sweepCredentialTombstones,
} from "../src/index.ts";

const NOW = 1_700_000_000_000;

const dirs: string[] = [];
let dataDir: string;
let now: number;
let store: ControlStore;
let sequence = 0;

function seed() {
	store.seedIdentity({
		eval: { provider: "test", model: "eval-model", modelFamily: "eval-family" },
		compress: { provider: "test", model: "compress-model", modelFamily: "test-family" },
	});
	store.profiles.create({
		id: "profile-coder",
		role: "coder",
		displayName: "Coder",
		provider: "test",
		model: "model",
		modelFamily: "family",
		toolPolicyProfile: "default",
	});
}

function baseRun() {
	sequence += 1;
	const suffix = String(sequence);
	const backlog = store.backlog.create({
		id: `backlog-${suffix}`,
		userId: "user-1",
		title: "Backlog",
		summary: "Summary",
		priority: "p1",
		tags: ["feature:F005"],
		createdByKind: "user",
		createdById: "user-1",
	});
	const thread = store.threads.create({ id: `thread-${suffix}`, title: "Thread" });
	const task = store.tasks.create({
		id: `task-${suffix}`,
		kind: "work",
		threadId: thread.id,
		title: "Task",
		why: "Why",
		ownerProfileId: "profile-coder",
		createdBy: "user",
		userId: "user-1",
		backlogItemId: backlog.id,
	});
	const session = store.sessions.create({
		id: `session-${suffix}`,
		threadId: thread.id,
		taskId: task.id,
		profileId: "profile-coder",
		role: "coder",
		effectiveToolPolicy: "default",
		provider: "test",
		model: "model",
		modelFamily: "family",
		seq: 0,
	});
	const source = store.messages.append({
		threadId: thread.id,
		authorKind: "user",
		authorId: "user-1",
		kind: "chat",
		bodyMd: "source",
	});
	const queue = store.queue.admit({
		threadId: thread.id,
		sourceId: source.id,
		sourceKind: "conversation_input",
		targets: ["profile-coder"],
		sourceCategory: "a2a",
		orderKey: suffix,
	});
	const run = store.runs.create({
		id: `run-${suffix}`,
		taskId: task.id,
		queueEntryId: queue.id,
		role: "coder",
		agentSessionId: session.id,
		sourceId: source.id,
		recipientProfileId: "profile-coder",
		provider: "test",
		model: "model",
		modelFamily: "family",
	});
	return { backlog, thread, task, session, source, queue, run };
}

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "codeteam-auth-"));
	dirs.push(dataDir);
	now = NOW;
	store = openControlStore({ dataDir, clock: () => now });
	seed();
});

afterEach(() => {
	store.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("codeteam per-run invocation credentials", () => {
	it("mints an active credential, writes a 0600 token file, and resolves the binding", () => {
		const run = baseRun();
		const tokenDir = resolveInvocationTokenDir(dataDir);
		const minted = mintInvocationCredential(store, {
			runId: run.run.id,
			callbackAllowlist: ["team.read", "workitem.read"],
			tokenDir,
		});

		expect(minted.credential.state).toBe("active");
		expect(minted.credential.callbackAllowlist).toEqual(["team.read", "workitem.read"]);
		expect(minted.token.startsWith("ct1.")).toBe(true);
		expect(minted.tokenPath).not.toBeNull();
		expect(statSync(tokenDir).mode & 0o777).toBe(0o700);
		expect(statSync(minted.tokenPath!).mode & 0o777).toBe(0o600);

		const binding = resolveInvocationToken(store, minted.token, { now });
		expect(binding).toEqual({
			credentialId: minted.credential.id,
			runId: run.run.id,
			taskId: run.task.id,
			role: "coder",
			agentSessionId: run.session.id,
			agentProfileId: "profile-coder",
			threadId: run.thread.id,
			userId: "user-1",
			ownerAuthProvenance: "strict",
			callbackAllowlist: ["team.read", "workitem.read"],
		});
	});

	it("rejects malformed, unknown, and wrong-secret tokens", () => {
		const run = baseRun();
		const minted = mintInvocationCredential(store, { runId: run.run.id });
		const lastDot = minted.token.lastIndexOf(".");
		const tampered = `${minted.token.slice(0, lastDot + 1)}wrong-secret`;

		expect(() => resolveInvocationToken(store, "not-a-token")).toThrow(ControlError);
		expect(() => resolveInvocationToken(store, formatInvocationToken("missing", "secret"))).toThrow(ControlError);
		expect(() => resolveInvocationToken(store, tampered)).toThrow(ControlError);
	});

	it("rejects terminal and expired credentials", () => {
		const run = baseRun();
		const minted = mintInvocationCredential(store, { runId: run.run.id, expiresAt: NOW + 1_000 });
		expect(() => resolveInvocationToken(store, minted.token, { now: NOW + 2_000 })).toThrow(ControlError);

		store.credentials.terminalize(minted.credential.id, "completed");
		expect(() => resolveInvocationToken(store, minted.token, { now })).toThrow(ControlError);
	});

	it("keeps two runs' tokens isolated", () => {
		const first = baseRun();
		const second = baseRun();
		const tokenA = mintInvocationCredential(store, { runId: first.run.id }).token;
		const tokenB = mintInvocationCredential(store, { runId: second.run.id }).token;

		const bindingA = resolveInvocationToken(store, tokenA, { now });
		const bindingB = resolveInvocationToken(store, tokenB, { now });
		expect(bindingA.runId).toBe(first.run.id);
		expect(bindingB.runId).toBe(second.run.id);
		expect(bindingA.credentialId).not.toBe(bindingB.credentialId);
	});

	it("accepts tokens only from the Authorization header", () => {
		const token = "ct1.cred.secret";
		expect(extractInvocationToken({ headers: { authorization: `Bearer ${token}` } })).toBe(token);
		expect(extractInvocationToken({ headers: { Authorization: `Bearer ${token}` } })).toBe(token);
		expect(extractInvocationToken({ headers: { authorization: [`Bearer ${token}`] } })).toBe(token);
		expect(() => extractInvocationToken({ headers: {} })).toThrow(ControlError);
		expect(() => extractInvocationToken({ headers: { authorization: "Basic abc" } })).toThrow(ControlError);
		expect(() =>
			extractInvocationToken({ headers: { authorization: `Bearer ${token}` }, queryToken: token }),
		).toThrow(ControlError);
		expect(() => extractInvocationToken({ headers: { authorization: `Bearer ${token}` }, bodyToken: token })).toThrow(
			ControlError,
		);
	});

	it("assesses liveness without revoking on unknown evidence", () => {
		const run = baseRun();
		const { credential } = mintInvocationCredential(store, { runId: run.run.id });

		expect(assessInvocationLiveness(credential, { runId: run.run.id, workerAlive: true, now: NOW + 3_600_000 })).toBe(
			"active",
		);
		expect(assessInvocationLiveness(credential, { runId: run.run.id, workerAlive: null, now: NOW + 3_600_000 })).toBe(
			"candidate",
		);
		expect(
			assessInvocationLiveness(credential, {
				runId: run.run.id,
				workerAlive: false,
				lastRunEventAt: NOW - 3_600_000,
				now,
			}),
		).toBe("stale_invocation");
		expect(
			assessInvocationLiveness(credential, {
				runId: "other-run",
				workerAlive: false,
				lastRunEventAt: NOW - 3_600_000,
				now,
			}),
		).toBe("candidate");
		expect(
			assessInvocationLiveness(credential, {
				runId: run.run.id,
				workerAlive: false,
				lastRunEventAt: NOW - 1_000,
				staleAfterMs: 60_000,
				now,
			}),
		).toBe("candidate");
	});

	it("revokes the run credential on terminal and is idempotent", () => {
		const run = baseRun();
		const minted = mintInvocationCredential(store, { runId: run.run.id });

		const revoked = revokeCredentialsForRun(store, run.run.id, "interrupted");
		expect(revoked?.state).toBe("terminal");
		expect(revoked?.disposition).toBe("interrupted");
		expect(() => resolveInvocationToken(store, minted.token, { now })).toThrow(ControlError);
		expect(revokeCredentialsForRun(store, run.run.id, "interrupted")).toBeNull();
	});

	it("sweeps terminal tombstones older than 30 days and keeps active credentials", () => {
		const active = baseRun();
		const terminal = baseRun();
		mintInvocationCredential(store, { runId: active.run.id });
		const minted = mintInvocationCredential(store, { runId: terminal.run.id });
		revokeCredentialsForRun(store, terminal.run.id, "completed");

		expect(sweepCredentialTombstones(store, { now })).toBe(0);
		const later = NOW + 31 * 24 * 60 * 60 * 1000;
		expect(sweepCredentialTombstones(store, { now: later })).toBe(1);
		expect(store.credentials.get(minted.credential.id)).toBeNull();
		expect(store.credentials.getByRun(active.run.id)?.state).toBe("active");
	});

	it("refuses to mint a credential for a non-running run", () => {
		const run = baseRun();
		store.runs.terminal(run.run.id, { status: "completed" });
		expect(() => mintInvocationCredential(store, { runId: run.run.id })).toThrow(ControlError);
	});
});
