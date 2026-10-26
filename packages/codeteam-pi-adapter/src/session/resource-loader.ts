import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import type { CompiledL0 } from "../l0/compiler.ts";

export interface CreateL0ResourceLoaderOptions {
	cwd: string;
	agentDir: string;
	compiledL0: CompiledL0;
}

export interface L0ResourceLoader {
	loader: DefaultResourceLoader;
	l0Revision: string;
}

export async function createL0ResourceLoader(options: CreateL0ResourceLoaderOptions): Promise<L0ResourceLoader> {
	const loader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: () => options.compiledL0.text,
		appendSystemPromptOverride: () => [],
	});
	await loader.reload();
	return { loader, l0Revision: options.compiledL0.revision };
}
