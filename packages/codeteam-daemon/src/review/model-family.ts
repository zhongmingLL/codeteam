import { ControlError } from "../control/errors.ts";

export const MODEL_FAMILY_REGISTRY = {
	deepseek: ["deepseek"],
	glm: ["glm", "zhipu", "chatglm"],
	kimi: ["kimi", "moonshot"],
	qwen: ["qwen"],
	gemini: ["gemini"],
	openai: ["gpt", "o1", "o3", "o4", "codex"],
	anthropic: ["claude"],
} as const;

export type ModelFamily = keyof typeof MODEL_FAMILY_REGISTRY;

export const MODEL_FAMILIES: readonly ModelFamily[] = Object.freeze(
	Object.keys(MODEL_FAMILY_REGISTRY) as ModelFamily[],
);

export function isModelFamily(value: string): value is ModelFamily {
	return Object.hasOwn(MODEL_FAMILY_REGISTRY, value);
}

function normalizeModelId(model: string): string {
	const trimmed = model.trim().toLowerCase();
	const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf(":"));
	return separator >= 0 ? trimmed.slice(separator + 1) : trimmed;
}

export function resolveModelFamily(model: string): ModelFamily | null {
	const modelId = normalizeModelId(model);
	if (modelId === "") return null;
	for (const family of MODEL_FAMILIES) {
		if (MODEL_FAMILY_REGISTRY[family].some((prefix) => modelId.startsWith(prefix))) return family;
	}
	return null;
}

export function assertModelFamilyClaim(model: string, declaredFamily: string): ModelFamily {
	const family = declaredFamily.trim().toLowerCase();
	if (!isModelFamily(family)) {
		throw new ControlError("invalid_input", `unknown model family: ${declaredFamily}`);
	}
	const resolved = resolveModelFamily(model);
	if (!resolved) {
		throw new ControlError(
			"invalid_input",
			`model ${model} is not in the static model family registry; add it before using it for review`,
		);
	}
	if (resolved !== family) {
		throw new ControlError(
			"invalid_input",
			`model ${model} belongs to family ${resolved}, not declared family ${family}`,
		);
	}
	return family;
}
