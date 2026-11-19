import { readFileSync } from "node:fs";

import type { AccountConfig, AgentCatalog, AgentConfig } from "@superagentteam/shared/types";

// F018 AgentCatalog loading and the pattern→agentId mention index (0008).
// Provenance: catalog load/validate/atomic-rename conventions follow the
// Clowder cat-catalog loader; validation rules are 0008 §6 verbatim.

export type CatalogErrorCode =
	| "catalog_invalid_json"
	| "catalog_invalid_shape"
	| "agent_id_empty"
	| "agent_id_duplicate"
	| "mention_patterns_empty"
	| "mention_pattern_empty"
	| "mention_pattern_conflict"
	| "display_name_empty"
	| "context_window_invalid"
	| "role_id_empty"
	| "account_ref_unresolved"
	| "default_model_not_in_account"
	| "account_models_empty";

export class CatalogError extends Error {
	constructor(readonly code: CatalogErrorCode, message: string) {
		super(message);
		this.name = "CatalogError";
	}
}

export interface AgentRegistry {
	/** agentId -> config */
	readonly agents: ReadonlyMap<string, AgentConfig>;
	/** normalized lowercase pattern (with @) -> agentId; uniqueness fail-closed */
	readonly mentionIndex: ReadonlyMap<string, string>;
	readonly accounts: ReadonlyMap<string, AccountConfig>;
	readonly defaultAgentId: string | null;
}

function normalizePattern(raw: string): string {
	const trimmed = raw.trim().toLowerCase();
	return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

export function validateCatalog(catalog: AgentCatalog, accounts: readonly AccountConfig[]): void {
	if (!catalog || !Array.isArray(catalog.agents)) {
		throw new CatalogError("catalog_invalid_shape", "catalog.agents must be an array");
	}
	const accountModels = new Map<string, ReadonlySet<string>>();
	for (const account of accounts) {
		if (!account.ref) throw new CatalogError("catalog_invalid_shape", "account.ref empty");
		if (!Array.isArray(account.models) || account.models.length === 0) {
			throw new CatalogError("account_models_empty", `account ${account.ref} has no models`);
		}
		accountModels.set(account.ref, new Set(account.models));
	}
	const seenIds = new Set<string>();
	const seenPatterns = new Map<string, string>();
	for (const agent of catalog.agents) {
		if (!agent.id) throw new CatalogError("agent_id_empty", "agent id must be non-empty");
		if (seenIds.has(agent.id)) {
			throw new CatalogError("agent_id_duplicate", `duplicate agent id ${agent.id}`);
		}
		seenIds.add(agent.id);
		if (!Array.isArray(agent.mentionPatterns) || agent.mentionPatterns.length === 0) {
			throw new CatalogError("mention_patterns_empty", `agent ${agent.id} has no mentionPatterns`);
		}
		for (const raw of agent.mentionPatterns) {
			const pattern = normalizePattern(raw);
			if (pattern === "@") throw new CatalogError("mention_pattern_empty", `agent ${agent.id} has empty pattern`);
			const owner = seenPatterns.get(pattern);
			if (owner !== undefined) {
				// Cross-agent case-insensitive uniqueness; fail closed (0008 §6).
				throw new CatalogError(
					"mention_pattern_conflict",
					`pattern ${pattern} claimed by ${owner} and ${agent.id}`,
				);
			}
			seenPatterns.set(pattern, agent.id);
		}
		if (!agent.displayName) throw new CatalogError("display_name_empty", `agent ${agent.id} displayName empty`);
		if (!Number.isInteger(agent.contextWindow) || agent.contextWindow <= 0) {
			throw new CatalogError("context_window_invalid", `agent ${agent.id} contextWindow must be positive`);
		}
		if (!agent.roleId) throw new CatalogError("role_id_empty", `agent ${agent.id} roleId empty`);
		const models = accountModels.get(agent.accountRef);
		if (models === undefined) {
			throw new CatalogError("account_ref_unresolved", `agent ${agent.id} references unknown account ${agent.accountRef}`);
		}
		if (!models.has(agent.defaultModel)) {
			throw new CatalogError(
				"default_model_not_in_account",
				`agent ${agent.id} defaultModel ${agent.defaultModel} not in account ${agent.accountRef}`,
			);
		}
	}
}

export function buildRegistry(
	catalog: AgentCatalog,
	accounts: readonly AccountConfig[],
	defaultAgentId?: string,
): AgentRegistry {
	validateCatalog(catalog, accounts);
	const agents = new Map<string, AgentConfig>();
	const mentionIndex = new Map<string, string>();
	for (const agent of catalog.agents) {
		agents.set(agent.id, agent);
		for (const raw of agent.mentionPatterns) {
			mentionIndex.set(normalizePattern(raw), agent.id);
		}
	}
	const resolvedDefault =
		defaultAgentId && agents.has(defaultAgentId) ? defaultAgentId : (catalog.agents[0]?.id ?? null);
	return { agents, mentionIndex, accounts: new Map(accounts.map((a) => [a.ref, a])), defaultAgentId: resolvedDefault };
}

export interface CatalogPaths {
	catalogPath: string;
	accountsPath: string;
}

export function loadRegistryFromFiles(paths: CatalogPaths, defaultAgentId?: string): AgentRegistry {
	let catalogRaw: unknown;
	let accountsRaw: unknown;
	try {
		catalogRaw = JSON.parse(readFileSync(paths.catalogPath, "utf8"));
	} catch (error) {
		throw new CatalogError("catalog_invalid_json", `catalog: ${(error as Error).message}`);
	}
	try {
		accountsRaw = JSON.parse(readFileSync(paths.accountsPath, "utf8"));
	} catch (error) {
		throw new CatalogError("catalog_invalid_json", `accounts: ${(error as Error).message}`);
	}
	return buildRegistry(catalogRaw as AgentCatalog, accountsRaw as AccountConfig[], defaultAgentId);
}

/**
 * resolveExplicitTargets (0007 §3.0 step 2). Three-state semantics:
 * hit + enabled -> agentId; hit + disabled -> agent_disabled; catalog/index
 * inconsistency -> agent_not_found (fail closed). Ambiguity is impossible by
 * construction (uniqueness enforced at load); this is kept defensive.
 */
export type ResolvedTarget = { kind: "ok"; agentId: string } | { kind: "agent_disabled" | "agent_not_found"; pattern: string };

export function resolveExplicitTarget(registry: AgentRegistry, pattern: string): ResolvedTarget {
	const normalized = normalizePattern(pattern);
	const agentId = registry.mentionIndex.get(normalized);
	if (agentId === undefined) return { kind: "agent_not_found", pattern: normalized };
	const config = registry.agents.get(agentId);
	if (config === undefined) return { kind: "agent_not_found", pattern: normalized };
	if (!config.enabled) return { kind: "agent_disabled", pattern: normalized };
	return { kind: "ok", agentId };
}
