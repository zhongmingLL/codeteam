import assert from "node:assert/strict";
import { test } from "node:test";
import { classify } from "./classify-ci-scope.mjs";

test("docs-only changes use the docs lane", () => {
	assert.equal(classify(["docs/features/F002.md", "BACKLOG.md", "README.md"]), "docs");
});

test("SuperAgentTeam package changes use the SuperAgentTeam lane", () => {
	assert.equal(
		classify(["packages/superagentteam-pi-adapter/src/index.ts", "docs/reports/r.md"]),
		"superagentteam",
	);
});

test("mixed SuperAgentTeam package changes stay in the SuperAgentTeam lane", () => {
	assert.equal(
		classify(["packages/superagentteam-daemon/test/daemon.test.ts", "packages/superagentteam-skills/package.json"]),
		"superagentteam",
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
