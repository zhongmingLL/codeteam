import { ControlError } from "../control/errors.ts";
import type { AgentProfile } from "../control/stores/types.ts";
import { option, type ParsedArgs, requireOption } from "./args.ts";
import { type CliContext, requireOperator } from "./context.ts";
import { writeJson, writeLine, writeTable } from "./output.ts";

export function runProfileCommand(args: ParsedArgs, context: CliContext): number {
	const subcommand = args.positionals[0];
	if (subcommand === "seed") return seedProfiles(args, context);
	if (subcommand === "add") return addProfile(args, context);
	if (subcommand === "list") return listProfiles(context);
	throw new ControlError("invalid_input", "usage: codeteam profile <seed|add|list>");
}

function seedProfiles(args: ParsedArgs, context: CliContext): number {
	requireOperator(context);
	const provider = option(args, "provider") ?? "test";
	context.store.seedIdentity({
		eval: {
			profileId: option(args, "eval-id") ?? "profile:eval",
			displayName: option(args, "eval-name") ?? "Eval",
			provider,
			model: option(args, "eval-model") ?? "glm-5.3-flash",
			modelFamily: option(args, "eval-family") ?? "glm",
		},
		compress: {
			profileId: option(args, "compress-id") ?? "profile:compress",
			displayName: option(args, "compress-name") ?? "Compress",
			provider,
			model: option(args, "compress-model") ?? "qwen3.8-flash",
			modelFamily: option(args, "compress-family") ?? "qwen",
		},
	});
	return outputProfiles(context, context.store.profiles.list());
}

function addProfile(args: ParsedArgs, context: CliContext): number {
	requireOperator(context);
	context.store.seedIdentity();
	const profile = context.store.profiles.create({
		id: requireOption(args, "id"),
		role: requireOption(args, "role"),
		displayName: requireOption(args, "display-name"),
		provider: requireOption(args, "provider"),
		model: requireOption(args, "model"),
		modelFamily: requireOption(args, "family"),
		toolPolicyProfile: option(args, "tool-policy") ?? "default",
		roleDescription: option(args, "role-description") ?? "",
		restrictions: {},
	});
	if (context.json) writeJson(profile);
	else writeLine(`created profile ${profile.id} role=${profile.role} status=${profile.status}`);
	return 0;
}

function listProfiles(context: CliContext): number {
	return outputProfiles(context, context.store.profiles.list({ status: "active" }));
}

function outputProfiles(context: CliContext, profiles: readonly AgentProfile[]): number {
	if (context.json) {
		writeJson(profiles);
		return 0;
	}
	writeTable(profiles, [
		{ header: "id", value: (profile) => profile.id },
		{ header: "role", value: (profile) => profile.role },
		{ header: "model", value: (profile) => profile.model },
		{ header: "family", value: (profile) => profile.modelFamily },
	]);
	return 0;
}
