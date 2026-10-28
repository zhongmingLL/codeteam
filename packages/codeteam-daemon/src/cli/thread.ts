import { join } from "node:path";
import { ControlError } from "../control/errors.ts";
import type { Message, MessageKind, ThreadPhase } from "../control/stores/types.ts";
import { BudgetService } from "../scheduling/budget.ts";
import { TaskReadinessService } from "../scheduling/readiness.ts";
import { WorktreePoolService } from "../scheduling/worktree-pool.ts";
import { SopService } from "../sop/service.ts";
import { flag, numberOption, option, options, type ParsedArgs, requireOption } from "./args.ts";
import { type CliContext, requireOperator } from "./context.ts";
import { writeJson, writeLine, writeTable } from "./output.ts";

const MESSAGE_KINDS = new Set<MessageKind>([
	"chat",
	"question",
	"answer",
	"proposal",
	"finding",
	"status",
	"handoff",
	"verdict",
	"approval_request",
	"agent_response",
	"backlog_kickoff",
	"approval_pointer",
]);
const PHASES = new Set<ThreadPhase>(["coding", "research", "brainstorm"]);

export async function runThreadCommand(args: ParsedArgs, context: CliContext): Promise<number> {
	const subcommand = args.positionals[0];
	if (subcommand === "list") return listThreads(args, context);
	if (subcommand === "show") return showThread(args, context);
	if (subcommand === "post") return postThread(args, context);
	if (subcommand === "tail") return tailThread(args, context);
	throw new ControlError("invalid_input", "usage: codeteam thread <list|show|post|tail>");
}

function listThreads(args: ParsedArgs, context: CliContext): number {
	const phase = option(args, "phase") as ThreadPhase | undefined;
	if (phase && !PHASES.has(phase)) throw new ControlError("invalid_input", `unknown thread phase ${phase}`);
	const threads = context.store.threads.list({
		status: option(args, "status") as "active" | "archived" | undefined,
		phase,
		backlogItemId: option(args, "backlog"),
	});
	if (context.json) {
		writeJson(threads);
		return 0;
	}
	writeTable(threads, [
		{ header: "id", value: (thread) => thread.id },
		{ header: "status", value: (thread) => thread.status },
		{ header: "phase", value: (thread) => thread.phase ?? "-" },
		{ header: "backlog", value: (thread) => thread.backlogItemId ?? "-" },
		{ header: "title", value: (thread) => thread.title ?? "-" },
	]);
	return 0;
}

function showThread(args: ParsedArgs, context: CliContext): number {
	const id = args.positionals[1];
	if (!id) throw new ControlError("invalid_input", "usage: codeteam thread show <threadId>");
	const thread = context.store.threads.get(id);
	if (!thread) throw new ControlError("not_found", `thread ${id} not found`);
	const messages = context.store.messages.listThread(id, { limit: numberOption(args, "messages") ?? 50 });
	const backlog = thread.backlogItemId ? context.store.backlog.getView(thread.backlogItemId) : null;
	const sop = thread.backlogItemId ? new SopService(context.store).view(thread.backlogItemId) : null;
	const tasks = context.store.tasks.list({ threadId: id });
	if (context.json) {
		writeJson({ thread, backlog, sop, tasks, messages });
		return 0;
	}
	writeLine(`${thread.id}  ${thread.status}  phase=${thread.phase ?? "-"}  backlog=${thread.backlogItemId ?? "-"}`);
	if (thread.title) writeLine(`title: ${thread.title}`);
	if (sop) writeLine(`sop: stage=${sop.sop.stage} baton=${sop.sop.batonHolder} version=${sop.sop.version}`);
	if (tasks.length > 0) writeLine(`tasks: ${tasks.map((task) => `${task.id}:${task.status}`).join(", ")}`);
	for (const message of messages) writeMessage(message, false);
	return 0;
}

