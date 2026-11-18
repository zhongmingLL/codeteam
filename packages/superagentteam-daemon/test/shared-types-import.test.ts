import type { SuperAgentTeamSharedVersion } from "@superagentteam/shared/types";
import { describe, expect, it } from "vitest";

describe("R1-0 shared type skeleton", () => {
	it("daemon can import @superagentteam/shared/types", () => {
		const v: SuperAgentTeamSharedVersion = "v1-r1-0";
		expect(v).toBe("v1-r1-0");
	});
});
