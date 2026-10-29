import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildEvalAgentInvocationPacket,
	ControlError,
	loadEvalDomainRegistry,
	resolveEvalDomain,
} from "../src/index.ts";
import { createEvalFixture, type EvalFixture } from "./helpers/eval-fixture.ts";

const dirs: string[] = [];
const fixtures: EvalFixture[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "codeteam-eval-registry-"));
	dirs.push(dir);
	return dir;
}

function fixture(): EvalFixture {
	const value = createEvalFixture();
	fixtures.push(value);
	return value;
}

afterEach(() => {
	for (const value of fixtures.splice(0)) value.cleanup();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function yaml(overrides: Record<string, unknown> = {}): string {
	const entry = {
		domainId: "eval:test-domain",
		systemThreadId: "thread:eval-domain",
		evalAgent: "profile:eval",
		frequency: "daily",
		triggerPolicy: { kind: "time_only", maxDetectionDelayHours: 24 },
		sourceAdapter: "task_outcome",
		sourceRefsKind: "task",
		sla: { acknowledgementHours: 24, reevaluationHours: 168 },
		enabled: true,
		...overrides,
	};
	return Object.entries(entry)
		.map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
		.join("\n");
}

function writeDomain(dir: string, name: string, content: string): void {
	writeFileSync(join(dir, name), `${content}\n`);
}

function expectCode(fn: () => unknown, code: string): void {
	try {
		fn();
		throw new Error("expected ControlError");
	} catch (error) {
		expect(error).toBeInstanceOf(ControlError);
		expect((error as ControlError).code).toBe(code);
	}
}

describe("W6b eval domain registry", () => {
	it("loads the repo registry with disabled dormant domains", () => {
		const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
		const entries = loadEvalDomainRegistry({ dir: join(repoRoot, "evals", "domains") });
		expect(entries.map((entry) => entry.domainId)).toEqual(["eval:review-quality", "eval:task-outcome"]);
		for (const entry of entries) {
			expect(entry.enabled).toBe(false);
			expect(entry.dormancy?.revivalPath).toBeTruthy();
		}
	});

	it("resolves enabled domains to an active eval role/profile and thread", () => {
		const base = fixture();
		const dir = tempDir();
		writeDomain(dir, "test.yaml", yaml());
		const entries = loadEvalDomainRegistry({ dir, store: base.store });
		expect(entries).toHaveLength(1);
		const resolved = resolveEvalDomain({ entry: entries[0]!, store: base.store });
		expect(resolved.profile.id).toBe("profile:eval");
		expect(resolved.profile.role).toBe("eval");
		expect(resolved.thread.id).toBe("thread:eval-domain");
		const packet = buildEvalAgentInvocationPacket({
			entry: entries[0]!,
			store: base.store,
			input: {
				invocationId: "invocation-1",
				windowStartMs: 10,
				windowEndMs: 20,
				trendRefs: ["trend:1"],
				verdictRefs: ["verdict:1"],
				sourceRefs: ["task:task-1", "task:task-1"],
			},
		});
		expect(packet.domainId).toBe("eval:test-domain");
		expect(packet.targetThreadId).toBe("thread:eval-domain");
		expect(packet.evalAgent).toBe("profile:eval");
		expect(packet.evalAgentRole).toBe("eval");
		expect(packet.context.sourceRefs).toEqual(["task:task-1"]);
		expect(packet.context.sla).toEqual({ acknowledgementHours: 24, reevaluationHours: 168 });
	});

	it("fails closed when eval role, profile, or system thread is missing or disabled", () => {
		const base = fixture();
		const dir = tempDir();
		writeDomain(dir, "test.yaml", yaml());
		const entry = loadEvalDomainRegistry({ dir })[0]!;

		base.store.roles.setStatus("eval", "disabled");
		expectCode(() => resolveEvalDomain({ entry, store: base.store }), "invalid_state");
		base.store.roles.setStatus("eval", "active");

		expectCode(
			() => resolveEvalDomain({ entry: { ...entry, evalAgent: "profile:missing" }, store: base.store }),
			"not_found",
		);
		expectCode(
			() => resolveEvalDomain({ entry: { ...entry, evalAgent: "profile:owner" }, store: base.store }),
			"invalid_state",
		);
		base.store.profiles.setStatus("profile:eval", "disabled");
		expectCode(() => resolveEvalDomain({ entry, store: base.store }), "invalid_state");
		base.store.profiles.setStatus("profile:eval", "active");

		expectCode(
			() => resolveEvalDomain({ entry: { ...entry, systemThreadId: "thread:missing" }, store: base.store }),
			"not_found",
		);
		base.store.threads.setStatus("thread:eval-domain", "archived");
		expectCode(() => resolveEvalDomain({ entry, store: base.store }), "invalid_state");
	});

	it("rejects unknown keys, duplicate domains, and invalid dormancy", () => {
		const dir = tempDir();
		writeDomain(dir, "unknown.yaml", yaml({ extra: true }));
		expectCode(() => loadEvalDomainRegistry({ dir }), "invalid_input");

		const duplicate = tempDir();
		writeDomain(duplicate, "one.yaml", yaml());
		writeDomain(duplicate, "two.yaml", yaml());
		expectCode(() => loadEvalDomainRegistry({ dir: duplicate }), "invalid_input");

		const missingDormancy = tempDir();
		writeDomain(missingDormancy, "dormant.yaml", yaml({ enabled: false }));
		expectCode(() => loadEvalDomainRegistry({ dir: missingDormancy }), "invalid_input");

		const staleDormancy = tempDir();
		writeDomain(
			staleDormancy,
			"stale.yaml",
			yaml({
				enabled: true,
				dormancy: { reason: "old", revivalPath: "old", decisionRef: "old" },
			}),
		);
		expectCode(() => loadEvalDomainRegistry({ dir: staleDormancy }), "invalid_input");

		const badId = tempDir();
		writeDomain(badId, "bad.yaml", yaml({ domainId: "eval:Bad ID" }));
		expectCode(() => loadEvalDomainRegistry({ dir: badId }), "invalid_input");
	});

	it("keeps a disabled domain loadable without resolving its placeholder profile/thread", () => {
		const dir = tempDir();
		writeDomain(
			dir,
			"dormant.yaml",
			yaml({
				enabled: false,
				evalAgent: "profile:does-not-exist",
				systemThreadId: "thread:does-not-exist",
				dormancy: { reason: "not wired", revivalPath: "wire it", decisionRef: "F014" },
			}),
		);
		const base = fixture();
		const entries = loadEvalDomainRegistry({ dir, store: base.store });
		expect(entries[0]!.enabled).toBe(false);
		expectCode(() => resolveEvalDomain({ entry: entries[0]!, store: base.store }), "invalid_state");
	});

	it("rejects invocation windows that are empty or reversed", () => {
		const base = fixture();
		const dir = tempDir();
		writeDomain(dir, "test.yaml", yaml());
		const entry = loadEvalDomainRegistry({ dir })[0]!;
		expectCode(
			() =>
				buildEvalAgentInvocationPacket({
					entry,
					store: base.store,
					input: { invocationId: "i", windowStartMs: 20, windowEndMs: 20 },
				}),
			"invalid_input",
		);
	});
});
