import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type EvalDomainRegistryEntry,
	initOperatorCredential,
	openControlStore,
	publishEvalVerdict,
	type VerdictHandoffPacketV1,
} from "../src/index.ts";

const CLI = join(process.cwd(), "dist", "cli.js");
const dirs: string[] = [];
let dataDir: string;
let caseId: string;

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
		eval: { profileId: "profile:eval", provider: "eval-provider", model: "glm-eval", modelFamily: "glm" },
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
		systemThreadId: "thread:eval-domain",
		evalAgent: "profile:eval",
		frequency: "daily",
		triggerPolicy: { kind: "time_only", maxDetectionDelayHours: 24 },
		sourceAdapter: "task_outcome",
		sourceRefsKind: "task",
		sla: { acknowledgementHours: 24, reevaluationHours: 168 },
		enabled: true,
	};
	const createdAt = Date.now() - 100 * 60 * 60 * 1000;
	const packet: VerdictHandoffPacketV1 = {
		v: 1,
		id: "verdict-cli-sunset",
		domainId: "eval:test-domain",
		bundleId: "bundle-cli",
		createdAt,
		phenomenon: "candidate harness has low marginal effect",
		harnessUnderEval: { featureId: "F014", componentId: "eval", name: "demo harness" },
		evidencePacket: {
			sourceRefs: ["task:task-cli"],
			summary: "no activation in the window",
			measurement: {
				status: "ok",
				method: "fixture",
				windowStartMs: createdAt,
				windowEndMs: createdAt + 1000,
				measurementRef: "measurement:cli",
				reasons: [],
			},
		},
		rootCauseHypothesis: "model internalized the behavior",
		verdict: "delete_sunset",
		findingKey: "cli-sunset-1",
		findings: [{ severity: "P2", claim: "low use", evidenceRefs: ["task:task-cli"] }],
		ownerAsk: {
			targetFeatureId: "F014",
			targetOwnerProfileId: "profile:owner",
			requestedAction: "start sunset trial",
		},
		acceptanceReevalPlan: { nextEvalAt: createdAt + 7 * 24 * 60 * 60 * 1000, closureCondition: "trial criteria met" },
		counterarguments: ["sample is small"],
		governance: { cvoAcceptRequired: true, cvoSuppressed: false },
	};
	const published = publishEvalVerdict(store, {
		entry,
		packet,
		actor: { kind: "eval", id: "profile:eval" },
		dataDir,
	});
	caseId = published.case!.caseId;
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
		expect(all).toHaveLength(1);
		expect(all[0]).toMatchObject({
			caseId,
			status: "open",
			awaitingSunsetDecision: true,
			overdue: true,
		});
		const open = cliJson<Array<{ caseId: string }>>(["eval", "open"]);
		expect(open.map((item) => item.caseId)).toEqual([caseId]);
		const overdue = cliJson<Array<{ caseId: string }>>(["eval", "overdue"]);
		expect(overdue.map((item) => item.caseId)).toEqual([caseId]);
		const detail = cliJson<{
			case: { status: string; awaitingSunsetDecision: boolean };
			verdict: { id: string; status: string };
			message: { bodyMd: string };
			artifacts: Array<{ kind: string }>;
			lifecycleRoot: { verdict: string };
		}>(["eval", "show", caseId]);
		expect(detail.case).toMatchObject({ status: "open", awaitingSunsetDecision: true });
		expect(detail.verdict).toMatchObject({ id: "verdict-cli-sunset", status: "ok" });
		expect(detail.message.bodyMd).toContain("awaiting operator accept");
		expect(detail.artifacts.map((artifact) => artifact.kind)).toContain("lifecycle-root");
		expect(detail.lifecycleRoot.verdict).toBe("delete_sunset");
	});

	it("accepts sunset as operator and never deletes the harness", () => {
		const accepted = cliJson<{ case: { status: string; awaitingSunsetDecision: boolean }; event: { type: string } }>([
			"eval",
			"accept-sunset",
			caseId,
			"--reason",
			"sunset trial accepted",
		]);
		expect(accepted.case.status).toBe("resolved");
		expect(accepted.case.awaitingSunsetDecision).toBe(false);
		expect(accepted.event.type).toBe("sunset_accepted");
		const open = cliJson<Array<{ caseId: string }>>(["eval", "open"]);
		expect(open).toEqual([]);
		const detail = cliJson<{ case: { status: string } }>(["eval", "show", caseId]);
		expect(detail.case.status).toBe("resolved");
		const second = rawCli(["eval", "accept-sunset", caseId, "--reason", "again"]);
		expect(second.status).not.toBe(0);
	});
});
