import { describe, expect, it } from "vitest";
import { type SuperAgentTeamSharedVersion } from "./index.ts";

describe("@superagentteam/shared types entry", () => {
	it("exports the version marker", () => {
		const v: SuperAgentTeamSharedVersion = "v1-r1-0";
		expect(v).toBe("v1-r1-0");
	});
});
