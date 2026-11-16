import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, type Stats, statfsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import type { WorktreeLease } from "../control/stores/types.ts";

export interface DiskFreeProbe {
	availableBytes(path: string): number;
}

export class StatfsDiskFreeProbe implements DiskFreeProbe {
	availableBytes(path: string): number {
		const stat = statfsSync(path);
		return Number(stat.bsize) * Number(stat.bavail);
	}
}

export interface WorktreeFilesystem {
	createDirectory(path: string): void;
	removeDirectory(path: string): void;
}

export class RealWorktreeFilesystem implements WorktreeFilesystem {
	createDirectory(path: string): void {
		mkdirSync(path, { recursive: false, mode: 0o700 });
		chmodSync(path, 0o700);
	}

	removeDirectory(path: string): void {
		rmSync(path, { recursive: true, force: false });
	}
}

export interface WorktreePoolOptions {
	readonly rootDir: string;
	readonly maxLeases?: number;
	readonly minFreeBytes?: number;
	readonly leaseTtlMs?: number;
	readonly reclaimGraceMs?: number;
	readonly releasedTtlMs?: number;
	readonly orphanTtlMs?: number;
	readonly diskFree?: DiskFreeProbe;
	readonly filesystem?: WorktreeFilesystem;
}

export interface WorktreeCapacityResult {
	readonly ok: boolean;
	readonly code?: "worktree_capacity_exhausted" | "worktree_disk_low" | "worktree_disk_unknown";
	readonly message?: string;
	readonly activeLeases: number;
	readonly maxLeases: number;
	readonly availableBytes: number | null;
}

export interface WorktreeGcEntry {
	readonly id: string | null;
	readonly path: string;
	readonly reason: "released_ttl" | "expired_task_terminal" | "expired_task_inactive" | "orphan_ttl";
	readonly bytes: number;
}

export interface WorktreeGcReport {
	readonly dryRun: boolean;
	readonly entries: readonly WorktreeGcEntry[];
	readonly bytesFreed: number;
}

function positiveInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new ControlError("invalid_input", `${field} must be a positive integer`);
	}
	return value;
}

function directoryBytes(path: string): number {
	let total = 0;
	const walk = (current: string): void => {
		const stat = lstatSync(current);
		if (stat.isSymbolicLink()) return;
		if (stat.isFile()) {
			total += stat.size;
			return;
		}
		if (!stat.isDirectory()) return;
		for (const entry of readdirSync(current)) walk(join(current, entry));
	};
	try {
		walk(path);
	} catch {
		return 0;
	}
	return total;
}

export class WorktreePoolService {
	private readonly store: ControlStore;
	private readonly rootDir: string;
	private readonly maxLeases: number;
	private readonly minFreeBytes: number;
	private readonly leaseTtlMs: number;
	private readonly reclaimGraceMs: number;
	private readonly releasedTtlMs: number;
	private readonly orphanTtlMs: number;
	private readonly diskFree: DiskFreeProbe;
	private readonly filesystem: WorktreeFilesystem;

	constructor(store: ControlStore, options: WorktreePoolOptions) {
		this.store = store;
		this.rootDir = resolve(options.rootDir);
		this.maxLeases =
			options.maxLeases ?? positiveInteger(Number(process.env.CODETEAM_WORKTREE_POOL_MAX ?? "4"), "maxLeases");
		this.minFreeBytes = positiveInteger(
			options.minFreeBytes ?? Number(process.env.CODETEAM_WORKTREE_MIN_FREE_BYTES ?? String(1024 * 1024 * 1024)),
			"minFreeBytes",
		);
		this.leaseTtlMs = positiveInteger(
			options.leaseTtlMs ?? Number(process.env.CODETEAM_WORKTREE_LEASE_TTL_MS ?? String(8 * 60 * 60 * 1000)),
			"leaseTtlMs",
		);
		this.reclaimGraceMs = positiveInteger(
			options.reclaimGraceMs ??
				Number(process.env.CODETEAM_WORKTREE_RECLAIM_GRACE_MS ?? String(48 * 60 * 60 * 1000)),
			"reclaimGraceMs",
		);
		this.releasedTtlMs = positiveInteger(
			options.releasedTtlMs ?? Number(process.env.CODETEAM_WORKTREE_RELEASED_TTL_MS ?? String(24 * 60 * 60 * 1000)),
			"releasedTtlMs",
		);
		this.orphanTtlMs = positiveInteger(
			options.orphanTtlMs ?? Number(process.env.CODETEAM_WORKTREE_ORPHAN_TTL_MS ?? String(24 * 60 * 60 * 1000)),
			"orphanTtlMs",
		);
		this.diskFree = options.diskFree ?? new StatfsDiskFreeProbe();
		this.filesystem = options.filesystem ?? new RealWorktreeFilesystem();
		mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
		chmodSync(this.rootDir, 0o700);
	}

