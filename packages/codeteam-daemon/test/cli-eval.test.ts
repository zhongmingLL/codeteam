import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendEvalLifecycleEvent,
	type EvalDomainRegistryEntry,
	initOperatorCredential,
	openControlStore,
	publishEvalVerdict,
} from "../src/index.ts";
import { makeMeasurement, makeVerdictPacket } from "./helpers/eval-fixture.ts";

const CLI = join(process.cwd(), "dist", "cli.js");
const dirs: string[] = [];
let dataDir: string;
let caseId: string;
let escalatedCaseId: string;

function rawCli(args: readonly string[]) {
	return spawnSync(process.execPath, [CLI, "--data-dir", dataDir, ...args], {
		encoding: "utf8",
		env: { ...process.env, CODETEAM_DATA_DIR: dataDir },
	});
}

function cliJson<T>(args: readonly string[]): T {
	const result = rawCli([...args, "--json"]);
	if (result.status !== 0) {
		throw new Error(
			`cli ${args.join(" ")} exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
		);
	}
	const line = result.stdout.split(/\r?\n/).find((candidate) => candidate.trim() !== "");
	if (!line) throw new Error(`cli ${args.join(" ")} produced no JSON`);
	return JSON.parse(line) as T;
}

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "codeteam-cli-eval-"));
	dirs.push(dataDir);
	initOperatorCredential({ dataDir });
	const store = openControlStore({ dataDir });
	store.seedIdentity({
		eval: { profileId: "profile:eval", provider: "eval-provider", model: "eval-model", modelFamily: "glm" },
		compress: { provider: "test", model: "glm-compress", modelFamily: "glm" },
	});
	store.profiles.create({
		id: "profile:owner",
		role: "coder",
		displayName: "Owner",
		provider: "owner-provider",
		model: "glm-owner",
		modelFamily: "glm",
		toolPolicyProfile: "default",
	});
	store.threads.create({ id: "thread:eval-domain", title: "Eval" });
	const entry: EvalDomainRegistryEntry = {
		domainId: "eval:test-domain",
		displayName: "Test domain",
		systemThreadId: "thread:eval-domain",
		evalAgent: { profileId: "profile:eval", role: "eval", handle: "eval", model: "eval-model" },
		frequency: "daily",
		triggerPolicy: { mode: "time_only", maxDetectionDelayHours: 24 },
		sourceAdapter: "task_outcome",
		sourceRefsKind: "task",
		handoffTargetResolver: { featureId: "F014", ownerProfileId: "profile:owner", threadLookup: "feature-thread" },
		sla: { acknowledgeHours: 24, reevalWithinHours: 168 },
		enabled: true,
	};
	const createdAt = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
	const packet = makeVerdictPacket({
		id: "verdict-cli-sunset",
		findingKey: "cli-sunset-1",
		verdict: "delete_sunset",
		createdAt,
		governance: { cvoAcceptRequired: true },
		acceptanceReevalPlan: {
			nextEvalAt: new Date(Date.parse(createdAt) + 7 * 24 * 60 * 60 * 1000).toISOString(),
			closureCondition: "trial criteria met",
		},
		evidencePacket: {
			snapshotRefs: ["snapshot:cli"],
			attributionRefs: ["attribution:cli"],
			metricRefs: ["metric:cli"],
			sampleTraceRefs: ["inv:cli"],
		},
	});
	const published = publishEvalVerdict(store, {
		entry,
		packet,
		measurement: makeMeasurement(packet, {
			cohort: {
				ref: "cohort:cli",
				sha256: "d".repeat(64),
				window: { startMs: Date.parse(createdAt), endMs: Date.parse(createdAt) + 1000 },
			},
		}),
		actor: { kind: "agent", id: "profile:eval" },
	});
	caseId = published.case!.caseId;
	const observation = makeVerdictPacket({
		id: "verdict-cli-observation",
		findingKey: undefined,
		verdict: "keep_observe",
	});
	publishEvalVerdict(store, {
		entry,
		packet: observation,
		measurement: makeMeasurement(observation),
		actor: { kind: "agent", id: "profile:eval" },
	});
	const escalatedPacket = makeVerdictPacket({
		id: "verdict-cli-escalated",
		findingKey: "cli-escalated-1",
	});
	const escalated = publishEvalVerdict(store, {
		entry,
		packet: escalatedPacket,
		measurement: makeMeasurement(escalatedPacket),
		actor: { kind: "agent", id: "profile:eval" },
	});
	escalatedCaseId = escalated.case!.caseId;
	appendEvalLifecycleEvent(store, {
		caseId: escalatedCaseId,
		expectedSequence: 1,
		type: "sla_escalated",
		actor: { kind: "system", id: "sla-reconciler" },
		reason: "SLA missed",
	});
	store.close();
});

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("W6b eval CLI", () => {
	it("lists/open/overdues/shows a delete_sunset verdict awaiting operator accept", () => {
		const all = cliJson<Array<{ caseId: string; status: string; awaitingSunsetDecision: boolean; overdue: boolean }>>(
			["eval", "list"],
		);
		expect(all).toHaveLength(2);
		expect(all.find((item) => item.caseId === caseId)).toMatchObject({
			caseId,
			status: "open",
			awaitingSunsetDecision: true,
			overdue: true,
		});
		const open = cliJson<Array<{ caseId: string }>>(["eval", "open"]);
		expect(open.map((item) => item.caseId).sort()).toEqual([caseId, escalatedCaseId].sort());
		const overdue = cliJson<Array<{ caseId: string }>>(["eval", "overdue"]);
		expect(overdue.map((item) => item.caseId).sort()).toEqual([caseId, escalatedCaseId].sort());
		const detail = cliJson<{
			case: { status: string; awaitingSunsetDecision: boolean };
			verdict: { id: string; status: string };
			message: { bodyMd: string };
			artifacts: Array<{ kind: string }>;
			lifecycleRoot: { verdict: string };
		}>(["eval", "show", "verdict-cli-sunset"]);
		expect(detail.case).toMatchObject({ status: "open", awaitingSunsetDecision: true });
		expect(detail.verdict).toMatchObject({ id: "verdict-cli-sunset", status: "ok" });
		expect(detail.message.bodyMd).toContain("awaiting operator accept");
		expect(detail.artifacts.map((artifact) => artifact.kind)).toContain("eval-lifecycle-root");
		expect(detail.lifecycleRoot.verdict).toBe("delete_sunset");
		const observation = cliJson<{ case: null; verdict: { id: string } }>(["eval", "show", "verdict-cli-observation"]);
		expect(observation.case).toBeNull();
		expect(observation.verdict.id).toBe("verdict-cli-observation");
	});

	it("accepts sunset as operator and never deletes the harness", () => {
		const accepted = cliJson<{ case: { status: string; awaitingSunsetDecision: boolean }; event: { type: string } }>([
			"eval",
			"accept-sunset",
			"verdict-cli-sunset",
			"--reason",
			"sunset trial accepted",
		]);
		expect(accepted.case.status).toBe("resolved");
		expect(accepted.case.awaitingSunsetDecision).toBe(false);
		expect(accepted.event.type).toBe("sunset_accepted");
		const open = cliJson<Array<{ caseId: string }>>(["eval", "open"]);
		expect(open.map((item) => item.caseId)).toEqual([escalatedCaseId]);
		const detail = cliJson<{ case: { status: string } }>(["eval", "show", caseId]);
		expect(detail.case.status).toBe("resolved");
		const second = rawCli(["eval", "accept-sunset", "verdict-cli-sunset", "--reason", "again"]);
		expect(second.status).not.toBe(0);
	});
});
