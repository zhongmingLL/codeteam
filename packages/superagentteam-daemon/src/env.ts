import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ENV_PREFIX = "SUPERAGENTTEAM_";
export const LEGACY_ENV_PREFIX = "CODETEAM_";

export function envValue(env: NodeJS.ProcessEnv, suffix: string): string | undefined {
	return env[`${ENV_PREFIX}${suffix}`] ?? env[`${LEGACY_ENV_PREFIX}${suffix}`];
}

export function envName(suffix: string): string {
	return `${ENV_PREFIX}${suffix}`;
}

export function legacyEnvName(suffix: string): string {
	return `${LEGACY_ENV_PREFIX}${suffix}`;
}

/**
 * Mirror new SUPERAGENTTEAM_* values onto their legacy CODETEAM_* names for
 * modules that still read process.env directly. The new name always wins.
 */
export function aliasLegacyEnv(env: NodeJS.ProcessEnv = process.env): void {
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined || !key.startsWith(ENV_PREFIX)) continue;
		const legacy = `${LEGACY_ENV_PREFIX}${key.slice(ENV_PREFIX.length)}`;
		if (env[legacy] === undefined) env[legacy] = value;
	}
}

function homeDir(env: NodeJS.ProcessEnv): string {
	return env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(homeDir(env), ".superagentteam");
}

export function legacyDataDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(homeDir(env), ".codeteam");
}

/**
 * Data root precedence: explicit flag > SUPERAGENTTEAM_DATA_DIR > legacy
 * CODETEAM_DATA_DIR > existing ~/.superagentteam > existing ~/.codeteam >
 * new ~/.superagentteam (fresh installs create the new root; an existing legacy
 * root keeps writes until an explicit migration).
 */
export function resolveDataDir(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
	if (explicit !== undefined && explicit.trim() !== "") return explicit;
	const fromEnv = envValue(env, "DATA_DIR");
	if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv;
	const next = defaultDataDir(env);
	const legacy = legacyDataDir(env);
	if (existsSync(next)) return next;
	if (existsSync(legacy)) return legacy;
	return next;
}