function postThread(args: ParsedArgs, context: CliContext): number {
	const operator = requireOperator(context);
	const id = args.positionals[1];
	if (!id) throw new ControlError("invalid_input", "usage: codeteam thread post <threadId> <body> [--to <profile>]");
	const body = args.positionals[2] ?? option(args, "body");
	if (body === undefined || body.trim() === "") throw new ControlError("invalid_input", "message body is required");
	const kind = (option(args, "kind") ?? "chat") as MessageKind;
	if (!MESSAGE_KINDS.has(kind)) throw new ControlError("invalid_input", `unknown message kind ${kind}`);
	const targets = options(args, "to");
	const message = context.store.messages.append({
		threadId: id,
		authorKind: "user",
		authorId: operator.id,
		kind,
		bodyMd: body,
	});
	let queue = null;
	if (targets.length > 0) {
		queue = context.store.queue.admit({
			threadId: id,
			sourceId: message.id,
			sourceKind: "conversation_input",
			targets,
			authorIntent: Object.fromEntries(targets.map((target) => [target, "next_work"])),
			sourceCategory: "operator_chat",
			orderKey: String(message.seq),
		});
	}
	const directed = resolveLineMentions(context, body);
	const task = context.store.tasks.list({ threadId: id }).find((candidate) => candidate.status !== "done") ?? null;
	const inboxItems = [];
	if (directed.length > 0 && task) {
		inboxItems.push(
			context.store.inbox.create({
				taskId: task.id,
				kind: "humanGuidance",
				payload: { messageId: message.id, targets: directed, body },
			}),
		);
	}
	if (context.json) writeJson({ message, queue, inbox: inboxItems });
	else {
		writeLine(`posted ${message.id} seq=${message.seq} thread=${id}`);
		if (queue) writeLine(`queue=${queue.id} targets=${queue.targets.join(",")}`);
		for (const item of inboxItems) writeLine(`inbox=${item.id} task=${item.taskId} targets=${directed.join(",")}`);
	}
	return 0;
}

function resolveLineMentions(context: CliContext, body: string): string[] {
	const profiles = context.store.profiles.list({ status: "active" });
	const resolved = new Set<string>();
	for (const line of body.split(/\r?\n/)) {
		const match = /^@([A-Za-z0-9._:-]+)/.exec(line.trimStart());
		if (!match) continue;
		const handle = match[1]!;
		const id = handle.startsWith("profile:") ? handle : `profile:${handle}`;
		const byId = profiles.find((profile) => profile.id === handle || profile.id === id);
		if (byId) {
			resolved.add(byId.id);
			continue;
		}
		const byName = profiles.filter((profile) => profile.displayName.toLowerCase() === handle.toLowerCase());
		if (byName.length === 1) resolved.add(byName[0]!.id);
	}
	return [...resolved];
}

async function tailThread(args: ParsedArgs, context: CliContext): Promise<number> {
	const id = args.positionals[1];
	if (!id)
		throw new ControlError("invalid_input", "usage: codeteam thread tail <threadId> [--after-seq N] [--follow]");
	if (!context.store.threads.get(id)) throw new ControlError("not_found", `thread ${id} not found`);
	const follow = flag(args, "follow");
	const intervalMs = Math.max(numberOption(args, "interval-ms") ?? 500, 50);
	const timeoutMs = numberOption(args, "timeout-ms");
	const deadline = timeoutMs === undefined ? null : Date.now() + timeoutMs;
	let lastSeq = numberOption(args, "after-seq") ?? 0;
	let stopped = false;
	const stop = (): void => {
		stopped = true;
	};
	process.once("SIGINT", stop);
	try {
		while (!stopped) {
			const messages = context.store.messages.listThread(id, { afterSeq: lastSeq, limit: 500 });
			for (const message of messages) {
				writeMessage(message, context.json);
				lastSeq = Math.max(lastSeq, message.seq);
			}
			if (!follow) break;
			if (deadline !== null && Date.now() >= deadline) break;
			await sleep(intervalMs);
		}
	} finally {
		process.off("SIGINT", stop);
	}
	return 0;
}

