import { describe, expect, it } from "vitest";
import {
	createRedactor,
	isClassAKey,
	isClassBKey,
	isClassCKey,
	redactLogFields,
	redactTraceAttributes,
} from "../src/observability/redaction.ts";

describe("W6c A-D redaction", () => {
	const redactor = createRedactor({ salt: "test-salt" });

	it("classifies credential, content, and identifier keys", () => {
		expect(isClassAKey("authorization")).toBe(true);
		expect(isClassAKey("X-Api-Key")).toBe(true);
		expect(isClassAKey("refresh_token")).toBe(true);
		expect(isClassBKey("prompt")).toBe(true);
		expect(isClassBKey("body_md")).toBe(true);
		expect(isClassBKey("diff")).toBe(true);
		expect(isClassCKey("invocationId")).toBe(true);
		expect(isClassCKey("thread_id")).toBe(true);
		expect(isClassAKey("role")).toBe(false);
	});

	it("never keeps credential values", () => {
		const result = redactor.redactLogFields({
			authorization: "Bearer very-secret",
			password: "hunter2",
			ok: 1,
		});
		expect(result.authorization).toBe("[REDACTED]");
		expect(result.password).toBe("[REDACTED]");
		expect(result.ok).toBe(1);
		expect(JSON.stringify(result)).not.toContain("very-secret");
		expect(JSON.stringify(result)).not.toContain("hunter2");
	});

	it("replaces content with a digest and length instead of raw text", () => {
		const result = redactor.redactLogFields({
			body_md: "raw message body",
			diff: "diff --git a/a.ts b/a.ts",
			nested: { prompt: "raw prompt", ok: true },
		});
		expect(result.body_md).toMatch(/^\[content:sha256:[0-9a-f]{16} len:16\]$/);
		expect(result.diff).toMatch(/^\[content:sha256:[0-9a-f]{16} len:24\]$/);
		expect((result.nested as Record<string, unknown>).prompt).toMatch(/^\[content:sha256:/);
		expect((result.nested as Record<string, unknown>).ok).toBe(true);
		expect(JSON.stringify(result)).not.toContain("raw message body");
		expect(JSON.stringify(result)).not.toContain("raw prompt");
	});

	it("HMACs identifiers deterministically", () => {
		const first = redactor.hmacId("run-1");
		const second = redactor.hmacId("run-1");
		const other = redactor.hmacId("run-2");
		expect(first).toMatch(/^[0-9a-f]{32}$/);
		expect(first).toBe(second);
		expect(first).not.toBe(other);
	});

	it("drops unknown trace attributes and redacts known content keys", () => {
		const { attributes, dropped } = redactTraceAttributes(
			{
				"invocation.id": "run-1",
				"tool.name": "bash",
				"tool.category": "native",
				prompt: "raw prompt",
				"unknown.key": "nope",
			},
			redactor,
		);
		expect(attributes["invocation.id"]).toBe(redactor.hmacId("run-1"));
		expect(attributes["tool.name"]).toBe("bash");
		expect(attributes["tool.category"]).toBe("native");
		expect(attributes.prompt).toBeUndefined();
		expect(attributes["unknown.key"]).toBeUndefined();
		expect(dropped).toBe(2);
		expect(JSON.stringify(attributes)).not.toContain("raw prompt");
	});

	it("enforces trace attribute types", () => {
		const { attributes, dropped } = redactTraceAttributes(
			{ "tool.duration_ms": "not-a-number", "run.attempt": 2, "run.status": "completed" },
			redactor,
		);
		expect(attributes["tool.duration_ms"]).toBeUndefined();
		expect(attributes["run.attempt"]).toBe(2);
		expect(attributes["run.status"]).toBe("completed");
		expect(dropped).toBe(1);
	});

	it("bounds nested log fields without throwing", () => {
		let nested: Record<string, unknown> = { ok: true };
		for (let index = 0; index < 12; index += 1) nested = { nested };
		const result = redactLogFields({ nested }, redactor);
		expect(JSON.stringify(result)).toContain("max_depth");
		expect(JSON.stringify(result)).not.toContain("undefined");
	});

	it("redacts non-string content values to a typed marker", () => {
		const result = redactor.redactLogFields({ diff: { patch: "secret diff" } });
		expect(result.diff).toBe("[content:object]");
	});

	it("redacts nested credentials and content inside arrays", () => {
		const result = redactor.redactLogFields({
			items: [{ authorization: "Bearer nested-secret", body_md: "nested raw body", ok: true }],
		});
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("nested-secret");
		expect(serialized).not.toContain("nested raw body");
		expect(serialized).toContain("[REDACTED]");
		expect(serialized).toContain("[content:sha256:");
	});

	it("redacts content-shaped keys and long unknown blobs", () => {
		const result = redactor.redactLogFields({
			output: "raw output",
			args: { path: "secret" },
			error: "raw stack",
			blob: "x".repeat(600),
			result: "ok",
		});
		expect(result.output).toMatch(/^\[content:sha256:/);
		expect(result.args).toBe("[content:object]");
		expect(result.error).toMatch(/^\[content:sha256:/);
		expect(result.blob).toMatch(/^\[content:sha256:/);
		expect(result.result).toMatch(/^\[content:sha256:/);
		expect(JSON.stringify(result)).not.toContain("raw output");
		expect(JSON.stringify(result)).not.toContain("raw stack");
	});

	it("redacts camelCase content keys with short values", () => {
		const result = redactor.redactLogFields({
			errorMessage: "short secret",
			bodyMd: "short body",
			promptText: "short prompt",
			toolInput: { path: "secret" },
		});
		const serialized = JSON.stringify(result);
		expect(result.errorMessage).toMatch(/^\[content:sha256:/);
		expect(result.bodyMd).toMatch(/^\[content:sha256:/);
		expect(result.promptText).toMatch(/^\[content:sha256:/);
		expect(result.toolInput).toBe("[content:object]");
		expect(serialized).not.toContain("short secret");
		expect(serialized).not.toContain("short body");
		expect(serialized).not.toContain("short prompt");
	});
});
