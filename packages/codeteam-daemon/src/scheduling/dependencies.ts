import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import type { BacklogItem } from "../control/stores/types.ts";

export interface DependencyState {
	readonly satisfied: boolean;
	readonly dependsOn: readonly string[];
	readonly unmet: readonly string[];
	readonly missing: readonly string[];
	readonly cycle: readonly string[];
}

export function parseDependsOn(backlog: Pick<BacklogItem, "id" | "dependencies">): string[] {
	const dependencies = backlog.dependencies;
	if (dependencies === null) return [];
	const raw = dependencies.dependsOn;
	if (raw === undefined) return [];
	if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string" && item.trim() !== "")) {
		throw new ControlError("invalid_input", `backlog item ${backlog.id} has invalid dependencies.dependsOn`);
	}
	const unique = [...new Set(raw)];
	if (unique.length !== raw.length) {
		throw new ControlError("invalid_input", `backlog item ${backlog.id} has duplicate dependencies`);
	}
	if (unique.includes(backlog.id)) {
		throw new ControlError("invalid_input", `backlog item ${backlog.id} cannot depend on itself`);
	}
	return unique;
}

export function dependencyState(store: ControlStore, backlogId: string): DependencyState {
	const items = new Map<string, ReturnType<ControlStore["backlog"]["get"]>>();
	const getItem = (id: string) => {
		if (!items.has(id)) items.set(id, store.backlog.get(id));
		return items.get(id) ?? null;
	};
	const start = getItem(backlogId);
	if (!start) throw new ControlError("not_found", `backlog item ${backlogId} not found`);
	const dependsOn = parseDependsOn(start);
	const unmet: string[] = [];
	const missing: string[] = [];
	const cycle: string[] = [];
	const visiting = new Set<string>();
	const visited = new Set<string>();

	const walk = (id: string, path: string[]): void => {
		if (cycle.length > 0) return;
		if (visiting.has(id)) {
			cycle.push(...path.slice(path.indexOf(id)), id);
			return;
		}
		if (visited.has(id)) return;
		visiting.add(id);
		const item = getItem(id);
		if (!item) {
			missing.push(id);
		} else {
			if (id !== backlogId && item.status !== "done") unmet.push(id);
			for (const dependency of parseDependsOn(item)) walk(dependency, [...path, id]);
		}
		visiting.delete(id);
		visited.add(id);
	};

	walk(backlogId, []);
	return {
		satisfied: unmet.length === 0 && missing.length === 0 && cycle.length === 0,
		dependsOn,
		unmet,
		missing,
		cycle,
	};
}

export function assertDependencyGraph(store: ControlStore, backlogId: string): string[] {
	const state = dependencyState(store, backlogId);
	if (state.missing.length > 0) {
		throw new ControlError("dependency_missing", `missing dependencies: ${state.missing.join(", ")}`);
	}
	if (state.cycle.length > 0) {
		throw new ControlError("dependency_cycle", `dependency cycle: ${state.cycle.join(" -> ")}`);
	}
	if (state.unmet.length > 0) {
		throw new ControlError("dependency_unmet", `dependencies not done: ${state.unmet.join(", ")}`);
	}
	return [...state.dependsOn];
}
