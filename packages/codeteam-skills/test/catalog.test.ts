import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadCuratedCatalog } from "../src/index.ts";

const packageRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function writeSkill(root: string, relDir: string, name: string, description: string, body = ""): string {
	const dir = join(root, relDir);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\ntriggers: ["first", "second"]\n---\n\n# ${name}\n\n${body}\n`,
	);
	return dir;
}

function entry(skillId: string, path: string, extra = ""): string {
	return `  - skillId: ${skillId}\n    path: ${path}\n    sourceKind: repo-local\n    category: delivery\n    not_for:\n      - nothing\n    output: "some output"\n    next: null\n    sop_step: quality-gate\n${extra}`;
}

function writeManifest(root: string, entries: string[]): void {
	writeFileSync(join(root, "manifest.yaml"), `version: 1\nskills:\n${entries.join("")}`);
}

describe("curated skill catalog", () => {
	let root: string;

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
	});

	function newRoot(): string {
		root = mkdtempSync(join(tmpdir(), "codeteam-skills-"));
		return root;
	}

	it("resolves the shipped catalog from SKILL.md frontmatter", () => {
		const catalog = loadCuratedCatalog({ catalogRoot: packageRoot });

		expect(catalog.diagnostics).toEqual([]);
		expect(catalog.skills.map((skill) => skill.skillId)).toEqual(["codeteam-verify", "codeteam-review"]);
		expect(catalog.skillPaths).toHaveLength(2);
		expect(catalog.skills[0]?.description).toContain("verification");
		expect(catalog.skills[0]?.triggers).toEqual(["before claiming done", "after code changes", "before PR"]);
		expect(catalog.skills[0]?.next).toBe("codeteam-review");
		expect(catalog.skillPaths[0]).toBe(catalog.skills[0]?.dirPath);
	});

	it("returns no skills for an empty allowlist", () => {
		const catalogRoot = newRoot();
		writeManifest(catalogRoot, []);

		const catalog = loadCuratedCatalog({ catalogRoot });

		expect(catalog.skills).toEqual([]);
		expect(catalog.skillPaths).toEqual([]);
		expect(catalog.diagnostics).toEqual([]);
	});

	it("rejects manifest entries that duplicate SKILL.md metadata", () => {
		const catalogRoot = newRoot();
		writeSkill(catalogRoot, "skills/alpha", "alpha", "Alpha skill.");
		writeManifest(catalogRoot, [entry("alpha", "skills/alpha", "    description: duplicated\n")]);

		const catalog = loadCuratedCatalog({ catalogRoot });

		expect(catalog.skills).toEqual([]);
		expect(catalog.diagnostics).toContainEqual(
			expect.objectContaining({ severity: "error", code: "manifest_invalid" }),
		);
	});

	it("reports a dangling skill path instead of loading it", () => {
		const catalogRoot = newRoot();
		mkdirSync(join(catalogRoot, "skills/empty"), { recursive: true });
		writeManifest(catalogRoot, [entry("empty", "skills/empty")]);

		const catalog = loadCuratedCatalog({ catalogRoot });

		expect(catalog.skills).toEqual([]);
		expect(catalog.skillPaths).toEqual([]);
		expect(catalog.diagnostics).toContainEqual(
			expect.objectContaining({ severity: "error", code: "skill_missing", skillId: "empty" }),
		);
	});

	it("warns when a next reference does not resolve", () => {
		const catalogRoot = newRoot();
		writeSkill(catalogRoot, "skills/alpha", "alpha", "Alpha skill.");
		writeManifest(catalogRoot, [entry("alpha", "skills/alpha").replace("next: null", "next: missing-skill")]);

		const catalog = loadCuratedCatalog({ catalogRoot });

		expect(catalog.skills).toHaveLength(1);
		expect(catalog.diagnostics).toContainEqual(
			expect.objectContaining({ severity: "warning", code: "dangling_next", skillId: "alpha" }),
		);
	});

	it("rejects absolute paths", () => {
		const catalogRoot = newRoot();
		writeManifest(catalogRoot, [entry("alpha", "/etc/codeteam-skill")]);

		const catalog = loadCuratedCatalog({ catalogRoot });

		expect(catalog.skills).toEqual([]);
		expect(catalog.diagnostics).toContainEqual(expect.objectContaining({ severity: "error", code: "path_absolute" }));
	});

	it("rejects parent traversal", () => {
		const catalogRoot = newRoot();
		writeManifest(catalogRoot, [entry("alpha", "../outside")]);

		const catalog = loadCuratedCatalog({ catalogRoot });

		expect(catalog.skills).toEqual([]);
		expect(catalog.diagnostics).toContainEqual(expect.objectContaining({ severity: "error", code: "path_escape" }));
	});

	it("rejects a symlink that escapes the catalog root", () => {
		const catalogRoot = newRoot();
		const outside = join(catalogRoot, "..", `outside-${Date.now()}`);
		writeSkill(outside, "skill", "alpha", "Alpha skill.");
		mkdirSync(join(catalogRoot, "skills"), { recursive: true });
		symlinkSync(join(outside, "skill"), join(catalogRoot, "skills/alpha"), "dir");
		writeManifest(catalogRoot, [entry("alpha", "skills/alpha")]);

		const catalog = loadCuratedCatalog({ catalogRoot });

		expect(catalog.skills).toEqual([]);
		expect(catalog.diagnostics).toContainEqual(expect.objectContaining({ severity: "error", code: "path_escape" }));
		rmSync(outside, { recursive: true, force: true });
	});

	it("rejects a skill file that contains a secret", () => {
		const catalogRoot = newRoot();
		writeSkill(catalogRoot, "skills/alpha", "alpha", "Alpha skill.", "token AKIAIOSFODNN7EXAMPLE");
		writeManifest(catalogRoot, [entry("alpha", "skills/alpha")]);

		const catalog = loadCuratedCatalog({ catalogRoot });

		expect(catalog.skills).toEqual([]);
		expect(catalog.diagnostics).toContainEqual(
			expect.objectContaining({ severity: "error", code: "secret_detected", skillId: "alpha" }),
		);
	});

	it("rejects a symlink inside the skill directory that escapes it", () => {
		const catalogRoot = newRoot();
		const outside = join(catalogRoot, "..", `outside-file-${Date.now()}`);
		writeFileSync(outside, "external payload");
		const skillDir = writeSkill(catalogRoot, "skills/alpha", "alpha", "Alpha skill.");
		symlinkSync(outside, join(skillDir, "leak.txt"), "file");
		writeManifest(catalogRoot, [entry("alpha", "skills/alpha")]);

		const catalog = loadCuratedCatalog({ catalogRoot });

		expect(catalog.skills).toEqual([]);
		expect(catalog.diagnostics).toContainEqual(
			expect.objectContaining({ severity: "error", code: "path_escape", skillId: "alpha" }),
		);
		rmSync(outside, { force: true });
	});

	it("rejects a symlinked directory inside the skill directory that escapes it", () => {
		const catalogRoot = newRoot();
		const outside = join(catalogRoot, "..", `outside-dir-${Date.now()}`);
		writeSkill(outside, "payload", "payload", "payload");
		const skillDir = writeSkill(catalogRoot, "skills/alpha", "alpha", "Alpha skill.");
		symlinkSync(join(outside, "payload"), join(skillDir, "external"), "dir");
		writeManifest(catalogRoot, [entry("alpha", "skills/alpha")]);

		const catalog = loadCuratedCatalog({ catalogRoot });

		expect(catalog.skills).toEqual([]);
		expect(catalog.diagnostics).toContainEqual(
			expect.objectContaining({ severity: "error", code: "path_escape", skillId: "alpha" }),
		);
		rmSync(outside, { recursive: true, force: true });
	});

	it("scans SKILL.md even when it exceeds the general scan size limit", () => {
		const catalogRoot = newRoot();
		const skillDir = join(catalogRoot, "skills/alpha");
		mkdirSync(skillDir, { recursive: true });
		const padding = "a".repeat(650 * 1024);
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---\nname: alpha\ndescription: Alpha skill.\ntriggers: ["first"]\n---\n\n${padding}\nAKIAIOSFODNN7EXAMPLE\n`,
		);
		writeManifest(catalogRoot, [entry("alpha", "skills/alpha")]);

		const catalog = loadCuratedCatalog({ catalogRoot });

		expect(catalog.skills).toEqual([]);
		expect(catalog.diagnostics).toContainEqual(
			expect.objectContaining({ severity: "error", code: "secret_detected", skillId: "alpha" }),
		);
	});

	it("rejects an oversized SKILL.md instead of skipping the scan", () => {
		const catalogRoot = newRoot();
		const skillDir = join(catalogRoot, "skills/alpha");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---\nname: alpha\ndescription: Alpha skill.\ntriggers: ["first"]\n---\n\n${"a".repeat(3 * 1024 * 1024)}\n`,
		);
		writeManifest(catalogRoot, [entry("alpha", "skills/alpha")]);

		const catalog = loadCuratedCatalog({ catalogRoot });

		expect(catalog.skills).toEqual([]);
		expect(catalog.diagnostics).toContainEqual(
			expect.objectContaining({ severity: "error", code: "skill_too_large", skillId: "alpha" }),
		);
	});

	it("rejects a frontmatter name that differs from skillId", () => {
		const catalogRoot = newRoot();
		writeSkill(catalogRoot, "skills/alpha", "beta", "Alpha skill.");
		writeManifest(catalogRoot, [entry("alpha", "skills/alpha")]);

		const catalog = loadCuratedCatalog({ catalogRoot });

		expect(catalog.skills).toEqual([]);
		expect(catalog.diagnostics).toContainEqual(
			expect.objectContaining({ severity: "error", code: "name_mismatch", skillId: "alpha" }),
		);
	});

	it("merges multiple skill directories in manifest order", () => {
		const catalogRoot = newRoot();
		writeSkill(catalogRoot, "skills/alpha", "alpha", "Alpha skill.");
		writeSkill(catalogRoot, "skills/beta", "beta", "Beta skill.");
		writeManifest(catalogRoot, [entry("alpha", "skills/alpha"), entry("beta", "skills/beta")]);

		const catalog = loadCuratedCatalog({ catalogRoot });

		expect(catalog.diagnostics).toEqual([]);
		expect(catalog.skills.map((skill) => skill.skillId)).toEqual(["alpha", "beta"]);
		expect(catalog.skillPaths).toHaveLength(2);
	});
});
