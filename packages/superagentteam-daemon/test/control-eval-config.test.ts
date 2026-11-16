import { describe, expect, it } from "vitest";
import { ControlError, resolveEvalConfig } from "../src/index.ts";

function expectCode(fn: () => unknown, code: string): void {
	try {
		fn();
		throw new Error("expected ControlError");
	} catch (error) {
		expect(error).toBeInstanceOf(ControlError);
		expect((error as ControlError).code).toBe(code);
	}
}

describe("W6b eval config", () => {
	it("uses approved defaults", () => {
		const config = resolveEvalConfig({ dataDir: "/tmp/codeteam-eval-config", env: {} });
		expect(config).toEqual({
			domainsDir: "evals/domains",
			bundlesDir: "/tmp/codeteam-eval-config/evals/bundles",
			enabled: false,
			bundleMaxBytes: 5 * 1024 * 1024,
			sampleTraceLimit: 20,
			acknowledgeHoursDefault: 24,
			reevalWithinHoursDefault: 72,
			retentionDays: 0,
		});
	});

	it("parses explicit env overrides", () => {
		const config = resolveEvalConfig({
			dataDir: "/tmp/data",
			env: {
				CODETEAM_EVAL_DOMAINS_DIR: "/srv/evals/domains",
				CODETEAM_EVAL_ENABLED: "1",
				CODETEAM_EVAL_BUNDLE_MAX_BYTES: "1024",
				CODETEAM_EVAL_SAMPLE_TRACE_LIMIT: "5",
				CODETEAM_EVAL_ACK_HOURS_DEFAULT: "12",
				CODETEAM_EVAL_REEVAL_HOURS_DEFAULT: "36",
				CODETEAM_EVAL_RETENTION_DAYS: "7",
			},
		});
		expect(config).toMatchObject({
			domainsDir: "/srv/evals/domains",
			enabled: true,
			bundleMaxBytes: 1024,
			sampleTraceLimit: 5,
			acknowledgeHoursDefault: 12,
			reevalWithinHoursDefault: 36,
			retentionDays: 7,
		});
	});

	it("fails closed on traversal and invalid flags/numbers", () => {
		expectCode(
			() => resolveEvalConfig({ dataDir: "/tmp/data", env: { CODETEAM_EVAL_BUNDLES_DIR: "../escape" } }),
			"invalid_input",
		);
		expectCode(
			() => resolveEvalConfig({ dataDir: "/tmp/data", env: { CODETEAM_EVAL_ENABLED: "maybe" } }),
			"invalid_input",
		);
		expectCode(
			() => resolveEvalConfig({ dataDir: "/tmp/data", env: { CODETEAM_EVAL_BUNDLE_MAX_BYTES: "0" } }),
			"invalid_input",
		);
		expectCode(
			() => resolveEvalConfig({ dataDir: "/tmp/data", env: { CODETEAM_EVAL_RETENTION_DAYS: "-1" } }),
			"invalid_input",
		);
	});
});
