import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { MemoryError } from "./errors.ts";

interface LockState {
	readonly pid: number;
	readonly startedAt: number;
	readonly host: string;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readState(path: string): LockState | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockState>;
		if (typeof parsed.pid !== "number" || typeof parsed.startedAt !== "number" || typeof parsed.host !== "string") {
			return null;
		}
		return { pid: parsed.pid, startedAt: parsed.startedAt, host: parsed.host };
	} catch {
		return null;
	}
}

function lockIsOld(path: string, now: () => number): boolean {
	try {
		return existsSync(path) && statSync(path).mtimeMs < now() - 60 * 60 * 1000;
	} catch {
		return false;
	}
}

export function memoryLockPath(memoryDatabasePath: string): string {
	return `${memoryDatabasePath}.lock`;
}

export class MemoryIndexLock {
	private readonly path: string;
	private readonly state: LockState;
	private released = false;

	private constructor(path: string, state: LockState) {
		this.path = path;
		this.state = state;
	}

	static acquire(path: string, now: () => number = Date.now): MemoryIndexLock {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const state: LockState = { pid: process.pid, startedAt: now(), host: hostname() };
		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				writeFileSync(path, JSON.stringify(state), { flag: "wx", mode: 0o600 });
				return new MemoryIndexLock(path, state);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
					throw new MemoryError("memory_busy", `cannot acquire memory index lock: ${String(error)}`, {
						cause: error,
					});
				}
				const existing = readState(path);
				const staleByPid = existing === null || !pidAlive(existing.pid);
				const staleByAge = existing !== null && now() - existing.startedAt > 60 * 60 * 1000 && lockIsOld(path, now);
				if (!staleByPid && !staleByAge) {
					throw new MemoryError("memory_busy", "another memory index worker is running", {
						details: { pid: existing?.pid ?? null, host: existing?.host ?? null },
					});
				}
				try {
					unlinkSync(path);
				} catch (unlinkError) {
					throw new MemoryError("memory_busy", `cannot clear stale memory index lock: ${String(unlinkError)}`, {
						cause: unlinkError,
					});
				}
			}
		}
		throw new MemoryError("memory_busy", "cannot acquire memory index lock");
	}

	release(): void {
		if (this.released) return;
		this.released = true;
		const current = readState(this.path);
		if (current === null || current.pid !== this.state.pid) return;
		try {
			unlinkSync(this.path);
		} catch {
			// Lock cleanup is best effort; a stale lock is recovered by the next run.
		}
	}
}
