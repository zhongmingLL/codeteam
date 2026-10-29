import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { ControlError } from "../control/errors.ts";
import type {
	EvalArtifactRef,
	LifecycleRootArtifact,
	LifecycleRootArtifactV1,
	VerdictHandoffPacketV1,
} from "./contract.ts";

export interface EvalArtifactSet {
	readonly rootDir: string;
	readonly refs: readonly EvalArtifactRef[];
	readonly lifecycleRoot: LifecycleRootArtifact;
	readonly lifecycleRootDigest: string;
	readonly manifestDigest: string;
}

export function buildLifecycleRootArtifact(packet: VerdictHandoffPacketV1): LifecycleRootArtifact {
	const base: LifecycleRootArtifactV1 = {
		schemaVersion: 1,
		verdictId: packet.id,
		domainId: packet.domainId,
		createdAt: packet.createdAt,
		verdict: packet.verdict,
		harnessUnderEval: packet.harnessUnderEval,
		ownerAsk: packet.ownerAsk,
		acceptanceReevalPlan: packet.acceptanceReevalPlan,
	};
	if (!packet.findingKey) return base;
	const digest = createHash("sha256").update(`${packet.domainId}\u001f${packet.findingKey}`, "utf8").digest("hex");
	return {
		...base,
		schemaVersion: 2,
		caseId: `eval-case-v1-${digest}`,
		findingKey: packet.findingKey,
	};
}

export function digestLifecycleRootArtifact(artifact: LifecycleRootArtifact): string {
	return createHash("sha256")
		.update(`${JSON.stringify(artifact, null, 2)}\n`, "utf8")
		.digest("hex");
}

export function digestEvalArtifactManifest(refs: readonly EvalArtifactRef[]): string {
	const lines = [...refs]
		.map((ref) => `${ref.kind}\t${ref.sha256}\t${ref.bytes}`)
		.sort()
		.join("\n");
	return createHash("sha256").update(`${lines}\n`, "utf8").digest("hex");
}

function immutableFile(path: string, content: string): { sha256: string; bytes: number } {
	const bytes = Buffer.from(content, "utf8");
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	if (existsSync(path)) {
		const existing = readFileSync(path);
		const existingHash = createHash("sha256").update(existing).digest("hex");
		if (existingHash !== sha256) {
			throw new ControlError("conflict", `eval artifact ${path} already exists with different content`);
		}
		return { sha256, bytes: existing.length };
	}
	const fd = openSync(path, "wx", 0o600);
	try {
		writeSync(fd, bytes);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	chmodSync(path, 0o600);
	return { sha256, bytes: bytes.length };
}

export function writeEvalArtifacts(options: {
	readonly dataDir: string;
	readonly packet: VerdictHandoffPacketV1;
}): EvalArtifactSet {
	const { dataDir, packet } = options;
	const rootDir = join(dataDir, "eval-artifacts", packet.id);
	mkdirSync(rootDir, { recursive: true, mode: 0o700 });
	chmodSync(rootDir, 0o700);
	const lifecycleRoot = buildLifecycleRootArtifact(packet);
	const files: Array<{ kind: EvalArtifactRef["kind"]; name: string; content: string }> = [
		{ kind: "eval-verdict", name: "verdict.json", content: `${JSON.stringify(packet, null, 2)}\n` },
		{
			kind: "eval-snapshot",
			name: "snapshot.json",
			content: `${JSON.stringify(packet.evidencePacket, null, 2)}\n`,
		},
		{
			kind: "eval-attribution",
			name: "attribution.json",
			content: `${JSON.stringify(
				{
					verdictId: packet.id,
					domainId: packet.domainId,
					rootCauseHypothesis: packet.rootCauseHypothesis,
					counterarguments: packet.counterarguments,
					measurement: packet.evidencePacket.measurement,
				},
				null,
				2,
			)}\n`,
		},
		{
			kind: "lifecycle-root",
			name: "lifecycle-root.json",
			content: `${JSON.stringify(lifecycleRoot, null, 2)}\n`,
		},
		...packet.findings.map((finding, index) => ({
			kind: "eval-finding" as const,
			name: `finding-${index}.json`,
			content: `${JSON.stringify({ verdictId: packet.id, findingIndex: index, finding }, null, 2)}\n`,
		})),
	];
	const refs: EvalArtifactRef[] = files.map((file) => {
		const path = join(rootDir, file.name);
		const digest = immutableFile(path, file.content);
		return { kind: file.kind, path, sha256: digest.sha256, bytes: digest.bytes };
	});
	return {
		rootDir,
		refs,
		lifecycleRoot,
		lifecycleRootDigest: digestLifecycleRootArtifact(lifecycleRoot),
		manifestDigest: digestEvalArtifactManifest(refs),
	};
}

export function readEvalArtifact(ref: EvalArtifactRef): string {
	let bytes: Buffer;
	try {
		bytes = readFileSync(ref.path);
	} catch (error) {
		throw new ControlError("not_found", `eval artifact ${ref.path} is not readable`, { cause: error });
	}
	const digest = createHash("sha256").update(bytes).digest("hex");
	if (digest !== ref.sha256 || bytes.length !== ref.bytes) {
		throw new ControlError("invalid_state", `eval artifact ${ref.path} digest mismatch`);
	}
	return bytes.toString("utf8");
}
