import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./check-doc-index.mjs", import.meta.url));
const backlogHeader = [
	"# Feature Roadmap",
	"",
	"| ID | Name | Status | Owner | Link |",
	"|----|------|--------|-------|------|",
].join("\n");

async function fixture(t, { features = ["F001-alpha.md"], rows, readme, plans = [] }) {
	const root = await mkdtemp(join(tmpdir(), "codeteam-doc-index-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "docs", "features"), { recursive: true });
	await mkdir(join(root, "docs", "plans"), { recursive: true });
	for (const feature of features) {
		await writeFile(join(root, "docs", "features", feature), "---\nstatus: done\n---\n\n# Feature\n");
	}
	const defaultRows =
		rows ??
		features
			.filter((feature) => /^F\d{3}-/.test(feature))
			.map((feature, index) => `| F00${index + 1} | Feature | done | 宪宪 | [F00${index + 1}](docs/features/${feature}) |`);
	await writeFile(join(root, "BACKLOG.md"), `${backlogHeader}\n${defaultRows.join("\n")}\n`);
	const defaultReadme =
		readme ??
		["# Docs", "", ...features.map((feature) => `| [${feature}](features/${feature}) | Feature |`)].join("\n");
	await writeFile(join(root, "docs", "README.md"), `${defaultReadme}\n`);
	for (const [name, contents] of plans) {
		await writeFile(join(root, "docs", "plans", name), contents);
	}
	return root;
}

function check(root) {
	return spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
}

test("accepts a complete feature registry", async (t) => {
	const root = await fixture(t, {
		features: ["F001-alpha.md", "F001a-slice.md"],
		plans: [["0017-alpha.md", "---\nfeature: F001\n---\n\n# Plan\n"]],
	});
	const result = check(root);
	assert.equal(result.status, 0, result.stderr);
});

test("rejects a top-level feature missing from BACKLOG", async (t) => {
	const root = await fixture(t, { rows: [] });
	const result = check(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /F001 is missing from BACKLOG\.md/);
});

test("rejects a feature missing from the documentation index", async (t) => {
	const root = await fixture(t, { readme: "# Docs\n" });
	const result = check(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /F001a-slice\.md.*missing from the documentation index|F001-alpha\.md.*missing from the documentation index/);
});

test("rejects a plan feature reference without a feature doc", async (t) => {
	const root = await fixture(t, {
		plans: [["0017-orphan.md", "---\nfeature: F999\n---\n\n# Plan\n"]],
	});
	const result = check(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /feature F999 has no docs\/features\/F999-/);
});

test("rejects a BACKLOG row with a broken link", async (t) => {
	const root = await fixture(t, {
		rows: ["| F001 | Feature | done | 宪宪 | [F001](docs/features/missing.md) |"],
	});
	const result = check(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /F001 links to missing file docs\/features\/missing\.md/);
});
