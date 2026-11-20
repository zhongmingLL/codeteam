import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountConfig, AgentCatalog, AgentConfig } from "@superagentteam/shared/types";
import { afterEach, describe, expect, it } from "vitest";

import {
	findV1A2AToolCall,
	hasV1A2AToolCall,
	normalizeV1A2AToolName,
	observeA2ATurn,
	observeMissingA2AToolCall,
	V1_A2A_TOOL_NAMES,
} from "../src/domains/a2a/observation.ts";
import { OperatorMessageIngress } from "../src/domains/a2a/router.ts";
import { buildRegistry } from "../src/domains/agent/registry.ts";
import { MessageStore } from "../src/domains/message/store.ts";
import { QueueLedgerStore } from "../src/domains/queue/store.ts";
import { ThreadStore } from "../src/domains/thread/store.ts";
import { F018Database } from "../src/infrastructure/db/database.ts";

const dirs: string[] = [];
const ACCOUNT: AccountConfig = { ref: "main", provider: "pi", apiKeyRef: "KEY", models: ["m1"] };

function agentConfig(id: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		id,
		mentionPatterns: [`@${id}`],
		displayName: `Agent ${id}`,
		contextWindow: 128_000,
		roleId: "worker",
		roleDescription: "does things",
		restrictions: [],
		strengths: [],
		accountRef: "main",
		defaultModel: "m1",
		sessionChain: true,
		enabled: true,
		...overrides,
	};
}

function makeIngressWorld() {
	const dir = mkdtempSync(join(tmpdir(), "f018-r4d-observation-"));
	dirs.push(dir);
	const fd = new F018Database({ path: join(dir, "f018.db") });
	const threads = new ThreadStore(fd.db);
	const messages = new MessageStore(fd.db);
	const queue = new QueueLedgerStore(fd.db);
	const catalog: AgentCatalog = {
		version: 1,
		agents: [agentConfig("a1"), agentConfig("a2", { enabled: false }), agentConfig("a3")],
	};
	const registry = buildRegistry(catalog, [ACCOUNT], "a3");
	threads.create({ id: "t1", projectPath: "/p", createdBy: "u1", now: 1 });
	const ingress = new OperatorMessageIngress({ db: fd.db, registry, threads, messages, queue });
	return { fd, ingress };
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("F018 R4-d E12 observation", () => {
	it("recognizes exactly the four v1 model-facing tools (canonical and credential names)", () => {
		for (const name of V1_A2A_TOOL_NAMES) {
			expect(normalizeV1A2AToolName(name)).toBe(name);
			expect(hasV1A2AToolCall([name])).toBe(true);
			const bare = name.replace(/^superagentteam_/, "");
			expect(normalizeV1A2AToolName(bare)).toBe(name);
			expect(hasV1A2AToolCall([bare])).toBe(true);
		}
		expect(findV1A2AToolCall(["read", "superagentteam_multi_mention"])).toBe("superagentteam_multi_mention");
	});

	it("does not recognize retired a2a_send / handoff_* or legacy codeteam_* names", () => {
		const retired = [
			"a2a_send",
			"handoff_create",
			"superagentteam_a2a_send",
			"superagentteam_handoff_create",
			"superagentteam_handoff_claim",
			"codeteam_post_message",
			"codeteam_handoff_complete",
		];
		for (const name of retired) {
			expect(normalizeV1A2AToolName(name)).toBeNull();
		}
		expect(hasV1A2AToolCall(retired)).toBe(false);
		expect(findV1A2AToolCall(retired)).toBeNull();
	});

	it("agent final-response text-@ is plain text and never emits missing_a2a_tool_call", () => {
		const textOnly = observeA2ATurn({
			finalResponse: "@a1 请 review 这个改动；handoff to @a2",
			toolCalls: [],
		});
		expect(textOnly.kind).toBe("no_a2a_tool_call");
		expect(textOnly.missingA2AToolCall).toBeNull();
		expect(
			observeMissingA2AToolCall({
				finalResponse: "@a1 请 review 这个改动；handoff to @a2",
				toolCalls: [],
			}),
		).toBeNull();

		const unrelatedTool = observeA2ATurn({
			finalResponse: "@a1 please look",
			toolCalls: ["read", "bash"],
		});
		expect(unrelatedTool.kind).toBe("no_a2a_tool_call");
		expect(unrelatedTool.missingA2AToolCall).toBeNull();

		const typed = observeA2ATurn({
			finalResponse: "@a1 please look",
			toolCalls: ["superagentteam_post_message"],
		});
		expect(typed.kind).toBe("a2a_tool_call");
		expect(typed.tool).toBe("superagentteam_post_message");
		expect(typed.missingA2AToolCall).toBeNull();
	});

	it("operator prose @ is a positive route; unmatched @ is plain text; disabled pattern rejects", () => {
		const { ingress } = makeIngressWorld();

		const positive = ingress.resolveTargets("t1", "@a1 please review");
		expect(positive).toEqual({
			kind: "ok",
			targetAgentIds: ["a1"],
			reason: "current_message_mentions",
		});

		// Unmatched @token is ordinary text: no agent_not_found / reject. It
		// falls through to the implicit chain (default agent here).
		const unmatched = ingress.resolveTargets("t1", "@nobody please review");
		expect(unmatched).toEqual({
			kind: "ok",
			targetAgentIds: ["a3"],
			reason: "default_agent",
		});

		// A matched pattern for a disabled agent is the only fail-closed case.
		const disabled = ingress.resolveTargets("t1", "@a2 please review");
		expect(disabled).toEqual({ kind: "agent_disabled", pattern: "@a2" });

		// An unmatched token next to a valid target does not poison the route.
		const mixed = ingress.resolveTargets("t1", "@a1 and @nobody please review");
		expect(mixed).toEqual({
			kind: "ok",
			targetAgentIds: ["a1"],
			reason: "current_message_mentions",
		});
	});
});
