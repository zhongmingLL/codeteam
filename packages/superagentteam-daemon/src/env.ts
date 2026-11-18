import { homedir } from "node:os";
import { join } from "node:path";

export const ENV_PREFIX = "SUPERAGENTTEAM_";

export function envValue(env: NodeJS.ProcessEnv, suffix: string): string | undefined {
	return env[`${ENV_PREFIX}${suffix}`];
}

export function envName(suffix: string): string {
	return `${ENV_PREFIX}${suffix}`;
}

function homeDir(env: NodeJS.ProcessEnv): string {
	return env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(homeDir(env), ".superagentteam");
}

/**
 * Data root precedence: explicit flag > SUPERAGENTTEAM_DATA_DIR > ~/.superagentteam.
 */
export function resolveDataDir(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
	if (explicit !== undefined && explicit.trim() !== "") return explicit;
	const fromEnv = envValue(env, "DATA_DIR");
	if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv;
	return defaultDataDir(env);
}