function writeMessage(message: Message, json: boolean): void {
	if (json) {
		writeJson(message);
		return;
	}
	writeLine(`#${message.seq} ${message.authorKind}:${message.authorId} [${message.kind}] ${message.bodyMd}`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function runTaskCommand(args: ParsedArgs, context: CliContext): number {
	const subcommand = args.positionals[0];
	if (subcommand === "create") {
		const operator = requireOperator(context);
		const task = context.store.transaction.run(() => {
			const created = context.store.tasks.create({
				kind: "work",
				threadId: requireOption(args, "thread"),
				title: requireOption(args, "title"),
				why: requireOption(args, "why"),
				ownerProfileId: option(args, "owner") ?? null,
				createdBy: operator.id,
				userId: option(args, "user") ?? operator.id,
				backlogItemId: requireOption(args, "backlog"),
			});
			const tokensLimit = budgetNumber(args, "budget-tokens");
			const costLimit = budgetNumber(args, "budget-cost");
			const wallTimeLimitMs = budgetNumber(args, "budget-wall-time-ms");
			if (tokensLimit !== undefined || costLimit !== undefined || wallTimeLimitMs !== undefined) {
				new BudgetService(context.store).setLimits({
					taskId: created.id,
					tokensLimit: tokensLimit ?? null,
					costLimit: costLimit ?? null,
					wallTimeLimitMs: wallTimeLimitMs ?? null,
					actorRef: `user:${operator.id}`,
				});
			}
			return created;
		});
		if (context.json) writeJson(task);
		else writeLine(`created task ${task.id} thread=${task.threadId} backlog=${task.backlogItemId}`);
		return 0;
	}
	if (subcommand === "readiness") {
		const taskId = args.positionals[1];
		if (!taskId) throw new ControlError("invalid_input", "usage: codeteam task readiness <taskId>");
		const service = new TaskReadinessService(context.store, {
			worktree: new WorktreePoolService(context.store, { rootDir: join(context.dataDir, "worktrees") }),
		});
		const decision = service.evaluateTask(taskId, { role: option(args, "role") });
		if (context.json) writeJson(decision);
		else {
			writeLine(`${decision.id} ready=${decision.ready} role=${decision.role} priority=${decision.priority}`);
			for (const reason of decision.reasons) writeLine(`  ${reason.code}: ${reason.message}`);
		}
		return decision.ready ? 0 : 3;
	}
	if (subcommand === "list") {
		const tasks = context.store.tasks.list({ threadId: option(args, "thread") });
		if (context.json) writeJson(tasks);
		else {
			writeTable(tasks, [
				{ header: "id", value: (task) => task.id },
				{ header: "status", value: (task) => task.status },
				{ header: "owner", value: (task) => task.ownerProfileId ?? "-" },
				{ header: "title", value: (task) => task.title },
			]);
		}
		return 0;
	}
	if (subcommand === "status") {
		const taskId = args.positionals[1];
		if (!taskId) throw new ControlError("invalid_input", "usage: codeteam task status <taskId> --status <status>");
		const status = requireOption(args, "status") as "todo" | "doing" | "blocked" | "done";
		if (!["todo", "doing", "blocked", "done"].includes(status)) {
			throw new ControlError("invalid_input", "unknown task status");
		}
		const task = context.store.tasks.setStatus(taskId, status);
		if (context.json) writeJson(task);
		else writeLine(`updated task ${task.id} status=${task.status}`);
		return 0;
	}
	throw new ControlError("invalid_input", "usage: codeteam task <create|list|status|readiness>");
}

function budgetNumber(args: ParsedArgs, name: string): number | undefined {
	const raw = option(args, name);
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) {
		throw new ControlError("invalid_input", `--${name} must be a non-negative number`);
	}
	return value;
}
