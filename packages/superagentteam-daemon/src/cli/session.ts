import { ControlError } from "../control/errors.ts";
import type { SessionStatus } from "../control/stores/types.ts";
import { option, type ParsedArgs } from "./args.ts";
import type { CliContext } from "./context.ts";
import { writeJson, writeLine, writeTable } from "./output.ts";

const SESSION_STATUSES = new Set<SessionStatus>(["active", "sealed"]);

export function runSessionCommand(args: ParsedArgs, context: CliContext): number {
	const subcommand = args.positionals[0];
	if (subcommand === "list") {
		const rawStatus = option(args, "status");
		if (rawStatus && !SESSION_STATUSES.has(rawStatus as SessionStatus)) {
			throw new ControlError("invalid_input", `unknown session status ${rawStatus}`);
		}
		const sessions = context.store.sessions.list({
			threadId: option(args, "thread"),
			taskId: option(args, "task"),
			profileId: option(args, "profile"),
			status: rawStatus as SessionStatus | undefined,
		});
		if (context.json) {
			writeJson(sessions);
			return 0;
		}
		writeTable(sessions, [
			{ header: "id", value: (session) => session.id },
			{ header: "status", value: (session) => session.status },
			{ header: "task", value: (session) => session.taskId ?? "-" },
			{ header: "profile", value: (session) => session.profileId },
			{ header: "role", value: (session) => session.role },
			{ header: "worker", value: (session) => session.workerId ?? "-" },
		]);
		return 0;
	}
	if (subcommand === "show") {
		const id = args.positionals[1];
		if (!id) throw new ControlError("invalid_input", "usage: codeteam session show <sessionId>");
		const session = context.store.sessions.get(id);
		if (!session) throw new ControlError("not_found", `agent session ${id} not found`);
		if (context.json) writeJson(session);
		else {
			writeLine(
				`${session.id} status=${session.status} task=${session.taskId ?? "-"} profile=${session.profileId} role=${session.role}`,
			);
			writeLine(`provider=${session.provider} model=${session.model} family=${session.modelFamily}`);
			if (session.workingDirectory) writeLine(`worktree=${session.workingDirectory}`);
			if (session.workerId) writeLine(`worker=${session.workerId} binding=${session.workerBindingState}`);
		}
		return 0;
	}
	throw new ControlError("invalid_input", "usage: codeteam session <list|show>");
}
