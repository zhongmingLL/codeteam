import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SOP_CHECK_EVIDENCE_KIND, SOP_CHECK_NAME_VALUES } from "../src/control/stores/sop-check-evidence.ts";
import { SOP_CATALOG, SOP_STAGE_IDS } from "../src/index.ts";

describe("codeteam SOP catalog", () => {
	it("keeps the seven clowder stage ids and no extra stage", () => {
		expect(SOP_STAGE_IDS).toEqual([
			"kickoff",
			"impl",
			"quality_gate",
			"fresh_context",
			"review",
			"merge",
			"completion",
		]);
		expect(SOP_CATALOG.stages.map((stage) => stage.id)).toEqual([...SOP_STAGE_IDS]);
		for (const stage of SOP_CATALOG.stages) {
			expect(stage.suggestedSkill.length).toBeGreaterThan(0);
			expect(stage.hardRules.length + stage.pitfalls.length).toBeGreaterThan(0);
			for (const rule of [...stage.hardRules, ...stage.pitfalls]) {
				expect(rule.id.length).toBeGreaterThan(0);
				expect(rule.text.length).toBeGreaterThan(0);
				expect(rule.predicate.type.length).toBeGreaterThan(0);
			}
		}
	});

	it("keeps the four evidence-backed SOP checks", () => {
		expect(SOP_CHECK_NAME_VALUES).toEqual([
			"remoteMainSynced",
			"qualityGatePassed",
			"reviewApproved",
			"visionGuardDone",
		]);
		expect(SOP_CHECK_EVIDENCE_KIND).toEqual({
			remoteMainSynced: "git_sync",
			qualityGatePassed: "quality_gate",
			reviewApproved: "review",
			visionGuardDone: "vision_guard",
		});
		expect(SOP_CATALOG.checks.map((check) => check.name)).toEqual([...SOP_CHECK_NAME_VALUES]);
	});

	it("contains no clowder-only repository, redis, or command parameters", () => {
		const serialized = JSON.stringify(SOP_CATALOG);
		const yaml = readFileSync(new URL("../../../sop-definitions/development.yaml", import.meta.url), "utf8");
		for (const text of [serialized, yaml]) {
			expect(text).not.toMatch(/cat-cafe/i);
			expect(text).not.toMatch(/REDIS_URL|:6398|:6399/);
			expect(text).not.toMatch(/pnpm check:features|pnpm convention-graph|cat-cafe-runtime/);
		}
	});
});
