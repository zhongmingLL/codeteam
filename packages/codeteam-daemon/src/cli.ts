#!/usr/bin/env node
import { runCli } from "./cli/index.ts";
import { ControlError } from "./control/errors.ts";
import { MemoryError } from "./memory/errors.ts";

async function main(): Promise<number> {
	try {
		return await runCli(process.argv.slice(2));
	} catch (error) {
		if (error instanceof ControlError || error instanceof MemoryError) {
			process.stderr.write(`${JSON.stringify({ error: { code: error.code, message: error.message } })}\n`);
		} else {
			process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
		}
		return 1;
	}
}

process.exitCode = await main();
