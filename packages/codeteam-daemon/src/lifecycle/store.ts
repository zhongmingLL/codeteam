import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { ControlError } from "../control/errors.ts";
import type { ProcessIdentity, StopClaim, StopOperationRecord, StopOperationState } from "./types.ts";

export interface LifecyclePaths {
	readonly root: string;
	readonly opsDir: string;
	readonly claimsDir: string;
	readonly pointerFile: string;
}

export function resolveLifecyclePaths(dataDir: string): LifecyclePaths {
	const root = join(dataDir, "lifecycle");
	const opsDir = join(root, "ops");
	const claimsDir = join(root, "claims");
	for (const dir of [root, opsDir, claimsDir]) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dir, 0o700);
	}
	return { root, opsDir, claimsDir, pointerFile: join(root, "current.json") };
}

function atomicWrite(path: string, value: unknown): void {
	const temp = `${path}.tmp-${process.pid}`;
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	chmodSync(temp, 0o600);
	renameSync(temp, path);
}

export class StopOperationStore {
	private readonly paths: LifecyclePaths;
	private readonly clock: () => Date;

	constructor(paths: LifecyclePaths, clock: () => Date = () => new Date()) {
		this.paths = paths;
		this.clock = clock;
	}

	get pathsValue(): LifecyclePaths {
		return this.paths;
	}

	read(opId: string): StopOperationRecord | null {
		const path = join(this.paths.opsDir, `${opId}.json`);
		if (!existsSync(path)) return null;
		try {
			return JSON.parse(readFileSync(path, "utf8")) as StopOperationRecord;
		} catch (error) {
			throw new ControlError("lifecycle_record_invalid", `lifecycle record ${opId} is unreadable`, { cause: error });
		}
	}

	latest(): StopOperationRecord | null {
		if (!existsSync(this.paths.pointerFile)) return null;
		try {
			const pointer = JSON.parse(readFileSync(this.paths.pointerFile, "utf8")) as { opId?: string };
			return pointer.opId ? this.read(pointer.opId) : null;
		} catch (error) {
			throw new ControlError("lifecycle_record_invalid", "lifecycle pointer is unreadable", { cause: error });
		}
	}

	list(): StopOperationRecord[] {
		return readdirSync(this.paths.opsDir)
			.filter((name) => name.endsWith(".json"))
			.map((name) => this.read(name.slice(0, -".json".length)))
			.filter((record): record is StopOperationRecord => record !== null)
			.sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
	}

	write(record: StopOperationRecord): StopOperationRecord {
		atomicWrite(join(this.paths.opsDir, `${record.opId}.json`), record);
		atomicWrite(this.paths.pointerFile, { opId: record.opId });
		return record;
	}

	createRequested(input: {
		opId: string;
		deploymentId: string;
		installationId: string;
		installationRoot: string;
		requestedBy: string;
		stoppedBootId: string;
		targetProcessSet: readonly number[];
		frozenIdentity: ProcessIdentity;
	}): StopOperationRecord {
		if (this.read(input.opId)) {
			throw new ControlError("lifecycle_state_invalid", `lifecycle operation ${input.opId} already exists`);
		}
		const at = this.clock().toISOString();
		return this.write({
			v: 1,
			opId: input.opId,
			deploymentId: input.deploymentId,
			installationId: input.installationId,
			installationRoot: input.installationRoot,
			state: "requested",
			requestedBy: input.requestedBy,
			requestedAt: at,
			stoppedBootId: input.stoppedBootId,
			targetProcessSet: [...new Set(input.targetProcessSet)],
			frozenIdentity: input.frozenIdentity,
			history: [{ state: "requested", at }],
		});
	}

	transition(
		opId: string,
		expected: StopOperationState | readonly StopOperationState[],
		next: StopOperationState,
		patch: Partial<StopOperationRecord> = {},
		detail?: string,
	): StopOperationRecord {
		const current = this.read(opId);
		if (!current) throw new ControlError("not_found", `lifecycle operation ${opId} not found`);
		const expectedStates = Array.isArray(expected) ? expected : [expected];
		if (!expectedStates.includes(current.state)) {
			throw new ControlError(
				"lifecycle_state_invalid",
				`lifecycle operation ${opId} is ${current.state}, expected ${expectedStates.join(",")}`,
			);
		}
		if (current.state === "reverified" || current.state === "failed" || current.state === "stale_cleared") {
			throw new ControlError("lifecycle_state_invalid", `lifecycle operation ${opId} is terminal`);
		}
		const at = this.clock().toISOString();
		const record: StopOperationRecord = {
			...current,
			...patch,
			state: next,
			history: [...current.history, { state: next, at, ...(detail ? { detail } : {}) }],
		};
		return this.write(record);
	}

	fail(opId: string, reason: string): StopOperationRecord {
		const current = this.read(opId);
		if (!current) throw new ControlError("not_found", `lifecycle operation ${opId} not found`);
		if (current.state === "reverified" || current.state === "failed" || current.state === "stale_cleared") {
			throw new ControlError("lifecycle_state_invalid", `lifecycle operation ${opId} is terminal`);
		}
		const at = this.clock().toISOString();
		return this.write({
			...current,
			state: "failed",
			failure: { reason, at },
			history: [...current.history, { state: "failed", at, detail: reason }],
		});
	}

	readClaim(deploymentId: string): StopClaim | null {
		const path = join(this.paths.claimsDir, `${deploymentId}.claim`);
		if (!existsSync(path)) return null;
		try {
			return JSON.parse(readFileSync(path, "utf8")) as StopClaim;
		} catch (error) {
			throw new ControlError("lifecycle_record_invalid", `lifecycle claim for ${deploymentId} is unreadable`, {
				cause: error,
			});
		}
	}

	acquireClaim(deploymentId: string, holder: ProcessIdentity, isAlive: (pid: number) => boolean): StopClaim {
		const path = join(this.paths.claimsDir, `${deploymentId}.claim`);
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const current = this.readClaim(deploymentId);
			const generation = (current?.generation ?? 0) + 1;
			try {
				const fd = openSync(path, "wx", 0o600);
				const claim: StopClaim = {
					generation,
					holder: { ...holder, token: `claim:${generation}:${process.pid}`, at: this.clock().toISOString() },
				};
				writeSync(fd, JSON.stringify(claim));
				closeSync(fd);
				return claim;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const existing = this.readClaim(deploymentId);
				if (existing && isAlive(existing.holder.pid)) {
					throw new ControlError(
						"lifecycle_claim_held",
						`lifecycle claim for ${deploymentId} is held by pid ${existing.holder.pid}`,
					);
				}
				try {
					unlinkSync(path);
				} catch {
					// Another executor may have removed it; retry once.
				}
			}
		}
		throw new ControlError("lifecycle_claim_held", `lifecycle claim for ${deploymentId} could not be acquired`);
	}

	releaseClaim(deploymentId: string, token: string): void {
		const current = this.readClaim(deploymentId);
		if (!current || current.holder.token !== token) return;
		try {
			unlinkSync(join(this.paths.claimsDir, `${deploymentId}.claim`));
		} catch {
			// Already gone.
		}
	}
}
