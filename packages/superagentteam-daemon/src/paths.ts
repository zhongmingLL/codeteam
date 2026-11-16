import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DaemonError } from "./errors.ts";

export interface DaemonPaths {
	dataDir: string;
	stateFile: string;
	ledgerFile: string;
	lockFile: string;
}

export function resolveDaemonPaths(dataDir?: string): DaemonPaths {
	const resolved = dataDir ?? process.env.CODETEAM_DATA_DIR;
	if (!resolved || resolved.trim() === "") {
		throw new DaemonError("data_dir_missing", "CODETEAM_DATA_DIR is required");
	}
	mkdirSync(resolved, { recursive: true, mode: 0o700 });
	chmodSync(resolved, 0o700);
	return {
		dataDir: resolved,
		stateFile: join(resolved, "daemon-state.json"),
		ledgerFile: join(resolved, "boot-ledger.jsonl"),
		lockFile: join(resolved, "daemon.lock"),
	};
}
