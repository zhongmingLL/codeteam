import assert from "node:assert/strict";
import { test } from "node:test";
import { classify } from "./classify-ci-scope.mjs";

test("docs-only changes use the docs lane", () => {
	assert.equal(classify(["docs/features/F002.md", "BACKLOG.md", "README.md"]), "docs");
});

test("codeteam package changes use the codeteam lane", () => {
	assert.equal(
		classify(["packages/codeteam-pi-adapter/src/index.ts", "docs/reports/r.md"]),
		"codeteam",
	);
});

test("mixed codeteam package changes stay in the codeteam lane", () => {
	assert.equal(
		classify(["packages/codeteam-daemon/test/daemon.test.ts", "packages/codeteam-skills/package.json"]),
		"codeteam",
	);
});

test("upstream package changes require the full suite", () => {
	assert.equal(classify(["packages/coding-agent/src/index.ts"]), "upstream");
});

test("root and tooling changes require the full suite", () => {
	assert.equal(classify(["package.json"]), "upstream");
	assert.equal(classify(["package-lock.json"]), "upstream");
	assert.equal(classify([".github/workflows/ci.yml"]), "upstream");
	assert.equal(classify(["scripts/classify-ci-scope.mjs"]), "upstream");
	assert.equal(classify(["nix/model-catalog.json"]), "upstream");
});

test("empty or unknown diffs fail closed to the full suite", () => {
	assert.equal(classify([]), "upstream");
	assert.equal(classify(["unknown/file.txt"]), "upstream");
	assert.equal(classify(["docs/a.md", "packages/ai/src/index.ts"]), "upstream");
});
