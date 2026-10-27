import { appendFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { DaemonError } from "./errors.ts";

export type BootEvent = "started" | "ready" | "stopping" | "stopped" | "failed" | "fence_reclaimed";

export interface BootRecord {
	schemaVersion: 1;
	bootId: string;
	bootSequence: number;
	installationId: string;
	runningRevision: string;
	event: BootEvent;
	recordedAt: string;
	detail?: string;
}

export function readBootLedger(ledgerFile: string): BootRecord[] {
	if (!existsSync(ledgerFile)) return [];
	const lines = readFileSync(ledgerFile, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "");
	return lines.map((line, index) => {
		try {
			return JSON.parse(line) as BootRecord;
		} catch {
			throw new DaemonError(
				"ledger_corrupt",
				`boot ledger line ${index + 1} is not valid JSON; repair or truncate the ledger before starting`,
			);
		}
	});
}

export function nextBootSequence(ledgerFile: string): number {
	const records = readBootLedger(ledgerFile);
	return records.reduce((max, record) => Math.max(max, record.bootSequence), 0) + 1;
}

export function appendBootRecord(ledgerFile: string, record: BootRecord): void {
	appendFileSync(ledgerFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
	chmodSync(ledgerFile, 0o600);
}
