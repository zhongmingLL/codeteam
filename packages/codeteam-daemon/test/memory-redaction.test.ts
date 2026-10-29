import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	defaultMemoryDenyPrefixes,
	evaluateMemoryPath,
	isAllowedEvidenceFile,
	redactSecrets,
	scanSecrets,
} from "../src/memory/redaction.ts";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "codeteam-memory-redaction-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("secret scanning", () => {
	it("detects representative provider tokens and private keys", () => {
		const text = [
			"AWS AKIAIOSFODNN7EXAMPLE here",
			"github ghp_abcdefghijklmnopqrstuvwxyz0123456789",
			"openai sk-abcdefghijklmnopqrstuvwxyz0123456789",
			"anthropic sk-ant-abcdefghijklmnopqrstuvwxyz0123456789",
			"slack xoxb-1234567890-abcdefghij",
			"-----BEGIN OPENSSH PRIVATE KEY-----",
			'password = "correct-horse-battery-staple"',
		].join("\n");
		const names = new Set(scanSecrets(text).map((finding) => finding.pattern));
		expect(names.has("aws_access_key")).toBe(true);
		expect(names.has("github_token")).toBe(true);
		expect(names.has("openai_key")).toBe(true);
		expect(names.has("anthropic_key")).toBe(true);
		expect(names.has("slack_token")).toBe(true);
		expect(names.has("private_key")).toBe(true);
		expect(names.has("assigned_secret")).toBe(true);
	});

	it("detects high-entropy mixed tokens but not git SHAs or UUIDs", () => {
		const highEntropy = "aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY3zA5bC7dE9fG";
		const sha = "a".repeat(64);
		const uuid = "123e4567-e89b-12d3-a456-426614174000";
		const names = scanSecrets(`${highEntropy}\n${sha}\n${uuid}`).map((finding) => finding.pattern);
		expect(names).toContain("high_entropy");
		expect(scanSecrets(sha)).toHaveLength(0);
		expect(scanSecrets(uuid)).toHaveLength(0);
	});

	it("does not flag real repo paths, kebab slugs or sha256 references as high-entropy secrets", () => {
		const kebab = "docs/reports/2026-10-28-w5d-runtime-lifecycle-managed-work";
		const shaRef = `dev/api/models/revisions/sha256-${"a".repeat(64)}`;
		const shortShaRef = `dev/api/models/revisions/sha256-${"b".repeat(32)}`;
		expect(scanSecrets(kebab)).toHaveLength(0);
		expect(scanSecrets(shaRef)).toHaveLength(0);
		expect(scanSecrets(shortShaRef)).toHaveLength(0);
	});

	it("still detects a high-entropy secret embedded next to a path separator", () => {
		const secret = "aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY3zA5bC7dE9fG";
		expect(scanSecrets(`prefix/${secret}`).map((finding) => finding.pattern)).toContain("high_entropy");
	});

	it("redacts a complete private key block including the body", () => {
		const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAsecretbody1234\n-----END OPENSSH PRIVATE KEY-----";
		const result = redactSecrets(key);
		expect(result.text).toContain("[REDACTED:private_key]");
		expect(result.text).not.toContain("AAAAsecretbody1234");
	});

	it("redacts matches without leaking the secret value", () => {
		const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
		const result = redactSecrets(`token: ${secret}`);
		expect(result.text).not.toContain(secret);
		expect(result.text).toContain("[REDACTED:github_token]");
		expect(result.findings.map((finding) => finding.pattern)).toContain("github_token");
	});
});

describe("path policy", () => {
	it("allows repo-relative docs and normalizes absolute paths under the root", () => {
		const root = tempDir();
		mkdirSync(join(root, "docs", "features"), { recursive: true });
		writeFileSync(join(root, "docs", "features", "F001.md"), "# F001\n");
		const relative = evaluateMemoryPath("docs/features/F001.md", { root });
		expect(relative).toMatchObject({ allowed: true, relativePath: "docs/features/F001.md" });
		const absolute = evaluateMemoryPath(join(root, "docs", "features", "F001.md"), { root });
		expect(absolute).toMatchObject({ allowed: true, relativePath: "docs/features/F001.md" });
	});

	it("denies traversal, outside-root absolute paths, denied prefixes and denied names", () => {
		const root = tempDir();
		mkdirSync(join(root, "docs"), { recursive: true });
		writeFileSync(join(root, "docs", "ok.md"), "# ok\n");
		expect(evaluateMemoryPath("../outside.md", { root })).toMatchObject({ allowed: false, reason: "outside_root" });
		expect(evaluateMemoryPath("/etc/passwd", { root })).toMatchObject({ allowed: false });
		expect(
			evaluateMemoryPath(join(root, "docs", "id_rsa"), { root, denyPrefixes: [join(homedir(), ".ssh")] }),
		).toMatchObject({ allowed: false, reason: "denied_name" });
		expect(evaluateMemoryPath(join(root, "docs", ".env"), { root })).toMatchObject({
			allowed: false,
			reason: "denied_name",
		});
	});

	it("denies symlinks that escape the collection root", () => {
		const root = tempDir();
		const outside = tempDir();
		writeFileSync(join(outside, "secret.md"), "# secret\n");
		symlinkSync(outside, join(root, "linked"));
		expect(evaluateMemoryPath("linked/secret.md", { root })).toMatchObject({
			allowed: false,
			reason: "symlink_escape",
		});
	});

	it("uses the documented default deny prefixes and document filter", () => {
		const prefixes = defaultMemoryDenyPrefixes();
		expect(prefixes).toContain(join(homedir(), ".ssh"));
		expect(prefixes).toContain(join(homedir(), ".aws"));
		expect(prefixes).toContain(join(homedir(), ".cat-cafe"));
		expect(isAllowedEvidenceFile("docs/features/F001.md")).toBe(true);
		expect(isAllowedEvidenceFile("AGENTS.md")).toBe(true);
		expect(isAllowedEvidenceFile("node_modules/pkg/readme.md")).toBe(false);
		expect(isAllowedEvidenceFile("docs/features/.env")).toBe(false);
		expect(isAllowedEvidenceFile("docs/keys/server.pem")).toBe(false);
		expect(isAllowedEvidenceFile("docs/image.png")).toBe(false);
	});
});
