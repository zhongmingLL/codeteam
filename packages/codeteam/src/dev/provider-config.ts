import { existsSync, readFileSync } from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export type SmokeProvider = "deepseek" | "kimi" | "glm";

export interface ModelConfig {
	model: string;
	base_url: string;
	"api-key": string;
}

export function loadModelConfigs(path: string): ModelConfig[] {
	if (!existsSync(path)) throw new Error(`missing model config file: ${path}`);
	return readFileSync(path, "utf8")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"))
		.map((line) => JSON.parse(line) as ModelConfig);
}

export function readProvider(envName: string, fallback: SmokeProvider): SmokeProvider {
	const value = process.env[envName] ?? fallback;
	if (value === "deepseek" || value === "kimi" || value === "glm") return value;
	throw new Error(`unknown ${envName}: ${value}`);
}

export function findConfig(configs: ModelConfig[], provider: SmokeProvider): ModelConfig {
	const preferred =
		provider === "deepseek"
			? ["deepseek-flash", "deepseek"]
			: provider === "kimi"
				? ["kimi-for-coding", "kimi"]
				: ["glm-5.3-flash", "glm"];
	const config =
		configs.find((entry) => entry.model === preferred[0]) ??
		configs.find((entry) => entry.model.includes(preferred[1]));
	if (!config) throw new Error(`no model config found for provider ${provider}`);
	return config;
}

export function configureAllAuth(configs: ModelConfig[]): void {
	for (const config of configs) {
		if (config.model.includes("deepseek")) {
			process.env.DEEPSEEK_API_KEY = config["api-key"];
		} else if (config.model.includes("kimi")) {
			process.env.KIMI_API_KEY = config["api-key"];
		} else if (config.model.includes("glm")) {
			process.env.ANTHROPIC_API_KEY = config["api-key"];
			process.env.ZAI_API_KEY = config["api-key"];
			process.env.ZAI_CODING_CN_API_KEY = config["api-key"];
		}
	}
}

export function selectModel(
	runtime: ModelRuntime,
	provider: SmokeProvider,
	config: ModelConfig,
): { model: Model<Api>; label: string } {
	if (provider === "deepseek") {
		const model = runtime.getModel("deepseek", "deepseek-flash");
		if (!model) throw new Error("deepseek/deepseek-flash not found in runtime catalog");
		return { model, label: "deepseek/deepseek-flash" };
	}
	if (provider === "kimi") {
		const model = runtime.getModel("kimi-coding", "k3-256k") ?? runtime.getModel("kimi-coding", "k3");
		if (!model) throw new Error("kimi-coding model not found in runtime catalog");
		return { model, label: `kimi-coding/${model.id}` };
	}
	const base = runtime.getModel("anthropic", "claude-sonnet-4-5");
	if (!base) throw new Error("anthropic/claude-sonnet-4-5 base model not found in runtime catalog");
	const model: Model<Api> = {
		...base,
		id: "glm-5.3-flash",
		name: "GLM-5.3-Flash",
		provider: "anthropic",
		api: "anthropic-messages",
		baseUrl: config.base_url.includes("/api/anthropic") ? config.base_url : "https://open.bigmodel.cn/api/anthropic",
		reasoning: false,
		input: ["text"],
		contextWindow: 200_000,
		maxTokens: 131_072,
	};
	return { model, label: "anthropic-compatible/glm-5.3-flash" };
}
