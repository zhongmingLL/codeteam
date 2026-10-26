import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CompiledL0, compileL0, createAgentSessionWithL0, createL0ResourceLoader } from "../src/index.ts";

function writeSkill(root: string, relDir: string, name: string, body = ""): string {
	const dir = join(root, relDir);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${name} curated instructions.\n---\n\n# ${name}\n\n${body}\n`,
	);
	return dir;
}

describe("curated skill surface", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;
	let compiled: CompiledL0;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "codeteam-skills-surface-"));
		cwd = join(root, "work");
		agentDir = join(root, "agent");
		mkdirSync(cwd);
		mkdirSync(agentDir);
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "test" } }));
		compiled = compileL0({ role: "coder" });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function settings() {
		return SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 1, keepRecentTokens: 1 } });
	}

	it("injects only the allowlisted skills into the system prompt", async () => {
		const curated = writeSkill(root, "curated/alpha", "alpha", "BODY-MARKER-SHOULD-STAY-OUT");
		writeSkill(agentDir, "skills/home-decoy", "home-decoy");
		writeSkill(cwd, ".pi/skills/project-decoy", "project-decoy");

		const { loader } = await createL0ResourceLoader({
			cwd,
			agentDir,
			compiledL0: compiled,
			additionalSkillPaths: [curated],
		});
		expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["alpha"]);
		expect(loader.getSkills().diagnostics).toEqual([]);
		expect(loader.getExtensions().extensions).toEqual([]);

		const { session } = await createAgentSessionWithL0({
			cwd,
			agentDir,
			compiledL0: compiled,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: settings(),
			tools: ["read"],
			curatedSkillPaths: [curated],
		});

		try {
			expect(session.systemPrompt).toContain("<available_skills>");
			expect(session.systemPrompt).toContain("<name>alpha</name>");
			expect(session.systemPrompt).toContain(join(curated, "SKILL.md"));
			expect(session.systemPrompt).not.toContain("BODY-MARKER-SHOULD-STAY-OUT");
			expect(session.systemPrompt).not.toContain("home-decoy");
			expect(session.systemPrompt).not.toContain("project-decoy");
			expect(session.systemPrompt).toContain(compiled.text);
		} finally {
			session.dispose();
		}
	});

	it("loads no skills when the allowlist is empty", async () => {
		writeSkill(agentDir, "skills/home-decoy", "home-decoy");
		writeSkill(cwd, ".pi/skills/project-decoy", "project-decoy");

		const { loader } = await createL0ResourceLoader({ cwd, agentDir, compiledL0: compiled });
		expect(loader.getSkills().skills).toEqual([]);

		const { session } = await createAgentSessionWithL0({
			cwd,
			agentDir,
			compiledL0: compiled,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: settings(),
			tools: ["read"],
			curatedSkillPaths: [],
		});

		try {
			expect(session.systemPrompt).not.toContain("<available_skills>");
			expect(session.systemPrompt).not.toContain("home-decoy");
			expect(session.systemPrompt).not.toContain("project-decoy");
		} finally {
			session.dispose();
		}
	});

	it("does not change the tool surface when skills are injected", async () => {
		const curated = writeSkill(root, "curated/alpha", "alpha");
		const model = getModel("anthropic", "claude-sonnet-4-5")!;

		const withoutSkills = await createAgentSessionWithL0({
			cwd,
			agentDir,
			compiledL0: compiled,
			model,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: settings(),
			tools: ["read"],
		});
		const withSkills = await createAgentSessionWithL0({
			cwd,
			agentDir,
			compiledL0: compiled,
			model,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: settings(),
			tools: ["read"],
			curatedSkillPaths: [curated],
		});

		try {
			const names = (session: typeof withoutSkills.session) => session.agent.state.tools.map((tool) => tool.name);
			expect(names(withSkills.session)).toEqual(names(withoutSkills.session));
			expect(names(withSkills.session)).toEqual(["read"]);
		} finally {
			withSkills.session.dispose();
			withoutSkills.session.dispose();
		}
	});

	it("reports a missing allowlist path instead of silently loading nothing", async () => {
		const missing = join(root, "curated/missing");
		const { loader } = await createL0ResourceLoader({
			cwd,
			agentDir,
			compiledL0: compiled,
			additionalSkillPaths: [missing],
		});

		expect(loader.getSkills().skills).toEqual([]);
		expect(loader.getSkills().diagnostics).toContainEqual(
			expect.objectContaining({ path: missing, message: expect.stringContaining("does not exist") }),
		);
	});
});
