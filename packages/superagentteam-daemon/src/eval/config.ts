import { isAbsolute, join } from "node:path";
import { ControlError } from "../control/errors.ts";
import { envValue } from "../env.ts";

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
	const domainsDir = envValue(env, "EVAL_DOMAINS_DIR")?.trim() || "evals/domains";
	if (isAbsolute(domainsDir) === false && domainsDir.split(/[\\/]+/).includes("..")) {
		throw new ControlError("invalid_input", "SUPERAGENTTEAM_EVAL_DOMAINS_DIR must not traverse");
	}
	const bundlesDir = envValue(env, "EVAL_BUNDLES_DIR")?.trim() || join(options.dataDir, "evals", "bundles");
	if (isAbsolute(bundlesDir) === false && bundlesDir.split(/[\\/]+/).includes("..")) {
		throw new ControlError("invalid_input", "SUPERAGENTTEAM_EVAL_BUNDLES_DIR must not traverse");
	}
	return {
		domainsDir,
		bundlesDir,
		enabled: booleanFlag(envValue(env, "EVAL_ENABLED"), "SUPERAGENTTEAM_EVAL_ENABLED", false),
		bundleMaxBytes: positiveInteger(
			envValue(env, "EVAL_BUNDLE_MAX_BYTES"),
			"SUPERAGENTTEAM_EVAL_BUNDLE_MAX_BYTES",
			5 * 1024 * 1024,
		),
		sampleTraceLimit: positiveInteger(
			envValue(env, "EVAL_SAMPLE_TRACE_LIMIT"),
			"SUPERAGENTTEAM_EVAL_SAMPLE_TRACE_LIMIT",
			20,
		),
		acknowledgeHoursDefault: positiveInteger(
			envValue(env, "EVAL_ACK_HOURS_DEFAULT"),
			"SUPERAGENTTEAM_EVAL_ACK_HOURS_DEFAULT",
			24,
		),
		reevalWithinHoursDefault: positiveInteger(
			envValue(env, "EVAL_REEVAL_HOURS_DEFAULT"),
			"SUPERAGENTTEAM_EVAL_REEVAL_HOURS_DEFAULT",
			72,
		),
		retentionDays: nonNegativeInteger(envValue(env, "EVAL_RETENTION_DAYS"), "SUPERAGENTTEAM_EVAL_RETENTION_DAYS", 0),
	};
}
