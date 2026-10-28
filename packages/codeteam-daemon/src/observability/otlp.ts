import type { SpanExporter, TraceSpanDTO } from "./contracts.ts";

export interface OtlpConfig {
	readonly enabled: boolean;
	readonly endpoint?: string;
	readonly timeoutMs: number;
	readonly serviceName: string;
}

export function resolveOtlpConfig(env: NodeJS.ProcessEnv = process.env): OtlpConfig {
	const enabled = ["1", "true", "yes", "on"].includes((env.CODETEAM_OTLP_ENABLED ?? "").toLowerCase());
	const endpoint = env.CODETEAM_OTLP_ENDPOINT?.trim();
	const timeoutMs = parsePositiveInteger(env.CODETEAM_OTLP_TIMEOUT_MS, 2000);
	const serviceName = env.CODETEAM_OTLP_SERVICE_NAME?.trim() || "codeteam-daemon";
	if (enabled && !endpoint) throw new Error("otlp_endpoint_missing");
	return { enabled, endpoint, timeoutMs, serviceName };
}

/**
 * Minimal OTLP/HTTP JSON exporter. OTLP is opt-in; the default runtime uses a
 * no-op exporter. Only redacted TraceSpanDTO values reach this boundary.
 */
export class OtlpHttpExporter implements SpanExporter {
	readonly endpoint: string;
	private readonly timeoutMs: number;
	private readonly serviceName: string;
	private pending: Promise<void> = Promise.resolve();
	private failures = 0;

	constructor(config: OtlpConfig) {
		if (!config.enabled || !config.endpoint) throw new Error("otlp_not_configured");
		this.endpoint = config.endpoint.replace(/\/$/, "");
		this.timeoutMs = config.timeoutMs;
		this.serviceName = config.serviceName;
	}

	get failureCount(): number {
		return this.failures;
	}

	export(span: TraceSpanDTO): void {
		this.pending = this.pending
			.then(() => this.send(span))
			.catch(() => {
				this.failures += 1;
			});
	}

	async flush(): Promise<void> {
		await this.pending;
	}

	async shutdown(): Promise<void> {
		await this.flush();
	}

	private async send(span: TraceSpanDTO): Promise<void> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const response = await fetch(`${this.endpoint}/v1/traces`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(this.payload(span)),
				signal: controller.signal,
			});
			if (!response.ok) throw new Error(`otlp_http_${response.status}`);
		} finally {
			clearTimeout(timer);
		}
	}

	private payload(span: TraceSpanDTO): unknown {
		const attributes = Object.entries(span.attributes).map(([key, value]) => ({
			key,
			value: otlpAttributeValue(value),
		}));
		const events = span.events.map((event) => ({
			timeUnixNano: toNano(event.timeMs),
			name: event.name,
			...(event.attributes
				? {
						attributes: Object.entries(event.attributes).map(([key, value]) => ({
							key,
							value: otlpAttributeValue(value),
						})),
					}
				: {}),
		}));
		return {
			resourceSpans: [
				{
					resource: {
						attributes: [{ key: "service.name", value: { stringValue: this.serviceName } }],
					},
					scopeSpans: [
						{
							scope: { name: "codeteam-daemon", version: "0.0.0" },
							spans: [
								{
									traceId: span.traceId,
									spanId: span.spanId,
									...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
									name: span.name,
									kind: span.kind === "server" ? 2 : span.kind === "client" ? 3 : 1,
									startTimeUnixNano: toNano(span.startTimeMs),
									endTimeUnixNano: toNano(span.endTimeMs),
									attributes,
									events,
									status: {
										code: span.status.code === "ok" ? 1 : span.status.code === "error" ? 2 : 0,
										...(span.status.message ? { message: span.status.message } : {}),
									},
								},
							],
						},
					],
				},
			],
		};
	}
}

function otlpAttributeValue(value: string | number | boolean): Record<string, unknown> {
	if (typeof value === "boolean") return { boolValue: value };
	if (typeof value === "number") {
		return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
	}
	return { stringValue: value };
}

function toNano(ms: number): string {
	return (BigInt(Math.max(0, Math.round(ms))) * 1_000_000n).toString();
}

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
	if (!raw) return fallback;
	const parsed = Number(raw);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
