import { lstatSync, readdirSync, type Stats, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import type { Artifact } from "../control/stores/types.ts";

export interface ArtifactGcOptions {
	readonly rootDir: string;
	readonly logRetentionMs?: number;
	readonly orphanTtlMs?: number;
}

export interface ArtifactGcEntry {
	readonly id: string | null;
	readonly path: string;
	readonly reason: "expired_log" | "orphan_ttl";
	readonly bytes: number;
}

export interface ArtifactGcReport {
	readonly dryRun: boolean;
	readonly entries: readonly ArtifactGcEntry[];
	readonly bytesFreed: number;
}

const PROTECTED_KINDS = new Set<Artifact["kind"]>([
	"spec",
	"plan",
	"diff",
	"test-report",
	"review",
	"verification",
	"merge-receipt",
	"eval-verdict",
	"eval-lifecycle-root",
	"eval-finding",
	"eval-snapshot",
	"eval-attribution",
	"eval-measurement-result",
]);

function positiveInteger(value: number, field: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new ControlError("invalid_input", `${field} must be a positive integer`);
	}
	return value;
}

export class ArtifactGCService {
	private readonly store: ControlStore;
	private readonly rootDir: string;
	private readonly logRetentionMs: number;
	private readonly orphanTtlMs: number;

	constructor(store: ControlStore, options: ArtifactGcOptions) {
		this.store = store;
		this.rootDir = resolve(options.rootDir);
		this.logRetentionMs = positiveInteger(
			options.logRetentionMs ??
				Number(process.env.CODETEAM_ARTIFACT_LOG_RETENTION_MS ?? String(7 * 24 * 60 * 60 * 1000)),
			"logRetentionMs",
		);
		this.orphanTtlMs = positiveInteger(
			options.orphanTtlMs ?? Number(process.env.CODETEAM_ARTIFACT_ORPHAN_TTL_MS ?? String(24 * 60 * 60 * 1000)),
			"orphanTtlMs",
		);
	}

	collect(options: { now?: number; dryRun?: boolean; actorRef?: string } = {}): ArtifactGcReport {
		const now = options.now ?? Date.now();
		const dryRun = options.dryRun ?? true;
		const entries: ArtifactGcEntry[] = [];
		const artifacts = this.store.artifacts.listAll();
		const referenced = new Set(artifacts.map((artifact) => resolve(artifact.path)));
		for (const artifact of artifacts) {
			if (PROTECTED_KINDS.has(artifact.kind)) continue;
			if (artifact.kind !== "log") continue;
			if (artifact.taskId === null) continue;
			const task = this.store.tasks.get(artifact.taskId);
			if (!task || task.status !== "done") continue;
			if (artifact.createdAt + this.logRetentionMs > now) continue;
			const bytes = fileBytes(artifact.path);
			entries.push({ id: artifact.id, path: artifact.path, reason: "expired_log", bytes });
			if (!dryRun) {
				this.store.artifacts.delete(artifact.id);
				removeFile(artifact.path);
				this.store.audit.append({
					actor: options.actorRef ?? "system:artifact-gc",
					action: "artifact_collected",
					subject: `artifact:${artifact.id}`,
					args: { path: artifact.path, kind: artifact.kind, reason: "expired_log" },
				});
			}
		}
		let dirEntries: string[] = [];
		try {
			dirEntries = readdirSync(this.rootDir);
		} catch {
			dirEntries = [];
		}
		for (const entry of dirEntries) {
			const path = join(this.rootDir, entry);
			if (referenced.has(resolve(path))) continue;
			let stat: Stats;
			try {
				stat = lstatSync(path);
			} catch {
				continue;
			}
			if (!stat.isFile() || stat.isSymbolicLink()) continue;
			if (stat.mtimeMs + this.orphanTtlMs > now) continue;
			entries.push({ id: null, path, reason: "orphan_ttl", bytes: stat.size });
			if (!dryRun) {
				removeFile(path);
				this.store.audit.append({
					actor: options.actorRef ?? "system:artifact-gc",
					action: "artifact_orphan_collected",
					subject: "artifact:orphan",
					args: { path },
				});
			}
		}
		return { dryRun, entries, bytesFreed: entries.reduce((sum, entry) => sum + entry.bytes, 0) };
	}
}

function fileBytes(path: string): number {
	try {
		const stat = lstatSync(path);
		return stat.isFile() && !stat.isSymbolicLink() ? stat.size : 0;
	} catch {
		return 0;
	}
}

function removeFile(path: string): void {
	try {
		const stat = lstatSync(path);
		if (stat.isFile() && !stat.isSymbolicLink()) unlinkSync(path);
	} catch {
		// Missing file is already collected.
	}
}
