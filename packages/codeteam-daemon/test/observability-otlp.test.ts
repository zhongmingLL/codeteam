import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TraceSpanDTO } from "../src/observability/contracts.ts";
import { OtlpHttpExporter, resolveOtlpConfig } from "../src/observability/otlp.ts";
import { createRedactor } from "../src/observability/redaction.ts";
import { createObservabilityRuntime } from "../src/observability/runtime.ts";
import { LocalTraceStore } from "../src/observability/trace-store.ts";
import { Tracer } from "../src/observability/tracer.ts";

const servers: Server[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

const dto: TraceSpanDTO = {
	traceId: "a".repeat(32),
	spanId: "b".repeat(16),
	name: "codeteam.run",
	kind: "internal",
	startTimeMs: 1_700_000_000_000,
	endTimeMs: 1_700_000_000_010,
	durationMs: 10,
	status: { code: "ok" },
	attributes: { "tool.name": "bash", role: "coder" },
	events: [],
	storedAt: 1_700_000_000_010,
	droppedAttributes: 0,
};

describe("W6c OTLP exporter", () => {
	it("is disabled by default and requires an endpoint when enabled", () => {
		expect(resolveOtlpConfig({})).toMatchObject({ enabled: false, timeoutMs: 2000 });
		expect(() => resolveOtlpConfig({ CODETEAM_OTLP_ENABLED: "1" })).toThrowError("otlp_endpoint_missing");
	});

	it("degrades readiness for an invalid OTLP config but keeps the local trace ring", () => {
		const dataDir = mkdtempSync(join(tmpdir(), "codeteam-otlp-"));
		try {
			const runtime = createObservabilityRuntime({
				dataDir,
				env: { CODETEAM_OTLP_ENABLED: "1" },
			});
			const readiness = runtime.readiness();
			expect(readiness.status).toBe("degraded");
			expect(readiness.otlp.status).toBe("degraded");
			expect(readiness.trace.status).toBe("ready");
			expect(readiness.logs.status).toBe("ready");
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("posts only the redacted DTO to the OTLP/HTTP JSON endpoint", async () => {
		let received: unknown = null;
		const server = createServer((request, response) => {
			let body = "";
			request.on("data", (chunk) => {
				body += String(chunk);
			});
			request.on("end", () => {
				received = JSON.parse(body) as unknown;
				response.writeHead(200, { "content-type": "application/json" });
				response.end("{}");
			});
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		const exporter = new OtlpHttpExporter(
			resolveOtlpConfig({ CODETEAM_OTLP_ENABLED: "1", CODETEAM_OTLP_ENDPOINT: `http://127.0.0.1:${port}` }),
		);
		exporter.export(dto);
		await exporter.flush();
		expect(exporter.failureCount).toBe(0);
		const payload = received as {
			resourceSpans: Array<{
				scopeSpans: Array<{ spans: Array<Record<string, unknown>> }>;
			}>;
		};
		const span = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
		expect(span.name).toBe("codeteam.run");
		expect(span.traceId).toBe(dto.traceId);
		expect(span.status).toMatchObject({ code: 1 });
		const serialized = JSON.stringify(payload);
		expect(serialized).toContain("tool.name");
		expect(serialized).not.toContain("prompt");
	});

	it("counts export failures without throwing", async () => {
		const exporter = new OtlpHttpExporter({
			enabled: true,
			endpoint: "http://127.0.0.1:1",
			timeoutMs: 100,
			serviceName: "test",
		});
		exporter.export(dto);
		await exporter.flush();
		expect(exporter.failureCount).toBe(1);
	});

	it("integrates with the tracer without leaking raw content", async () => {
		let body = "";
		const server = createServer((request, response) => {
			request.on("data", (chunk) => {
				body += String(chunk);
			});
			request.on("end", () => {
				response.writeHead(200);
				response.end();
			});
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		const exporter = new OtlpHttpExporter(
			resolveOtlpConfig({ CODETEAM_OTLP_ENABLED: "1", CODETEAM_OTLP_ENDPOINT: `http://127.0.0.1:${port}` }),
		);
		const redactor = createRedactor({ salt: "otlp-test-salt" });
		const store = new LocalTraceStore({ hmacId: (id) => redactor.hmacId(id) });
		const tracer = new Tracer({ store, redactor, exporter });
		const span = tracer.startSpan({ name: "codeteam.test", attributes: { prompt: "raw prompt" } });
		span.end();
		await exporter.flush();
		expect(body).not.toContain("raw prompt");
		expect(store.stats().spanCount).toBe(1);
		await exporter.shutdown();
	});
});
