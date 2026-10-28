import type { SpanExporter, TelemetryComponentStatus, TelemetryReadiness } from "./contracts.ts";
import { JsonlLogStore } from "./logs.ts";
import { MetricsRegistry } from "./metrics.ts";
import { OtlpHttpExporter, resolveOtlpConfig } from "./otlp.ts";
import { createRedactor, type Redactor } from "./redaction.ts";
import { loadOrCreateTelemetrySalt } from "./salt.ts";
import { LocalTraceStore } from "./trace-store.ts";
import { Tracer } from "./tracer.ts";

export interface ObservabilityRuntimeOptions {
	readonly dataDir: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly now?: () => number;
	readonly serviceName?: string;
}

export interface ObservabilityRuntime {
	readonly status: TelemetryComponentStatus;
	readonly reason?: string;
	readonly redactor: Redactor;
	readonly traces: LocalTraceStore;
	readonly tracer: Tracer;
	readonly metrics: MetricsRegistry;
	readonly logs: JsonlLogStore | null;
	readonly otlp: SpanExporter | null;
	readiness(): TelemetryReadiness;
	close(): Promise<void>;
}

/**
 * Local-first observability runtime. Component failures degrade telemetry but
 * never throw into the control plane; the daemon must still start and serve.
 */
export function createObservabilityRuntime(options: ObservabilityRuntimeOptions): ObservabilityRuntime {
	const env = options.env ?? process.env;
	const now = options.now ?? Date.now;
	const metrics = new MetricsRegistry();
	let redactor = createRedactor();
	let traces = new LocalTraceStore({ disabledReason: "telemetry_salt_missing", now });
	let tracer = new Tracer({ store: traces, redactor, now });
	let traceReason: string | undefined;
	let otlp: SpanExporter | null = null;
	let otlpStatus: TelemetryReadiness["otlp"] = { status: "disabled" };
	let logs: JsonlLogStore | null = null;
	let logReason: string | undefined;

	try {
		const salt = loadOrCreateTelemetrySalt({ dataDir: options.dataDir });
		redactor = createRedactor({ salt: salt.salt });
		traces = new LocalTraceStore({ now, hmacId: (id) => redactor.hmacId(id) });
		tracer = new Tracer({ store: traces, redactor, now });
	} catch (error) {
		traceReason = error instanceof Error ? error.message : String(error);
	}

	try {
		const config = resolveOtlpConfig(env);
		if (config.enabled) {
			otlp = new OtlpHttpExporter({ ...config, serviceName: options.serviceName ?? config.serviceName });
			otlpStatus = { status: "enabled" };
		}
	} catch (error) {
		otlpStatus = {
			status: "degraded",
			reason: error instanceof Error ? error.message : String(error),
		};
	}

	try {
		logs = new JsonlLogStore({
			dataDir: options.dataDir,
			redactor: createRedactor(),
			now,
		});
	} catch (error) {
		logReason = error instanceof Error ? error.message : String(error);
	}

	const status: TelemetryComponentStatus =
		traceReason === undefined && logReason === undefined && otlpStatus.status !== "degraded" ? "ready" : "degraded";
	const reason = traceReason ?? logReason ?? otlpStatus.reason;
	const up = metrics.gauge("codeteam_telemetry_up", {});
	up.set(status === "ready" ? 1 : 0);

	const readiness = (): TelemetryReadiness => {
		const traceStats = traces.stats();
		return {
			status,
			...(reason ? { reason } : {}),
			trace: {
				status: traceReason === undefined ? "ready" : "disabled",
				spanCount: traceStats.spanCount,
				maxSpans: traceStats.maxSpans,
				maxAgeMs: traceStats.maxAgeMs,
				...(traceReason ? { reason: traceReason } : {}),
			},
			metrics: {
				status: "ready",
				seriesCount: metrics.seriesCount(),
			},
			logs: logs
				? { status: "ready", fileCount: logs.stats().fileCount }
				: { status: "disabled", fileCount: 0, ...(logReason ? { reason: logReason } : {}) },
			otlp: otlpStatus,
		};
	};

	return {
		status,
		...(reason ? { reason } : {}),
		redactor,
		traces,
		tracer,
		metrics,
		logs,
		otlp,
		readiness,
		async close() {
			if (otlp?.shutdown) await otlp.shutdown();
			logs?.close();
		},
	};
}

export function disabledObservabilityRuntime(reason = "telemetry_disabled"): ObservabilityRuntime {
	const now = Date.now;
	const redactor = createRedactor();
	const traces = new LocalTraceStore({ disabledReason: reason, now });
	const tracer = new Tracer({ store: traces, redactor, now });
	const metrics = new MetricsRegistry();
	metrics.gauge("codeteam_telemetry_up", {}).set(0);
	return {
		status: "disabled",
		reason,
		redactor,
		traces,
		tracer,
		metrics,
		logs: null,
		otlp: null,
		readiness: () => ({
			status: "disabled",
			reason,
			trace: {
				status: "disabled",
				spanCount: 0,
				maxSpans: traces.stats().maxSpans,
				maxAgeMs: traces.stats().maxAgeMs,
				reason,
			},
			metrics: { status: "disabled", seriesCount: metrics.seriesCount(), reason },
			logs: { status: "disabled", fileCount: 0, reason },
			otlp: { status: "disabled", reason },
		}),
		async close() {},
	};
}
