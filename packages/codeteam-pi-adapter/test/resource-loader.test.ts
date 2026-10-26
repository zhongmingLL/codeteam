import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileL0, createL0ResourceLoader } from "../src/index.ts";

function tempDirs() {
	const root = mkdtempSync(join(tmpdir(), "codeteam-l0-"));
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	writeFileSync(join(cwd, "AGENTS.md"), "LEAKED PROJECT CONTEXT\n");
	return { cwd, agentDir };
}

describe("L0 resource loader", () => {
	it("injects compiled L0 natively and disables context-file discovery", async () => {
		const { cwd, agentDir } = tempDirs();
		const compiled = compileL0({ role: "coder", sections: [{ id: "task", body: "Implement F002." }] });
		const { loader, l0Revision } = await createL0ResourceLoader({ cwd, agentDir, compiledL0: compiled });

		expect(l0Revision).toBe(compiled.revision);
		expect(loader.getSystemPrompt()).toBe(compiled.text);
		expect(loader.getAppendSystemPrompt()).toEqual([]);
		expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
		expect(loader.getSystemPrompt()).not.toContain("LEAKED PROJECT CONTEXT");
	});
});
