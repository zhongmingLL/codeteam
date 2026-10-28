import { ControlError } from "../control/errors.ts";
import { DeploymentObservationService } from "../deployment-wait/observation.ts";
import { DeploymentWaitService } from "../deployment-wait/service.ts";
import type { DeploymentWaitPredicate } from "../deployment-wait/types.ts";
import { flag, option, options, type ParsedArgs, requireOption } from "./args.ts";
import { type CliContext, requireOperator } from "./context.ts";
import { writeJson, writeLine } from "./output.ts";

export function runDeploymentCommand(args: ParsedArgs, context: CliContext): number {
	if (args.positionals[0] !== "wait") {
		throw new ControlError("invalid_input", "usage: codeteam deployment wait <register|status|sweep|cancel> ...");
	}
	const action = args.positionals[1];
	if (action === "register") return registerWait(args, context);
	if (action === "status") return waitStatus(args, context);
	if (action === "sweep") return sweepWaits(args, context);
	if (action === "cancel") return cancelWait(args, context);
	throw new ControlError("invalid_input", "usage: codeteam deployment wait <register|status|sweep|cancel> ...");
}

function waitService(context: CliContext, args: ParsedArgs): DeploymentWaitService {
	const observer = new DeploymentObservationService({
		dataDir: context.dataDir,
		installationRoot: option(args, "installation-root") ?? process.env.CODETEAM_INSTALLATION_ROOT,
		deploymentId: option(args, "deployment-id") ?? process.env.CODETEAM_DEPLOYMENT_ID,
	});
	return new DeploymentWaitService(context.store, { observer });
}

function servicesOption(args: ParsedArgs): string[] {
	const raw = option(args, "services") ?? "daemon";
	const services = raw
		.split(",")
		.map((service) => service.trim())
		.filter((service) => service !== "");
	if (services.length === 0) throw new ControlError("invalid_input", "--services must be a non-empty list");
	return [...new Set(services)];
}

function registerWait(args: ParsedArgs, context: CliContext): number {
	const operator = requireOperator(context);
	const taskId = args.positionals[2];
	if (!taskId) {
		throw new ControlError(
			"invalid_input",
			"usage: codeteam deployment wait register <taskId> (--revision <sha> | --new-boot) --to <profile> [--services daemon]",
		);
	}
	const targets = options(args, "to");
	if (targets.length === 0) throw new ControlError("invalid_input", "--to <profile> is required");
	const services = servicesOption(args);
	const newBoot = flag(args, "new-boot");
	const revision = option(args, "revision");
	if (newBoot === (revision !== undefined)) {
		throw new ControlError("invalid_input", "provide exactly one of --revision or --new-boot");
	}
	const predicate: DeploymentWaitPredicate = newBoot
		? { kind: "new_ready_boot", services }
		: { kind: "revision_included", revision: requireOption(args, "revision"), services };
	const state = waitService(context, args).register({
		taskId,
		predicate,
		targetProfileIds: targets,
		actorRef: `user:${operator.id}`,
	});
	if (context.json) writeJson(state);
	else writeLine(`registered deployment wait task=${taskId} status=${state.status} subject=${state.subjectRef}`);
	return 0;
}

function waitStatus(args: ParsedArgs, context: CliContext): number {
	const taskId = args.positionals[2];
	if (!taskId) throw new ControlError("invalid_input", "usage: codeteam deployment wait status <taskId>");
	const projection = waitService(context, args).projection(taskId);
	if (context.json) writeJson(projection);
	else if (!projection.state) writeLine(`task ${taskId} has no deployment wait`);
	else {
		writeLine(`task ${taskId} deployment_wait=${projection.state.status} subject=${projection.state.subjectRef}`);
		if (projection.state.outcome) {
			writeLine(
				`outcome=${projection.state.outcome.outcomeId} delivery=${projection.state.outcome.delivery} queue=${projection.state.outcome.queueEntryId ?? "-"}`,
			);
		}
	}
	return 0;
}

function sweepWaits(args: ParsedArgs, context: CliContext): number {
	const result = waitService(context, args).sweep(Date.now());
	if (context.json) writeJson(result);
	else {
		writeLine(`matched=${result.matched.length} delivered=${result.delivered.length} errors=${result.errors.length}`);
		for (const error of result.errors) writeLine(`error ${error.taskId}: ${error.message}`);
	}
	return 0;
}

function cancelWait(args: ParsedArgs, context: CliContext): number {
	const operator = requireOperator(context);
	const taskId = args.positionals[2];
	if (!taskId) {
		throw new ControlError("invalid_input", "usage: codeteam deployment wait cancel <taskId> --reason <text>");
	}
	const state = waitService(context, args).cancel({
		taskId,
		actorRef: `user:${operator.id}`,
		reason: requireOption(args, "reason"),
	});
	if (context.json) writeJson(state);
	else if (!state) writeLine(`task ${taskId} has no deployment wait`);
	else writeLine(`canceled deployment wait task=${taskId} status=${state.status} subject=${state.subjectRef}`);
	return 0;
}
