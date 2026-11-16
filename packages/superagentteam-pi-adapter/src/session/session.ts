import {
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
} from "@earendil-works/pi-coding-agent";
import type { CompiledL0 } from "../l0/compiler.ts";
import { createL0ResourceLoader } from "./resource-loader.ts";

export type CreateAgentSessionWithL0Options = Omit<CreateAgentSessionOptions, "cwd" | "agentDir" | "resourceLoader"> & {
	cwd: string;
	agentDir: string;
	compiledL0: CompiledL0;
	/** Curated skill directories resolved from the codeteam allowlist. */
	curatedSkillPaths?: string[];
};

export type CreateAgentSessionWithL0Result = CreateAgentSessionResult & {
	l0Revision: string;
};

export async function createAgentSessionWithL0(
	options: CreateAgentSessionWithL0Options,
): Promise<CreateAgentSessionWithL0Result> {
	const { loader, l0Revision } = await createL0ResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		compiledL0: options.compiledL0,
		additionalSkillPaths: options.curatedSkillPaths,
	});
	const result = await createAgentSession({
		...options,
		resourceLoader: loader,
	});
	return { ...result, l0Revision };
}
