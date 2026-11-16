import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyControlMigrations,
	CONTROL_DATABASE_FILE,
	CONTROL_MIGRATIONS,
	ControlError,
	configureControlDatabase,
	openControlStore,
} from "../src/index.ts";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "codeteam-eval-schema-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function expectCode(fn: () => unknown, code: string): void {
	try {
		fn();
		throw new Error("expected ControlError");
	} catch (error) {
		expect(error).toBeInstanceOf(ControlError);
		expect((error as ControlError).code).toBe(code);
	}
}

describe("W6b eval schema", () => {
	it("adds eval lifecycle storage and keeps legacy evals readable", () => {
		const database = new DatabaseSync(":memory:");
		configureControlDatabase(database);
		applyControlMigrations(database);
		expect(CONTROL_MIGRATIONS.at(-1)?.version).toBe(16);
		expect(
			database
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'eval_lifecycle_events'")
				.get(),
		).toBeDefined();
		const columns = database.prepare("PRAGMA table_info(evals)").all() as unknown as {
			name: string;
			notnull: number;
		}[];
		const taskId = columns.find((column) => column.name === "task_id");
		expect(taskId?.notnull).toBe(0);
		for (const name of [
			"domain_id",
			"bundle_id",
			"verdict_id",
			"window_start_ms",
			"window_end_ms",
			"measurement_ref",
			"status",
			"reasons_json",
		]) {
			expect(columns.some((column) => column.name === name)).toBe(true);
		}
		const artifactColumns = database.prepare("PRAGMA table_info(artifacts)").all() as unknown as {
			name: string;
			notnull: number;
		}[];
		expect(artifactColumns.find((column) => column.name === "task_id")?.notnull).toBe(0);
		const lifecycleColumns = database.prepare("PRAGMA table_info(eval_lifecycle_events)").all() as unknown as {
			name: string;
		}[];
		for (const name of [
			"event_id",
			"case_id",
			"seq",
			"domain_id",
			"event_type",
			"actor_kind",
			"actor_id",
			"payload_json",
			"occurred_at",
			"created_at",
		]) {
			expect(lifecycleColumns.some((column) => column.name === name)).toBe(true);
		}
		expect(lifecycleColumns.some((column) => column.name === "verdict_id")).toBe(false);
		database.close();
	});

	it("requires reasons for non-ok evals at both the store and DB boundaries", () => {
		const dataDir = tempDir();
		const store = openControlStore({ dataDir });
		store.seedIdentity({
			eval: { provider: "test", model: "eval", modelFamily: "glm" },
			compress: { provider: "test", model: "c", modelFamily: "glm" },
		});
		store.threads.create({ id: "thread-eval", title: "Eval" });
		store.profiles.create({
			id: "profile:owner",
			role: "coder",
			displayName: "Owner",
			provider: "test",
			model: "glm-owner",
			modelFamily: "glm",
			toolPolicyProfile: "default",
		});
		expectCode(
			() =>
				store.evals.create({
					taskId: null,
					provider: "test",
					model: "eval",
					role: "eval",
					metrics: {},
					domainId: "eval:test-domain",
					status: "insufficient",
					reasons: [],
				}),
			"invalid_input",
		);
		expect(() =>
			store.database
				.prepare(
					"INSERT INTO evals (id, task_id, provider, model, role, metrics_json, created_at, domain_id, status) VALUES ('bad', NULL, 'test', 'eval', 'eval', '{}', 1, 'eval:test-domain', 'insufficient')",
				)
				.run(),
		).toThrow(/CHECK constraint failed/);
		const valid = store.evals.create({
			taskId: null,
			provider: "test",
			model: "eval",
			role: "eval",
			metrics: {},
			domainId: "eval:test-domain",
			status: "insufficient",
			reasons: ["n<20"],
			windowStartMs: 1,
			windowEndMs: 2,
			measurementRef: "measurement:1",
		});
		expect(valid.reasons).toEqual(["n<20"]);
		const evalArtifact = store.evalArtifacts.put({
			taskId: null,
			kind: "eval-verdict",
			mediaType: "application/json",
			content: Buffer.from("{}\n"),
			provenance: { sourceKind: "eval", evalVerdictId: "verdict-1", evalDomainId: "eval:test-domain" },
		});
		expect(evalArtifact.taskId).toBeNull();
		expect(store.evalArtifacts.get(evalArtifact.id)?.kind).toBe("eval-verdict");
		expect(() => store.evalArtifacts.delete(evalArtifact.id)).toThrow(/immutable/);
		store.close();
	});

	it("migrates a v14 database without losing old eval rows", () => {
		const dataDir = tempDir();
		mkdirSync(dataDir, { recursive: true, mode: 0o700 });
		const database = new DatabaseSync(join(dataDir, CONTROL_DATABASE_FILE));
		configureControlDatabase(database);
		applyControlMigrations(database, CONTROL_MIGRATIONS.slice(0, 14));
		database
			.prepare(
				"INSERT INTO roles (id, label, status, created_at, updated_at) VALUES ('coder', 'Coder', 'active', 1, 1)",
			)
			.run();
		database
			.prepare(
				"INSERT INTO threads (id, title, status, created_at, updated_at) VALUES ('thread-old', 'Old', 'active', 1, 1)",
			)
			.run();
		database
			.prepare(
				"INSERT INTO tasks (id, kind, thread_id, subject_key, title, why, status, created_by, created_at, updated_at) VALUES ('task-old', 'pr_tracking', 'thread-old', 'pr:test/1', 'Task', 'Why', 'done', 'user', 1, 1)",
			)
			.run();
		database
			.prepare(
				"INSERT INTO evals (id, task_id, provider, model, role, metrics_json, created_at) VALUES ('eval-old', 'task-old', 'test', 'glm-old', 'coder', '{\"a2a_tool_call_success\":1}', 5)",
			)
			.run();
		database.close();

		const store = openControlStore({ dataDir });
		const legacy = store.evals.get("eval-old")!;
		expect(legacy.taskId).toBe("task-old");
		expect(legacy.status).toBeNull();
		expect(legacy.reasons).toEqual([]);
		expect(legacy.domainId).toBeNull();
		store.close();
	});
});