	checkCapacity(): WorktreeCapacityResult {
		const activeLeases = this.store.worktreeLeases.countActive();
		if (activeLeases >= this.maxLeases) {
			return {
				ok: false,
				code: "worktree_capacity_exhausted",
				message: `worktree pool has ${activeLeases}/${this.maxLeases} active leases`,
				activeLeases,
				maxLeases: this.maxLeases,
				availableBytes: null,
			};
		}
		let availableBytes: number;
		try {
			availableBytes = this.diskFree.availableBytes(this.rootDir);
		} catch {
			return {
				ok: false,
				code: "worktree_disk_unknown",
				message: "worktree disk free space is unavailable",
				activeLeases,
				maxLeases: this.maxLeases,
				availableBytes: null,
			};
		}
		if (!Number.isFinite(availableBytes) || availableBytes < this.minFreeBytes) {
			return {
				ok: false,
				code: "worktree_disk_low",
				message: `worktree disk free ${availableBytes} is below ${this.minFreeBytes}`,
				activeLeases,
				maxLeases: this.maxLeases,
				availableBytes,
			};
		}
		return { ok: true, activeLeases, maxLeases: this.maxLeases, availableBytes };
	}

	acquire(input: { taskId: string; runId?: string | null; ttlMs?: number; now?: number }): WorktreeLease {
		const capacity = this.checkCapacity();
		if (!capacity.ok) throw new ControlError(capacity.code!, capacity.message ?? "worktree capacity is unavailable");
		const ttlMs = input.ttlMs ?? this.leaseTtlMs;
		positiveInteger(ttlMs, "ttlMs");
		const now = input.now ?? Date.now();
		const id = `wt_${randomUUID()}`;
		const path = join(this.rootDir, id);
		this.filesystem.createDirectory(path);
		try {
			const lease = this.store.worktreeLeases.create(
				{
					id,
					taskId: input.taskId,
					runId: input.runId ?? null,
					path,
					leaseExpiresAt: now + ttlMs,
				},
				{ maxActive: this.maxLeases },
			);
			this.store.audit.append({
				actor: "system:worktree-pool",
				action: "worktree_leased",
				subject: `task:${input.taskId}`,
				args: { leaseId: lease.id, path: lease.path, runId: lease.runId, leaseExpiresAt: lease.leaseExpiresAt },
			});
			return lease;
		} catch (error) {
			this.filesystem.removeDirectory(path);
			throw error;
		}
	}

	release(id: string, options: { remove?: boolean; actorRef?: string } = {}): WorktreeLease {
		const lease = this.store.worktreeLeases.release(id);
		if (options.remove) {
			this.removeLeasePath(lease);
			this.store.worktreeLeases.markCollected(lease.id);
		}
		this.store.audit.append({
			actor: options.actorRef ?? "system:worktree-pool",
			action: options.remove ? "worktree_released_and_removed" : "worktree_released",
			subject: `task:${lease.taskId}`,
			args: { leaseId: lease.id, path: lease.path },
		});
		return this.store.worktreeLeases.get(lease.id)!;
	}

