import { readdirSync, readFileSync } from "node:fs";
import { ControlError } from "../control/errors.ts";
import type { ProcessIdentity } from "./types.ts";

export interface ProcessIdentityProvider {
	read(pid: number): ProcessIdentity | null;
	isAlive(pid: number): boolean;
	descendants(pid: number): number[];
}

interface ProcStat {
	readonly pid: number;
	readonly ppid: number;
	readonly starttime: string;
	readonly comm: string;
}

function readProcStat(pid: number): ProcStat | null {
	try {
		const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
		const end = raw.lastIndexOf(")");
		if (end < 0) return null;
		const comm = raw.slice(raw.indexOf("(") + 1, end);
		const fields = raw
			.slice(end + 2)
			.trim()
			.split(/\s+/);
		const ppid = Number(fields[1]);
		const starttime = fields[19];
		if (!Number.isSafeInteger(ppid) || !starttime) return null;
		return { pid, ppid, starttime, comm };
	} catch {
		return null;
	}
}

export class LinuxProcessIdentityProvider implements ProcessIdentityProvider {
	read(pid: number): ProcessIdentity | null {
		const stat = readProcStat(pid);
		if (!stat) return null;
		let command = stat.comm;
		try {
			const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8")
				.split("\0")
				.filter((part) => part !== "")
				.join(" ");
			if (cmdline !== "") command = cmdline;
		} catch {
			// comm is still a valid identity fallback.
		}
		return { pid, startedAt: stat.starttime, command };
	}

	isAlive(pid: number): boolean {
		return Number.isSafeInteger(pid) && pid > 0 && readProcStat(pid) !== null;
	}

	descendants(pid: number): number[] {
		let entries: string[];
		try {
			entries = readdirSync("/proc");
		} catch (error) {
			throw new ControlError("process_tree_unreadable", "cannot read /proc", { cause: error });
		}
		const children = new Map<number, number[]>();
		for (const entry of entries) {
			if (!/^\d+$/.test(entry)) continue;
			const child = Number(entry);
			const stat = readProcStat(child);
			if (!stat) continue;
			const list = children.get(stat.ppid) ?? [];
			list.push(child);
			children.set(stat.ppid, list);
		}
		const result: number[] = [];
		const queue = [...(children.get(pid) ?? [])];
		const seen = new Set<number>();
		while (queue.length > 0) {
			const child = queue.shift()!;
			if (seen.has(child)) continue;
			seen.add(child);
			result.push(child);
			queue.push(...(children.get(child) ?? []));
		}
		return result;
	}
}

export function assertExecutorOutside(
	targets: readonly number[],
	executor: number,
	provider: ProcessIdentityProvider,
): void {
	if (targets.includes(executor)) {
		throw new ControlError("lifecycle_executor_inside_target", "executor is inside the target process set");
	}
	for (const target of targets) {
		if (provider.descendants(target).includes(executor)) {
			throw new ControlError("lifecycle_executor_inside_target", `executor is a descendant of target ${target}`);
		}
	}
}
