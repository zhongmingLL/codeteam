import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { DaemonError } from "./errors.ts";

export interface FenceRecord {
	schemaVersion: 1;
	pid: number;
	bootId: string;
	createdAt: string;
}

export function readFence(lockFile: string): FenceRecord | null {
	if (!existsSync(lockFile)) return null;
	try {
		const record = JSON.parse(readFileSync(lockFile, "utf8")) as Partial<FenceRecord>;
		return typeof record.pid === "number" && typeof record.bootId === "string"
			? {
					schemaVersion: 1,
					pid: record.pid,
					bootId: record.bootId,
					createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
				}
			: null;
	} catch {
		return null;
	}
}

export function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function tryCreateFence(lockFile: string, bootId: string): boolean {
	try {
		const fd = openSync(lockFile, "wx", 0o600);
		writeSync(
			fd,
			JSON.stringify({
				schemaVersion: 1,
				pid: process.pid,
				bootId,
				createdAt: new Date().toISOString(),
			} satisfies FenceRecord),
		);
		closeSync(fd);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

export function acquireFence(lockFile: string, bootId: string): { reclaimedPid: number | null } {
	if (tryCreateFence(lockFile, bootId)) return { reclaimedPid: null };

	const record = readFence(lockFile);
	if (record && isProcessAlive(record.pid)) {
		throw new DaemonError("already_running", `daemon pid ${record.pid} already holds the fence`);
	}
	try {
		unlinkSync(lockFile);
	} catch {
		// A concurrent process may have removed it first.
	}
	if (!tryCreateFence(lockFile, bootId)) {
		throw new DaemonError("already_running", "another daemon acquired the fence while reclaiming");
	}
	return { reclaimedPid: record?.pid ?? null };
}

export function releaseFence(lockFile: string, bootId: string): void {
	const record = readFence(lockFile);
	if (record && record.bootId !== bootId) return;
	try {
		unlinkSync(lockFile);
	} catch {
		// Already gone.
	}
}
