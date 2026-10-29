import { isAbsolute, join } from "node:path";
import { ControlError } from "../control/errors.ts";

export interface EvalConfig {
	readonly domainsDir: string;
	readonly bundlesDir: string;
	readonly enabled: boolean;
	readonly bundleMaxBytes: number;
	readonly sampleTraceLimit: number;
	readonly acknowledgeHoursDefault: number;
	readonly reevalWithinHoursDefault: number;
	readonly retentionDays: number;
}

export interface ResolveEvalConfigOptions {
	readonly env?: NodeJS.ProcessEnv;
	readonly dataDir: string;
}

function positiveInteger(value: string | undefined, label: string, fallback: number): number {
	if (value === undefined || value.trim() === "") return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new ControlError("invalid_input", `${label} must be a positive integer`);
	}
	return parsed;
}

function nonNegativeInteger(value: string | undefined, label: string, fallback: number): number {
	if (value === undefined || value.trim() === "") return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new ControlError("invalid_input", `${label} must be a non-negative integer`);
	}
	return parsed;
}

function booleanFlag(value: string | undefined, label: string, fallback: boolean): boolean {
	if (value === undefined || value.trim() === "") return fallback;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	throw new ControlError("invalid_input", `${label} must be 0/1/true/false`);
}

export function resolveEvalConfig(options: ResolveEvalConfigOptions): EvalConfig {
	const env = options.env ?? process.env;
	const domainsDir = env.CODETEAM_EVAL_DOMAINS_DIR?.trim() || "evals/domains";
	if (isAbsolute(domainsDir) === false && domainsDir.split(/[\\/]+/).includes("..")) {
		throw new ControlError("invalid_input", "CODETEAM_EVAL_DOMAINS_DIR must not traverse");
	}
	const bundlesDir = env.CODETEAM_EVAL_BUNDLES_DIR?.trim() || join(options.dataDir, "evals", "bundles");
	if (isAbsolute(bundlesDir) === false && bundlesDir.split(/[\\/]+/).includes("..")) {
		throw new ControlError("invalid_input", "CODETEAM_EVAL_BUNDLES_DIR must not traverse");
	}
	return {
		domainsDir,
		bundlesDir,
		enabled: booleanFlag(env.CODETEAM_EVAL_ENABLED, "CODETEAM_EVAL_ENABLED", false),
		bundleMaxBytes: positiveInteger(
			env.CODETEAM_EVAL_BUNDLE_MAX_BYTES,
			"CODETEAM_EVAL_BUNDLE_MAX_BYTES",
			5 * 1024 * 1024,
		),
		sampleTraceLimit: positiveInteger(env.CODETEAM_EVAL_SAMPLE_TRACE_LIMIT, "CODETEAM_EVAL_SAMPLE_TRACE_LIMIT", 20),
		acknowledgeHoursDefault: positiveInteger(
			env.CODETEAM_EVAL_ACK_HOURS_DEFAULT,
			"CODETEAM_EVAL_ACK_HOURS_DEFAULT",
			24,
		),
		reevalWithinHoursDefault: positiveInteger(
			env.CODETEAM_EVAL_REEVAL_HOURS_DEFAULT,
			"CODETEAM_EVAL_REEVAL_HOURS_DEFAULT",
			72,
		),
		retentionDays: nonNegativeInteger(env.CODETEAM_EVAL_RETENTION_DAYS, "CODETEAM_EVAL_RETENTION_DAYS", 0),
	};
}
