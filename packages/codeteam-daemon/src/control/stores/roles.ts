import type { DatabaseSync } from "node:sqlite";
import { ControlError } from "../errors.ts";
import { type Clock, changesOf, mapStoreError, newId, nonEmpty } from "./helpers.ts";
import type { CreateRoleInput, Role, RoleSetStatusOptions, RoleStatus } from "./types.ts";

interface RoleRow {
	id: string;
	label: string;
	description: string;
	status: RoleStatus;
	created_at: number;
	updated_at: number;
}

const BUILT_IN_ROLES: readonly { id: string; label: string; description: string }[] = [
	{ id: "architect", label: "Architect", description: "Architecture and cross-cutting design" },
	{ id: "coder", label: "Coder", description: "Primary implementation owner" },
	{ id: "reviewer", label: "Reviewer", description: "Independent review and findings" },
	{ id: "verifier", label: "Verifier", description: "Falsifier and evidence verification" },
	{ id: "eval", label: "Eval", description: "Evaluation and measurement" },
	{ id: "compress", label: "Compress", description: "Context compaction" },
];

function mapRole(row: RoleRow): Role {
	return {
		id: row.id,
		label: row.label,
		description: row.description,
		status: row.status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export class RoleStore {
	private readonly database: DatabaseSync;
	private readonly clock: Clock;

	constructor(database: DatabaseSync, clock: Clock) {
		this.database = database;
		this.clock = clock;
	}

	seedBuiltInRoles(): void {
		const now = this.clock();
		for (const role of BUILT_IN_ROLES) {
			this.database
				.prepare(
					"INSERT INTO roles (id, label, description, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?) ON CONFLICT(id) DO NOTHING",
				)
				.run(role.id, role.label, role.description, now, now);
		}
	}

	list(): Role[] {
		const rows = this.database.prepare("SELECT * FROM roles ORDER BY id").all() as unknown as RoleRow[];
		return rows.map(mapRole);
	}

	get(id: string): Role | null {
		const row = this.database.prepare("SELECT * FROM roles WHERE id = ?").get(id) as RoleRow | undefined;
		return row ? mapRole(row) : null;
	}

	create(input: CreateRoleInput): Role {
		const id = input.id ?? newId();
		const label = nonEmpty(input.label, "label");
		const now = this.clock();
		try {
			this.database
				.prepare(
					"INSERT INTO roles (id, label, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
				)
				.run(id, label, input.description ?? "", input.status ?? "active", now, now);
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
		return this.get(id)!;
	}

	setStatus(id: string, status: RoleStatus, options: RoleSetStatusOptions = {}): Role {
		const now = this.clock();
		try {
			const result =
				options.expectedUpdatedAt === undefined
					? this.database.prepare("UPDATE roles SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id)
					: this.database
							.prepare("UPDATE roles SET status = ?, updated_at = ? WHERE id = ? AND updated_at = ?")
							.run(status, now, id, options.expectedUpdatedAt);
			if (changesOf(result) === 0) {
				if (!this.get(id)) throw new ControlError("not_found", `role ${id} not found`);
				throw new ControlError("version_conflict", `role ${id} changed since the expected revision`);
			}
			return this.get(id)!;
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
	}
}