	gc(options: { now?: number; dryRun?: boolean; actorRef?: string } = {}): WorktreeGcReport {
		const now = options.now ?? Date.now();
		const dryRun = options.dryRun ?? true;
		const entries: WorktreeGcEntry[] = [];
		const leases = this.store.worktreeLeases.list();
		const knownPaths = new Set(leases.map((lease) => resolve(lease.path)));
		for (const lease of leases) {
			if (lease.status === "collected") continue;
			const task = this.store.tasks.get(lease.taskId);
			const releasedExpired =
				lease.status === "released" && lease.releasedAt !== null && lease.releasedAt + this.releasedTtlMs <= now;
			const expiredTerminal =
				lease.status === "leased" &&
				lease.leaseExpiresAt !== null &&
				lease.leaseExpiresAt <= now &&
				(task === null || task.status === "done");
			const expiredInactive =
				lease.status === "leased" &&
				lease.leaseExpiresAt !== null &&
				lease.leaseExpiresAt + this.reclaimGraceMs <= now &&
				task !== null &&
				task.status !== "done" &&
				!this.hasRunningRun(lease.taskId);
			if (!releasedExpired && !expiredTerminal && !expiredInactive) continue;
			const reason = releasedExpired
				? "released_ttl"
				: expiredTerminal
					? "expired_task_terminal"
					: "expired_task_inactive";
			this.assertLeasePathWithinRoot(lease.path);
			entries.push({ id: lease.id, path: lease.path, reason, bytes: directoryBytes(lease.path) });
			if (!dryRun) {
				this.removeLeasePath(lease);
				this.store.worktreeLeases.markCollected(lease.id);
				this.store.audit.append({
					actor: options.actorRef ?? "system:worktree-pool",
					action: "worktree_collected",
					subject: `task:${lease.taskId}`,
					args: { leaseId: lease.id, path: lease.path, reason },
				});
			}
		}
		for (const entry of readdirSync(this.rootDir)) {
			const path = resolve(this.rootDir, entry);
			if (knownPaths.has(path)) continue;
			let stat: Stats;
			try {
				stat = lstatSync(path);
			} catch {
				continue;
			}
			if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
			if (stat.mtimeMs + this.orphanTtlMs > now) continue;
			entries.push({ id: null, path, reason: "orphan_ttl", bytes: directoryBytes(path) });
			if (!dryRun) {
				this.removePathWithinRoot(path);
				this.store.audit.append({
					actor: options.actorRef ?? "system:worktree-pool",
					action: "worktree_orphan_collected",
					subject: "worktree:orphan",
					args: { path },
				});
			}
		}
		return { dryRun, entries, bytesFreed: entries.reduce((sum, entry) => sum + entry.bytes, 0) };
	}

	private removeLeasePath(lease: WorktreeLease): void {
		this.removePathWithinRoot(lease.path);
	}

	private hasRunningRun(taskId: string): boolean {
		return this.store.runs.list({ taskId, status: "running" }).length > 0;
	}

	private removePathWithinRoot(path: string): void {
		const rootReal = realpathSync(this.rootDir);
		let targetReal: string;
		try {
			targetReal = realpathSync(path);
		} catch {
			return;
		}
		if (!targetReal.startsWith(`${rootReal}${sep}`)) {
			throw new ControlError("path_outside_root", `refusing to remove path outside worktree root: ${path}`);
		}
		const stat = lstatSync(path);
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			throw new ControlError("path_outside_root", `refusing to remove non-directory worktree path: ${path}`);
		}
		this.filesystem.removeDirectory(path);
	}

	private assertLeasePathWithinRoot(path: string): void {
		const rootReal = realpathSync(this.rootDir);
		let targetReal: string;
		try {
			targetReal = realpathSync(path);
		} catch {
			return;
		}
		if (!targetReal.startsWith(`${rootReal}${sep}`)) {
			throw new ControlError("path_outside_root", `worktree lease path is outside the pool root: ${path}`);
		}
	}
}
