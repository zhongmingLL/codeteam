import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { StoredMessage } from "@superagentteam/shared/types";
import { ControlError } from "../control/errors.ts";
import { OperatorMessageIngress } from "../domains/a2a/router.ts";
import type { AgentRegistry } from "../domains/agent/registry.ts";
import { loadRegistryFromFiles } from "../domains/agent/registry.ts";
import { MessageStore } from "../domains/message/store.ts";
import { QueueLedgerStore } from "../domains/queue/store.ts";
import { ThreadStore } from "../domains/thread/store.ts";
import { F018Database } from "../infrastructure/db/database.ts";
import { flag, numberOption, option, options, type ParsedArgs } from "./args.ts";
import { requireOperator } from "./context.ts";
import { writeJson, writeLine, writeTable } from "./output.ts";

// F018 R5-c: the `thread` CLI now speaks the v1 A2A stores. Legacy task/profile
// commands stay on control.db (frozen code delivery), but thread create/list/
// show/post/tail use f018.db + OperatorMessageIngress.

export interface A2ACliContext {
	readonly dataDir: string;
	readonly json: boolean;
}

interface Stores {
	database: F018Database;
	threads: ThreadStore;
	messages: MessageStore;
	queue: QueueLedgerStore;
}

export async function runA2AThreadCommand(args: ParsedArgs, context: A2ACliContext): Promise<number> {
	for (const legacyOption of ["backlog", "task", "kind"]) {
		if (option(args, legacyOption) !== undefined) {
			throw new ControlError(
				"invalid_input",
				`--${legacyOption} is a legacy task-first option; pass --engine legacy to use it`,
			);
		}
	}
	const subcommand = args.positionals[0];
	if (subcommand === "create") return createThread(args, context);
	if (subcommand === "list") return listThreads(args, context);
	if (subcommand === "show") return showThread(args, context);
	if (subcommand === "post") return postThread(args, context);
	if (subcommand === "tail") return await tailThread(args, context);
	throw new ControlError("invalid_input", "usage: superagentteam thread <create|list|show|post|tail>");
}

function withStores<T>(dataDir: string, fn: (stores: Stores) => T): T {
	const database = new F018Database({ path: join(dataDir, "f018.db") });
	try {
		return fn({
			database,
			threads: new ThreadStore(database.db),
			messages: new MessageStore(database.db),
			queue: new QueueLedgerStore(database.db),
		});
	} finally {
		database.close();
	}
}

function loadRegistry(dataDir: string): AgentRegistry {
	try {
		return loadRegistryFromFiles({
			catalogPath: join(dataDir, "agent-catalog.json"),
			accountsPath: join(dataDir, "accounts.json"),
		});
	} catch (error) {
		throw new ControlError(
			"invalid_state",
			`A2A registry unavailable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function createThread(args: ParsedArgs, context: A2ACliContext): number {
	const operator = requireOperator(context);
	const projectPath = option(args, "project-path") ?? option(args, "project");
	if (!projectPath || projectPath.trim() === "") {
		throw new ControlError("invalid_input", "--project-path is required for thread create");
	}
	const id = option(args, "id") ?? `thread:${randomUUID()}`;
	const title = option(args, "title") ?? null;
	const thread = withStores(context.dataDir, ({ threads }) =>
		threads.create({ id, projectPath, title, createdBy: operator.id, now: Date.now() }),
	);
	if (context.json) writeJson(thread);
	else writeLine(`created thread ${thread.id} project=${thread.projectPath}`);
	return 0;
}

function listThreads(args: ParsedArgs, context: A2ACliContext): number {
	const operator = requireOperator(context);
	const limit = numberOption(args, "limit") ?? 50;
	const threads = withStores(context.dataDir, ({ threads: store }) => store.list({ createdBy: operator.id, limit }));
	if (context.json) {
		writeJson(threads);
		return 0;
	}
	writeTable(threads, [
		{ header: "id", value: (thread) => thread.id },
		{ header: "project", value: (thread) => thread.projectPath },
		{ header: "title", value: (thread) => thread.title ?? "-" },
		{ header: "participants", value: (thread) => thread.participants.join(",") || "-" },
		{ header: "lastActive", value: (thread) => String(thread.lastActiveAt) },
	]);
	return 0;
}

function showThread(args: ParsedArgs, context: A2ACliContext): number {
	const operator = requireOperator(context);
	const id = args.positionals[1];
	if (!id) throw new ControlError("invalid_input", "usage: superagentteam thread show <threadId>");
	const result = withStores(context.dataDir, ({ threads, messages }) => {
		const thread = threads.get(id);
		if (!thread) throw new ControlError("not_found", `thread ${id} not found`);
		if (thread.createdBy !== operator.id) throw new ControlError("forbidden", `thread ${id} belongs to another user`);
		return { thread, messages: messages.getByThread(id, numberOption(args, "messages") ?? 50) };
	});
	if (context.json) {
		writeJson(result);
		return 0;
	}
	writeLine(`${result.thread.id} project=${result.thread.projectPath} title=${result.thread.title ?? "-"}`);
	for (const message of result.messages) writeMessage(message, false);
	return 0;
}

function postThread(args: ParsedArgs, context: A2ACliContext): number {
	const operator = requireOperator(context);
	const id = args.positionals[1];
	if (!id) {
		throw new ControlError(
			"invalid_input",
			"usage: superagentteam thread post <threadId> <body> [--to <agentId> ...] [--id <messageId>]",
		);
	}
	const body = args.positionals[2] ?? option(args, "body");
	if (body === undefined || body.trim() === "") throw new ControlError("invalid_input", "message body is required");
	const targets = options(args, "to");
	const registry = loadRegistry(context.dataDir);
	const posted = withStores(context.dataDir, ({ database, threads, messages, queue }) => {
		const thread = threads.get(id);
		if (!thread) throw new ControlError("not_found", `thread ${id} not found`);
		if (thread.createdBy !== operator.id) throw new ControlError("forbidden", `thread ${id} belongs to another user`);
		const ingress = new OperatorMessageIngress({ db: database.db, registry, threads, messages, queue });
		return ingress.submit({
			threadId: id,
			userId: operator.id,
			body,
			messageId: option(args, "id"),
			targetAgentIds: targets.length > 0 ? targets : undefined,
			now: Date.now(),
		});
	});
	if (context.json) writeJson(posted);
	else {
		writeLine(`posted ${posted.message.id} seq=${posted.message.seq} thread=${id}`);
		writeLine(`queue=${posted.queueEntry.queueEntryId} targets=${posted.targetAgentIds.join(",")}`);
	}
	return 0;
}

async function tailThread(args: ParsedArgs, context: A2ACliContext): Promise<number> {
	const operator = requireOperator(context);
	const id = args.positionals[1];
	if (!id) throw new ControlError("invalid_input", "usage: superagentteam thread tail <threadId> [--after-seq N]");
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
			const messages = withStores(context.dataDir, ({ threads, messages: store }) => {
				const thread = threads.get(id);
				if (!thread) throw new ControlError("not_found", `thread ${id} not found`);
				if (thread.createdBy !== operator.id) {
					throw new ControlError("forbidden", `thread ${id} belongs to another user`);
				}
				return store.getByThreadAfter(id, lastSeq, 500);
			});
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

function writeMessage(message: StoredMessage, json: boolean): void {
	if (json) {
		writeJson(message);
		return;
	}
	const author =
		message.from.kind === "user"
			? `user:${message.from.userId}`
			: message.from.kind === "agent"
				? `agent:${message.from.agentId}`
				: `system:${message.from.service}`;
	writeLine(`#${message.seq} ${author} ${message.content}`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
