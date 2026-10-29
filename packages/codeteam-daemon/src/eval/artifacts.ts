import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import type { Artifact } from "../control/stores/types.ts";
import type {
	EvalArtifactKind,
	EvalArtifactRef,
	EvalMeasurementResultV1,
	LifecycleRootArtifact,
	LifecycleRootArtifactV1,
	VerdictHandoffPacketV1,
} from "./contract.ts";

export interface EvalArtifactSet {
	readonly refs: readonly EvalArtifactRef[];
	readonly lifecycleRoot: LifecycleRootArtifact;
	readonly lifecycleRootDigest: string;
	readonly manifestDigest: string;
	readonly totalBytes: number;
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

function artifactId(verdictId: string, kind: EvalArtifactKind, index: number): string {
	return `eval-artifact-${createHash("sha256").update(`${verdictId}\u001f${kind}\u001f${index}`, "utf8").digest("hex")}`;
}

function refOf(artifact: Artifact): EvalArtifactRef {
	return {
		artifactId: artifact.id,
		kind: artifact.kind as EvalArtifactKind,
		sha256: artifact.sha256,
		bytes: artifact.bytes,
		path: artifact.path,
	};
}

function putOrReuse(
	store: ControlStore,
	options: {
		readonly verdictId: string;
		readonly domainId: string;
		readonly kind: EvalArtifactKind;
		readonly index: number;
		readonly content: string;
	},
): Artifact {
	const id = artifactId(options.verdictId, options.kind, options.index);
	const existing = store.evalArtifacts.get(id);
	if (existing) {
		const digest = createHash("sha256").update(options.content, "utf8").digest("hex");
		if (existing.sha256 !== digest) {
			throw new ControlError("conflict", `eval artifact ${id} already exists with different content`);
		}
		return existing;
	}
	return store.evalArtifacts.put({
		id,
		taskId: null,
		runId: null,
		kind: options.kind,
		mediaType: "application/json",
		content: Buffer.from(options.content, "utf8"),
		provenance: {
			sourceKind: "eval",
			evalVerdictId: options.verdictId,
			evalDomainId: options.domainId,
		},
	});
}

export function writeEvalArtifacts(options: {
	readonly store: ControlStore;
	readonly packet: VerdictHandoffPacketV1;
	readonly measurement: EvalMeasurementResultV1;
	readonly maxBytes?: number;
}): EvalArtifactSet {
	const { store, packet, measurement } = options;
	const lifecycleRoot = buildLifecycleRootArtifact(packet);
	const files: Array<{ kind: EvalArtifactKind; content: string }> = [
		{ kind: "eval-verdict", content: `${JSON.stringify(packet, null, 2)}\n` },
		{ kind: "eval-lifecycle-root", content: `${JSON.stringify(lifecycleRoot, null, 2)}\n` },
		{ kind: "eval-snapshot", content: `${JSON.stringify(packet.evidencePacket, null, 2)}\n` },
		{
			kind: "eval-attribution",
			content: `${JSON.stringify(
				{
					verdictId: packet.id,
					domainId: packet.domainId,
					dailyTrend: packet.dailyTrend,
					rootCauseHypothesis: packet.rootCauseHypothesis,
					counterarguments: packet.counterarguments,
				},
				null,
				2,
			)}\n`,
		},
		{ kind: "eval-measurement-result", content: `${JSON.stringify(measurement, null, 2)}\n` },
		...(packet.findingKey
			? [
					{
						kind: "eval-finding" as const,
						content: `${JSON.stringify({ verdictId: packet.id, findingKey: packet.findingKey }, null, 2)}\n`,
					},
				]
			: []),
	];
	const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
	const plannedBytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.content, "utf8"), 0);
	if (plannedBytes > maxBytes) {
		throw new ControlError("invalid_input", `eval bundle exceeds CODETEAM_EVAL_BUNDLE_MAX_BYTES (${maxBytes})`);
	}
	const refs: EvalArtifactRef[] = [];
	let totalBytes = 0;
	const seen = new Map<EvalArtifactKind, number>();
	for (const file of files) {
		const index = seen.get(file.kind) ?? 0;
		seen.set(file.kind, index + 1);
		const artifact = putOrReuse(store, {
			verdictId: packet.id,
			domainId: packet.domainId,
			kind: file.kind,
			index,
			content: file.content,
		});
		refs.push(refOf(artifact));
		totalBytes += artifact.bytes;
	}
	return {
		refs,
		lifecycleRoot,
		lifecycleRootDigest: digestLifecycleRootArtifact(lifecycleRoot),
		manifestDigest: digestEvalArtifactManifest(refs),
		totalBytes,
	};
}

export function readEvalArtifact(store: ControlStore, ref: EvalArtifactRef): string {
	const artifact = store.artifacts.get(ref.artifactId);
	if (!artifact) throw new ControlError("not_found", `eval artifact ${ref.artifactId} not found`);
	if (artifact.kind !== ref.kind || artifact.sha256 !== ref.sha256 || artifact.bytes !== ref.bytes) {
		throw new ControlError("invalid_state", `eval artifact ${ref.artifactId} metadata mismatch`);
	}
	let bytes: Buffer;
	try {
		bytes = readFileSync(artifact.path);
	} catch (error) {
		throw new ControlError("not_found", `eval artifact ${ref.artifactId} is not readable`, { cause: error });
	}
	const digest = createHash("sha256").update(bytes).digest("hex");
	if (digest !== artifact.sha256 || bytes.length !== artifact.bytes) {
		throw new ControlError("invalid_state", `eval artifact ${ref.artifactId} digest mismatch`);
	}
	return bytes.toString("utf8");
}
