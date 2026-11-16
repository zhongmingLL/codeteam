import type { DatabaseSync } from "node:sqlite";
import { ControlError } from "../errors.ts";
import { type Clock, changesOf, jsonObject, mapStoreError, newId, nonEmpty, parseJsonObject } from "./helpers.ts";
import type { AgentProfile, CreateAgentProfileInput, ProfileListFilter, ProfileSeed, ProfileStatus } from "./types.ts";

interface AgentProfileRow {
	id: string;
	role: string;
	display_name: string;
	provider: string;
	model: string;
	model_family: string;
	tool_policy_profile: string;
	role_description: string;
	restrictions_json: string;
	status: ProfileStatus;
	clowder_cat_id: string | null;
	created_at: number;
	updated_at: number;
}

function mapProfile(row: AgentProfileRow): AgentProfile {
	return {
		id: row.id,
		role: row.role,
		displayName: row.display_name,
		provider: row.provider,
		model: row.model,
		modelFamily: row.model_family,
		toolPolicyProfile: row.tool_policy_profile,
		roleDescription: row.role_description,
		restrictions: parseJsonObject(row.restrictions_json),
		status: row.status,
		clowderCatId: row.clowder_cat_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export class AgentProfileStore {
	private readonly database: DatabaseSync;
	private readonly clock: Clock;

	constructor(database: DatabaseSync, clock: Clock) {
		this.database = database;
		this.clock = clock;
	}

	get(id: string): AgentProfile | null {
		const row = this.database.prepare("SELECT * FROM agent_profiles WHERE id = ?").get(id) as
			| AgentProfileRow
			| undefined;
		return row ? mapProfile(row) : null;
	}

	list(filter: ProfileListFilter = {}): AgentProfile[] {
		const clauses: string[] = [];
		const params: string[] = [];
		if (filter.role !== undefined) {
			clauses.push("role = ?");
			params.push(filter.role);
		}
		if (filter.status !== undefined) {
			clauses.push("status = ?");
			params.push(filter.status);
		}
		const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
		const rows = this.database
			.prepare(`SELECT * FROM agent_profiles${where} ORDER BY id`)
			.all(...params) as unknown as AgentProfileRow[];
		return rows.map(mapProfile);
	}

	create(input: CreateAgentProfileInput): AgentProfile {
		const id = input.id ?? newId();
		const role = nonEmpty(input.role, "role");
		const displayName = nonEmpty(input.displayName, "displayName");
		const provider = nonEmpty(input.provider, "provider");
		const model = nonEmpty(input.model, "model");
		const modelFamily = nonEmpty(input.modelFamily, "modelFamily");
		const toolPolicyProfile = nonEmpty(input.toolPolicyProfile, "toolPolicyProfile");
		const now = this.clock();
		try {
			this.database
				.prepare(
					"INSERT INTO agent_profiles (id, role, display_name, provider, model, model_family, tool_policy_profile, role_description, restrictions_json, status, clowder_cat_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					id,
					role,
					displayName,
					provider,
					model,
					modelFamily,
					toolPolicyProfile,
					input.roleDescription ?? "",
					jsonObject(input.restrictions ?? {}, "restrictions"),
					input.status ?? "active",
					input.clowderCatId ?? null,
					now,
					now,
				);
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
		return this.get(id)!;
	}

	seedDefaultProfiles(config: { eval: ProfileSeed; compress: ProfileSeed }): void {
		const now = this.clock();
		const seeds: readonly { role: string; fallbackId: string; fallbackName: string; seed: ProfileSeed }[] = [
			{ role: "eval", fallbackId: "profile:eval", fallbackName: "Eval", seed: config.eval },
			{ role: "compress", fallbackId: "profile:compress", fallbackName: "Compress", seed: config.compress },
		];
		for (const entry of seeds) {
			const id = entry.seed.profileId ?? entry.fallbackId;
			try {
				this.database
					.prepare(
						"INSERT INTO agent_profiles (id, role, display_name, provider, model, model_family, tool_policy_profile, role_description, restrictions_json, status, clowder_cat_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?) ON CONFLICT(id) DO NOTHING",
					)
					.run(
						id,
						entry.role,
						entry.seed.displayName ?? entry.fallbackName,
						nonEmpty(entry.seed.provider, "provider"),
						nonEmpty(entry.seed.model, "model"),
						nonEmpty(entry.seed.modelFamily, "modelFamily"),
						entry.seed.toolPolicyProfile ?? "default",
						entry.seed.roleDescription ?? "",
						jsonObject(entry.seed.restrictions ?? {}, "restrictions"),
						entry.seed.clowderCatId ?? null,
						now,
						now,
					);
			} catch (error) {
				throw mapStoreError(error, "invalid_input");
			}
		}
	}

	setStatus(id: string, status: ProfileStatus, options: { expectedUpdatedAt?: number } = {}): AgentProfile {
		const now = this.clock();
		try {
			const result =
				options.expectedUpdatedAt === undefined
					? this.database
							.prepare("UPDATE agent_profiles SET status = ?, updated_at = ? WHERE id = ?")
							.run(status, now, id)
					: this.database
							.prepare("UPDATE agent_profiles SET status = ?, updated_at = ? WHERE id = ? AND updated_at = ?")
							.run(status, now, id, options.expectedUpdatedAt);
			if (changesOf(result) === 0) {
				if (!this.get(id)) throw new ControlError("not_found", `agent profile ${id} not found`);
				throw new ControlError("version_conflict", `agent profile ${id} changed since the expected revision`);
			}
			return this.get(id)!;
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
	}
}
