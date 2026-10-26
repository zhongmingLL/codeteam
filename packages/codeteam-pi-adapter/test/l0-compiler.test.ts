import { describe, expect, it } from "vitest";
import { compileL0, L0_ROLES, loadRoleTemplate } from "../src/index.ts";

describe("L0 compiler", () => {
	it.each(L0_ROLES)("compiles a deterministic %s prompt", (role) => {
		const first = compileL0({ role });
		const second = compileL0({ role });

		expect(first.revision).toMatch(/^sha256-[0-9a-f]{64}$/);
		expect(second).toEqual(first);
		expect(first.text).toContain(loadRoleTemplate(role));
		expect(first.text).toContain("## Governance");
	});

	it("normalizes section order and line endings", () => {
		const first = compileL0({
			role: "coder",
			sections: [
				{ id: "task", body: "Do the work.\r\n" },
				{ id: "repo", body: "Use the codeteam repo.\r\n" },
			],
		});
		const second = compileL0({
			role: "coder",
			sections: [
				{ id: "repo", body: "Use the codeteam repo.\n" },
				{ id: "task", body: "Do the work.\n" },
			],
		});

		expect(first.revision).toBe(second.revision);
		expect(first.text.indexOf("## repo")).toBeLessThan(first.text.indexOf("## task"));
	});

	it("changes the revision when the role changes", () => {
		expect(compileL0({ role: "coder" }).revision).not.toBe(compileL0({ role: "reviewer" }).revision);
	});
});
