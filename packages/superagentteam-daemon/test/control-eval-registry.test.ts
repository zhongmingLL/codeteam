import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildEvalAgentInvocationPacket,
	ControlError,
	loadEvalDomainRegistry,
	loadEvalDomainRegistrySafe,
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

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		domainId: "eval:test-domain",
		displayName: "Test domain",
		descriptionForHuman: "Test domain",
		systemThreadId: "thread:eval-domain",
		evalAgent: { profileId: "profile:eval", role: "eval", handle: "eval", model: "eval-model" },
		frequency: "daily",
		triggerPolicy: { mode: "time_only", maxDetectionDelayHours: 24 },
		sourceAdapter: "task_outcome",
		sourceRefsKind: "task",
		handoffTargetResolver: {
			featureId: "F014",
			ownerProfileId: "profile:owner",
			threadLookup: "feature-thread",
		},
		sla: { acknowledgeHours: 24, reevalWithinHours: 168 },
		fixtures: [],
		enabled: true,
		...overrides,
	};
}

function yaml(value: Record<string, unknown>): string {
	return Object.entries(value)
		.map(([key, child]) => `${key}: ${JSON.stringify(child)}`)
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
		expect(entries.map((domain) => domain.domainId)).toEqual(["eval:review-quality", "eval:task-outcome"]);
		for (const domain of entries) {
			expect(domain.enabled).toBe(false);
			expect(domain.dormancy?.revivalPath).toBeTruthy();
			expect(domain.evalAgent.profileId).toBe("profile:eval");
			expect(domain.handoffTargetResolver.ownerProfileId).toBe("profile:owner");
		}
	});

	it("resolves enabled domains to active eval/owner profiles and an active system thread", () => {
		const base = fixture();
		const dir = tempDir();
		writeDomain(dir, "test.yaml", yaml(entry()));
		const entries = loadEvalDomainRegistry({ dir, store: base.store });
		expect(entries).toHaveLength(1);
		const resolved = resolveEvalDomain({ entry: entries[0]!, store: base.store });
		expect(resolved.profile.id).toBe("profile:eval");
		expect(resolved.profile.role).toBe("eval");
		expect(resolved.owner.id).toBe("profile:owner");
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
		expect(packet.evalAgentProfileId).toBe("profile:eval");
		expect(packet.evalAgentRole).toBe("eval");
		expect(packet.instructions.publishRequired).toBe(true);
		expect(packet.instructions.outputContract).toBe("VerdictHandoffPacketV1");
		expect(packet.context.sourceRefs).toEqual(["task:task-1"]);
		expect(packet.context.sla).toEqual({ acknowledgeHours: 24, reevalWithinHours: 168 });
		expect(packet.context.handoffTargetResolver.ownerProfileId).toBe("profile:owner");
	});

	it("fails closed when eval role, profile, owner, model, or thread is missing or disabled", () => {
		const base = fixture();
		const dir = tempDir();
		writeDomain(dir, "test.yaml", yaml(entry()));
		const parsed = loadEvalDomainRegistry({ dir })[0]!;

		base.store.roles.setStatus("eval", "disabled");
		expectCode(() => resolveEvalDomain({ entry: parsed, store: base.store }), "invalid_state");
		base.store.roles.setStatus("eval", "active");

		expectCode(
			() =>
				resolveEvalDomain({
					entry: { ...parsed, evalAgent: { ...parsed.evalAgent, profileId: "profile:missing" } },
					store: base.store,
				}),
			"not_found",
		);
		expectCode(
			() =>
				resolveEvalDomain({
					entry: { ...parsed, evalAgent: { ...parsed.evalAgent, profileId: "profile:owner" } },
					store: base.store,
				}),
			"invalid_state",
		);
		expectCode(
			() =>
				resolveEvalDomain({
					entry: { ...parsed, evalAgent: { ...parsed.evalAgent, model: "glm-other" } },
					store: base.store,
				}),
			"invalid_state",
		);
		expectCode(
			() =>
				resolveEvalDomain({
					entry: {
						...parsed,
						handoffTargetResolver: { ...parsed.handoffTargetResolver, ownerProfileId: "profile:missing" },
					},
					store: base.store,
				}),
			"not_found",
		);
		base.store.profiles.setStatus("profile:eval", "disabled");
		expectCode(() => resolveEvalDomain({ entry: parsed, store: base.store }), "invalid_state");
		base.store.profiles.setStatus("profile:eval", "active");

		expectCode(
			() => resolveEvalDomain({ entry: { ...parsed, systemThreadId: "thread:missing" }, store: base.store }),
			"not_found",
		);
		base.store.threads.setStatus("thread:eval-domain", "archived");
		expectCode(() => resolveEvalDomain({ entry: parsed, store: base.store }), "invalid_state");
	});

	it("rejects unknown keys, duplicate domains, invalid trigger/frequency, and invalid dormancy", () => {
		const unknown = tempDir();
		writeDomain(unknown, "unknown.yaml", yaml(entry({ extra: true })));
		expectCode(() => loadEvalDomainRegistry({ dir: unknown }), "invalid_input");

		const duplicate = tempDir();
		writeDomain(duplicate, "one.yaml", yaml(entry()));
		writeDomain(duplicate, "two.yaml", yaml(entry()));
		expectCode(() => loadEvalDomainRegistry({ dir: duplicate }), "invalid_input");

		const missingDormancy = tempDir();
		writeDomain(missingDormancy, "dormant.yaml", yaml(entry({ enabled: false })));
		expectCode(() => loadEvalDomainRegistry({ dir: missingDormancy }), "invalid_input");

		const staleDormancy = tempDir();
		writeDomain(
			staleDormancy,
			"stale.yaml",
			yaml(entry({ enabled: true, dormancy: { reason: "old", revivalPath: "old", decisionRef: "old" } })),
		);
		expectCode(() => loadEvalDomainRegistry({ dir: staleDormancy }), "invalid_input");

		const badFrequency = tempDir();
		writeDomain(badFrequency, "bad.yaml", yaml(entry({ frequency: "hourly" })));
		expectCode(() => loadEvalDomainRegistry({ dir: badFrequency }), "invalid_input");

		const badTrigger = tempDir();
		writeDomain(
			badTrigger,
			"bad-trigger.yaml",
			yaml(entry({ triggerPolicy: { mode: "time_only", maxDetectionDelayHours: 24, cooldownHours: 1 } })),
		);
		expectCode(() => loadEvalDomainRegistry({ dir: badTrigger }), "invalid_input");

		const badFixture = tempDir();
		writeDomain(
			badFixture,
			"bad-fixture.yaml",
			yaml(entry({ fixtures: [{ id: "f1", featureId: "F014", path: "../../escape" }] })),
		);
		expectCode(() => loadEvalDomainRegistry({ dir: badFixture }), "invalid_input");
	});

	it("keeps disabled domains loadable without resolving placeholder identities", () => {
		const dir = tempDir();
		writeDomain(
			dir,
			"dormant.yaml",
			yaml(
				entry({
					enabled: false,
					evalAgent: { profileId: "profile:missing", role: "eval", handle: "eval", model: "eval-model" },
					handoffTargetResolver: {
						featureId: "F014",
						ownerProfileId: "profile:missing",
						threadLookup: "feature-thread",
					},
					systemThreadId: "thread:missing",
					dormancy: { reason: "not wired", revivalPath: "wire it", decisionRef: "F014" },
				}),
			),
		);
		const base = fixture();
		const parsed = loadEvalDomainRegistry({ dir, store: base.store });
		expect(parsed[0]!.enabled).toBe(false);
		expectCode(() => resolveEvalDomain({ entry: parsed[0]!, store: base.store }), "invalid_state");
	});

	it("returns zero domains plus a warning for a missing registry directory", () => {
		const missing = join(tempDir(), "does-not-exist");
		expectCode(() => loadEvalDomainRegistry({ dir: missing }), "invalid_input");
		const safe = loadEvalDomainRegistrySafe({ dir: missing, allowMissing: true });
		expect(safe.entries).toEqual([]);
		expect(safe.warnings).toHaveLength(1);
	});

	it("rejects invocation windows and sourceRefs that do not match the declared kind", () => {
		const base = fixture();
		const dir = tempDir();
		writeDomain(dir, "test.yaml", yaml(entry()));
		const parsed = loadEvalDomainRegistry({ dir })[0]!;
		expectCode(
			() =>
				buildEvalAgentInvocationPacket({
					entry: parsed,
					store: base.store,
					input: { invocationId: "i", windowStartMs: 20, windowEndMs: 20 },
				}),
			"invalid_input",
		);
		expectCode(
			() =>
				buildEvalAgentInvocationPacket({
					entry: parsed,
					store: base.store,
					input: {
						invocationId: "i",
						windowStartMs: 10,
						windowEndMs: 20,
						sourceRefs: ["review:review-1"],
					},
				}),
			"invalid_input",
		);
	});
});
