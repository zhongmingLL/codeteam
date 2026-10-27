import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	assertApprovalDecisionPrincipal,
	assertMergeExecutionPrincipal,
	initOperatorCredential,
	issueMergeServiceCredential,
	loadOperatorPrivateKey,
	loadOperatorPublicKey,
	MAX_MERGE_CREDENTIAL_TTL_MS,
	MERGE_SERVICE_ACTOR,
	type MergeCredentialBinding,
	operatorCredentialPaths,
	principalFromOperatorProof,
	principalFromRunId,
	principalFromVerifiedMergeCredential,
	resolveOperatorCredentialsDir,
	signOperatorPayload,
	verifyMergeServiceCredential,
	verifyOperatorSignature,
} from "../src/index.ts";

const NOW = 1_700_000_000_000;
const HEAD = "a".repeat(40);
const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const dirs: string[] = [];
let dataDir: string;

const binding: MergeCredentialBinding = { repo: "owner/repo", prRef: "pr:1", headSha: HEAD };

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "codeteam-operator-"));
	dirs.push(dataDir);
});

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("codeteam operator credentials", () => {
	it("initializes 0600 key files under a 0700 directory and is idempotent", () => {
		const first = initOperatorCredential({ dataDir });
		expect(first.fingerprint).toMatch(/^[0-9a-f]{16}$/);
		expect(statSync(resolveOperatorCredentialsDir(dataDir)).mode & 0o777).toBe(0o700);
		expect(statSync(first.privateKeyPath).mode & 0o777).toBe(0o600);
		expect(statSync(first.publicKeyPath).mode & 0o777).toBe(0o600);
		expect(initOperatorCredential({ dataDir }).fingerprint).toBe(first.fingerprint);

		const rotated = initOperatorCredential({ dataDir, rotate: true });
		expect(rotated.fingerprint).not.toBe(first.fingerprint);
	});

	it("signs and verifies payloads, and rotation invalidates old signatures", () => {
		initOperatorCredential({ dataDir });
		const signature = signOperatorPayload(loadOperatorPrivateKey(dataDir), "payload");
		const publicKey = loadOperatorPublicKey(dataDir);
		expect(verifyOperatorSignature(publicKey, "payload", signature)).toBe(true);
		expect(verifyOperatorSignature(publicKey, "other", signature)).toBe(false);

		initOperatorCredential({ dataDir, rotate: true });
		expect(verifyOperatorSignature(loadOperatorPublicKey(dataDir), "payload", signature)).toBe(false);
	});

	it("fails closed when the credential is not initialized", () => {
		expect(() => operatorCredentialPaths(dataDir)).toThrowError(expect.objectContaining({ code: "not_found" }));
	});

	it("issues merge credentials bound to repo, PR, and exact head with a short TTL", () => {
		initOperatorCredential({ dataDir });
		const privateKey = loadOperatorPrivateKey(dataDir);
		const publicKey = loadOperatorPublicKey(dataDir);
		const credential = issueMergeServiceCredential(privateKey, binding, { ttlMs: 60_000, now: NOW });

		expect(credential.expiresAt).toBe(NOW + 60_000);
		expect(verifyMergeServiceCredential(publicKey, credential.token, binding, { now: NOW + 1_000 })).toMatchObject({
			actor: MERGE_SERVICE_ACTOR,
			headSha: HEAD,
		});
		expect(() =>
			verifyMergeServiceCredential(publicKey, credential.token, binding, { now: NOW + 120_000 }),
		).toThrow();
		expect(() =>
			verifyMergeServiceCredential(
				publicKey,
				credential.token,
				{ ...binding, headSha: "b".repeat(40) },
				{ now: NOW },
			),
		).toThrow();
		expect(() => verifyMergeServiceCredential(publicKey, `${credential.token}x`, binding, { now: NOW })).toThrow();
		expect(() =>
			issueMergeServiceCredential(privateKey, binding, { ttlMs: MAX_MERGE_CREDENTIAL_TTL_MS + 1, now: NOW }),
		).toThrow();
	});

	it("separates operator, run, and service principals for gated actions", () => {
		initOperatorCredential({ dataDir });
		const publicPem = readFileSync(operatorCredentialPaths(dataDir).publicKeyPath, "utf8");
		const privateKey = loadOperatorPrivateKey(dataDir);
		const payload = "approval:decide:42";
		const operator = principalFromOperatorProof({
			publicKeyPem: publicPem,
			payload,
			signature: signOperatorPayload(privateKey, payload),
		});
		assertApprovalDecisionPrincipal(operator);

		const runPrincipal = principalFromRunId("run-1");
		expect(() => assertApprovalDecisionPrincipal(runPrincipal)).toThrow();
		expect(() => assertMergeExecutionPrincipal(runPrincipal)).toThrow();
		expect(() => assertMergeExecutionPrincipal(operator)).toThrow();
		expect(() =>
			principalFromOperatorProof({ publicKeyPem: publicPem, payload, signature: "not-a-signature" }),
		).toThrow();

		const credential = issueMergeServiceCredential(privateKey, binding, { ttlMs: 60_000 });
		const verified = verifyMergeServiceCredential(loadOperatorPublicKey(dataDir), credential.token, binding);
		assertMergeExecutionPrincipal(principalFromVerifiedMergeCredential(verified));
	});

	it("initializes the operator credential through the CLI", () => {
		const output = execFileSync(process.execPath, [cliPath, "auth", "init", "--data-dir", dataDir], {
			encoding: "utf8",
		});
		const parsed = JSON.parse(output.trim()) as { fingerprint: string; dataDir: string };
		expect(parsed.dataDir).toBe(dataDir);
		expect(parsed.fingerprint).toMatch(/^[0-9a-f]{16}$/);

		const equals = execFileSync(process.execPath, [cliPath, "auth", "init", `--data-dir=${dataDir}`], {
			encoding: "utf8",
		});
		expect((JSON.parse(equals.trim()) as { fingerprint: string }).fingerprint).toBe(parsed.fingerprint);

		const rotated = execFileSync(process.execPath, [cliPath, "auth", "init", "--data-dir", dataDir, "--rotate"], {
			encoding: "utf8",
		});
		const rotatedParsed = JSON.parse(rotated.trim()) as { fingerprint: string };
		expect(rotatedParsed.fingerprint).not.toBe(parsed.fingerprint);
	});
});
