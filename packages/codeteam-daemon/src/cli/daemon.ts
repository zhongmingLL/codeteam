import { randomUUID } from "node:crypto";
import { operatorCredentialPaths, signOperatorPayload } from "../auth/operator.ts";
import { ControlError } from "../control/errors.ts";
import { authorizationPayload, StopOperationService } from "../lifecycle/index.ts";
import { resolveDaemonPaths } from "../paths.ts";
import { readStateFile } from "../state.ts";
import { option, type ParsedArgs } from "./args.ts";
import { type CliContext, requireOperator } from "./context.ts";
import { writeJson, writeLine } from "./output.ts";

function daemonService(context: CliContext, args: ParsedArgs): StopOperationService {
	return new StopOperationService({
		dataDir: context.dataDir,
		deploymentId: option(args, "deployment-id") ?? process.env.CODETEAM_DEPLOYMENT_ID ?? "local",
		installationRoot: option(args, "installation-root") ?? process.env.CODETEAM_INSTALLATION_ROOT ?? process.cwd(),
	});
}

export async function runDaemonCommand(args: ParsedArgs, context: CliContext): Promise<number> {
	const subcommand = args.positionals[0];
	if (subcommand === "status") {
		const status = daemonService(context, args).status();
		if (context.json) writeJson(status);
		else {
			writeLine(
				`daemon state=${status.daemonState?.state ?? "unknown"} boot=${status.daemonState?.bootId ?? "-"} sequence=${status.daemonState?.bootSequence ?? "-"}`,
			);
			if (status.latestOperation) {
				writeLine(`lifecycle op=${status.latestOperation.opId} state=${status.latestOperation.state}`);
			}
		}
		return 0;
	}
	if (subcommand === "stop") {
		const operator = requireOperator(context);
		const daemonPaths = resolveDaemonPaths(context.dataDir);
		const state = readStateFile(daemonPaths.stateFile);
		if (!state) throw new ControlError("not_found", "daemon state is not available");
		const deploymentId = option(args, "deployment-id") ?? process.env.CODETEAM_DEPLOYMENT_ID ?? "local";
		const opId = `lifecycle_${randomUUID()}`;
		const keyFingerprint = operatorCredentialPaths(context.dataDir).fingerprint;
		const authorization = {
			opId,
			deploymentId,
			stoppedBootId: state.bootId,
			action: "halt" as const,
			operatorRef: `operator:${operator.id}`,
			keyFingerprint,
			signature: signOperatorPayload(
				operator.privateKey,
				authorizationPayload(opId, deploymentId, state.bootId, "halt"),
			),
		};
		const service = daemonService(context, args);
		service.requestStop(authorization);
		const record = await service.executeStop(opId);
		if (context.json) writeJson(record);
		else writeLine(`lifecycle ${record.opId} state=${record.state}`);
		return 0;
	}
	throw new ControlError("invalid_input", "usage: codeteam daemon <status|stop>");
}
