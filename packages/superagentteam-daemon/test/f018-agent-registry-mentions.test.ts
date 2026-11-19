import { describe, expect, it } from "vitest";

import type { AccountConfig, AgentCatalog } from "@superagentteam/shared/types";

import { computeExclusionSpans, parseOperatorMentions, scanOperatorMentions } from "../src/domains/agent/mentions.ts";
import { buildRegistry, CatalogError, resolveExplicitTarget } from "../src/domains/agent/registry.ts";

function makeCatalog(): { catalog: AgentCatalog; accounts: AccountConfig[] } {
	const accounts: AccountConfig[] = [
		{ ref: "main", provider: "zhipu", apiKeyRef: "ENV:ZHIPU", models: ["glm-5.3", "glm-5.3-flash"] },
	];
	const catalog: AgentCatalog = {
		version: 1,
		agents: [
			{
				id: "yanyan",
				mentionPatterns: ["@砚砚", "@yanyan"],
				displayName: "砚砚",
				contextWindow: 200_000,
				roleId: "reviewer",
				roleDescription: "review",
				restrictions: [],
				strengths: [],
				accountRef: "main",
				defaultModel: "glm-5.3",
				sessionChain: true,
				enabled: true,
			},
			{
				id: "xianxian",
				mentionPatterns: ["@宪宪"],
				displayName: "宪宪",
				contextWindow: 128_000,
				roleId: "implementer",
				roleDescription: "impl",
				restrictions: [],
				strengths: [],
				accountRef: "main",
				defaultModel: "glm-5.3-flash",
				sessionChain: true,
				enabled: false,
			},
		],
	};
	return { catalog, accounts };
}

describe("parseOperatorMentions (0007 §3.0, MENTION-1=B)", () => {
	const patterns = ["@砚砚", "@yanyan", "@opus-45"];

	it("matches explicit @ anywhere in prose, ordered by position", () => {
		expect(parseOperatorMentions("hey @宪宪 look", ["@宪宪"])).toEqual(["@宪宪"]);
		expect(parseOperatorMentions("@yanyan start then @砚砚 later", patterns)).toEqual(["@yanyan", "@砚砚"]);
	});

	it("unmatched @tokens are plain text, not errors", () => {
		expect(parseOperatorMentions("email me at nobody@example.com ok @unknown", patterns)).toEqual([]);
	});

	it("skips fenced and inline code", () => {
		expect(parseOperatorMentions("```\n@yanyan\n```\nafter", patterns)).toEqual([]);
		expect(parseOperatorMentions("use `@砚砚` macro", patterns)).toEqual([]);
	});

	it("skips URL-ish tokens", () => {
		expect(parseOperatorMentions("see https://x.com/@yanyan/status", patterns)).toEqual([]);
	});

	it("longest pattern wins at the same position", () => {
		expect(parseOperatorMentions("ping @opus-45 now", [...patterns, "@opus"])).toEqual(["@opus-45"]);
	});

	it("token boundary prevents prefix collisions", () => {
		expect(parseOperatorMentions("ping @yanyan-extra", patterns)).toEqual([]);
	});

	it("markdown list/quote prefixes do not block line mentions", () => {
		expect(parseOperatorMentions("- @砚砚 please", patterns)).toEqual(["@砚砚"]);
		expect(parseOperatorMentions("> @yanyan quoted", patterns)).toEqual(["@yanyan"]);
	});

	it("deduplicates repeated mentions of the same pattern", () => {
		const matches = scanOperatorMentions("@砚砚 and @砚砚 again", patterns);
		expect(matches).toHaveLength(2); // scan reports both occurrences
		expect(parseOperatorMentions("@砚砚 and @砚砚", patterns)).toEqual(["@砚砚", "@砚砚"]);
	});

	it("exclusion spans cover fenced blocks", () => {
		const spans = computeExclusionSpans("a ```@yanyan``` b");
		expect(spans).toHaveLength(1);
	});
});

describe("AgentRegistry (0008 §6)", () => {
	it("builds the mention index with normalized patterns", () => {
		const { catalog, accounts } = makeCatalog();
		const registry = buildRegistry(catalog, accounts);
		expect(registry.mentionIndex.get("@yanyan")).toBe("yanyan");
		expect(registry.mentionIndex.get("@砚砚")).toBe("yanyan");
		expect(registry.defaultAgentId).toBe("yanyan");
	});

	it("fails closed on cross-agent pattern conflicts", () => {
		const { catalog, accounts } = makeCatalog();
		catalog.agents[1]!.mentionPatterns = ["@YANYAN"];
		expect(() => buildRegistry(catalog, accounts)).toThrow(CatalogError);
	});

	it("rejects defaultModel outside the account models", () => {
		const { catalog, accounts } = makeCatalog();
		catalog.agents[0]!.defaultModel = "gpt-99";
		expect(() => buildRegistry(catalog, accounts)).toThrow(/defaultModel/);
	});

	it("rejects unknown account refs and empty patterns", () => {
		const { catalog, accounts } = makeCatalog();
		catalog.agents[0]!.accountRef = "nope";
		expect(() => buildRegistry(catalog, accounts)).toThrow(/account/i);
		const { catalog: c2, accounts: a2 } = makeCatalog();
		c2.agents[0]!.mentionPatterns = ["  "];
		expect(() => buildRegistry(c2, a2)).toThrow(CatalogError);
	});

	it("resolveExplicitTarget three-state semantics", () => {
		const { catalog, accounts } = makeCatalog();
		const registry = buildRegistry(catalog, accounts);
		expect(resolveExplicitTarget(registry, "砚砚")).toEqual({ kind: "ok", agentId: "yanyan" });
		expect(resolveExplicitTarget(registry, "@宪宪")).toEqual({ kind: "agent_disabled", pattern: "@宪宪" });
		expect(resolveExplicitTarget(registry, "@nobody")).toEqual({ kind: "agent_not_found", pattern: "@nobody" });
	});
});
