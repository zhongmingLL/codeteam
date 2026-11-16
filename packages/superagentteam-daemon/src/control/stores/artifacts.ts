import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ControlError } from "../errors.ts";
import type { ControlTransaction } from "../transaction.ts";
import { type Clock, jsonObject, mapStoreError, newId, nonEmpty, parseJsonObject } from "./helpers.ts";
import type { Artifact, ArtifactKind, PutArtifactInput } from "./types.ts";

interface ArtifactRow {
	id: string;
	task_id: string | null;
	run_id: string | null;
	kind: ArtifactKind;
	sha256: string;
	path: string;
	media_type: string;
	bytes: number;
	provenance_json: string;
	approval_id: string | null;
	created_at: number;
}

function mapArtifact(row: ArtifactRow): Artifact {
	return {
		id: row.id,
		taskId: row.task_id,
		runId: row.run_id,
		kind: row.kind,
		sha256: row.sha256,
		path: row.path,
		mediaType: row.media_type,
		bytes: row.bytes,
		provenance: parseJsonObject(row.provenance_json),
		approvalId: row.approval_id,
		createdAt: row.created_at,
	};
}

export class ArtifactStore {
	private readonly database: DatabaseSync;
	private readonly transaction: ControlTransaction;
	private readonly clock: Clock;
	private readonly artifactRoot: string;

	constructor(database: DatabaseSync, transaction: ControlTransaction, clock: Clock, artifactRoot: string) {
		this.database = database;
		this.transaction = transaction;
		this.clock = clock;
		this.artifactRoot = artifactRoot;
		mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
		chmodSync(artifactRoot, 0o700);
	}

	get(id: string): Artifact | null {
		const row = this.database.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | undefined;
		return row ? mapArtifact(row) : null;
	}

	getPath(id: string): string | null {
		return this.get(id)?.path ?? null;
	}

	listByTask(taskId: string): Artifact[] {
		const rows = this.database
			.prepare("SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at, id")
			.all(taskId) as unknown as ArtifactRow[];
		return rows.map(mapArtifact);
	}

	listAll(): Artifact[] {
		const rows = this.database
			.prepare("SELECT * FROM artifacts ORDER BY created_at, id")
			.all() as unknown as ArtifactRow[];
		return rows.map(mapArtifact);
	}

	delete(id: string): Artifact {
		try {
			return this.transaction.run(() => {
				const current = this.get(id);
				if (!current) throw new ControlError("not_found", `artifact ${id} not found`);
				if (current.kind.startsWith("eval-")) {
					throw new ControlError("forbidden", `eval artifact ${id} is immutable and cannot be deleted`);
				}
				this.database.prepare("DELETE FROM artifacts WHERE id = ?").run(id);
				return current;
			});
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	put(input: PutArtifactInput): Artifact {
		if (!Buffer.isBuffer(input.content)) {
			throw new ControlError("invalid_input", "artifact content must be a Buffer");
		}
		const taskId = input.taskId ?? null;
		if (taskId !== null && taskId.trim() === "") {
			throw new ControlError("invalid_input", "taskId must not be empty");
		}
		const mediaType = nonEmpty(input.mediaType, "mediaType");
		const provenance = input.provenance;
		if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) {
			throw new ControlError("invalid_input", "artifact provenance must be an object");
		}
		const evalKind = input.kind.startsWith("eval-");
		if (taskId === null) {
			if (!evalKind) throw new ControlError("invalid_input", "domain-level artifacts must use an eval-* kind");
			if (input.runId) throw new ControlError("invalid_input", "domain-level eval artifacts must not bind a run");
			if (typeof provenance.evalVerdictId !== "string" || provenance.evalVerdictId.trim() === "") {
				throw new ControlError("invalid_input", "eval artifact provenance.evalVerdictId is required");
			}
		} else {
			if (evalKind) throw new ControlError("invalid_input", "eval-* artifacts must be domain-level (taskId null)");
			if (typeof provenance.sourceMessageId !== "string" || provenance.sourceMessageId.trim() === "") {
				throw new ControlError("invalid_input", "artifact provenance.sourceMessageId is required");
			}
		}
		const sha256 = createHash("sha256").update(input.content).digest("hex");
		const path = join(this.artifactRoot, sha256);
		if (existsSync(path)) {
			const existing = readFileSync(path);
			const existingHash = createHash("sha256").update(existing).digest("hex");
			if (existingHash !== sha256 || existing.length !== input.content.length) {
				throw new ControlError("conflict", `artifact content hash ${sha256} does not match the stored file`);
			}
		} else {
			const temp = join(this.artifactRoot, `.tmp-${randomUUID()}`);
			const fd = openSync(temp, "w", 0o600);
			try {
				writeSync(fd, input.content);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			chmodSync(temp, 0o600);
			renameSync(temp, path);
		}
		const id = input.id ?? newId();
		const createdAt = input.createdAt ?? this.clock();
		try {
			return this.transaction.run(() => {
				this.database
					.prepare(
						"INSERT INTO artifacts (id, task_id, run_id, kind, sha256, path, media_type, bytes, provenance_json, approval_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						id,
						taskId,
						input.runId ?? null,
						input.kind,
						sha256,
						path,
						mediaType,
						input.content.length,
						jsonObject(provenance, "provenance"),
						input.approvalId ?? null,
						createdAt,
					);
				return this.get(id)!;
			});
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
	}
}
