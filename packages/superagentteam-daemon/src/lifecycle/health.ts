import type { StopHealthExpectation, StopHealthResult } from "./types.ts";

export interface StopHealthProbe {
	probe(url: string, expected: StopHealthExpectation): Promise<StopHealthResult>;
}

export const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;

export class HttpStopHealthProbe implements StopHealthProbe {
	private readonly timeoutMs: number;

	constructor(timeoutMs = Number(process.env.CODETEAM_HEALTH_TIMEOUT_MS ?? DEFAULT_HEALTH_TIMEOUT_MS)) {
		this.timeoutMs = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_HEALTH_TIMEOUT_MS;
	}

	async probe(url: string, expected: StopHealthExpectation): Promise<StopHealthResult> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const response = await fetch(url, { signal: controller.signal });
			if (!response.ok) return { ok: false, reason: `http_${response.status}` };
			const body = (await response.json()) as Record<string, unknown>;
			if (body.status !== "ready") return { ok: false, reason: "not_ready", body };
			if (body.bootId !== expected.bootId) return { ok: false, reason: "boot_mismatch", body };
			if (body.pid !== expected.processId) return { ok: false, reason: "pid_mismatch", body };
			if (body.installationId !== expected.installationId) {
				return { ok: false, reason: "installation_mismatch", body };
			}
			return { ok: true, body };
		} catch (error) {
			return { ok: false, reason: error instanceof Error ? error.message : String(error) };
		} finally {
			clearTimeout(timer);
		}
	}
}
