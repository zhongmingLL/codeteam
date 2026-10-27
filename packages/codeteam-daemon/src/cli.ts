#!/usr/bin/env node
import { initOperatorCredential } from "./auth/operator.ts";
import { resolveControlDataDir } from "./control/database.ts";
import { ControlError } from "./control/errors.ts";

function main(argv: readonly string[]): number {
	const [command, subcommand, ...rest] = argv;
	if (command === "auth" && subcommand === "init") {
		const dataDir = option(rest, "--data-dir");
		const rotate = rest.includes("--rotate");
		const resolved = resolveControlDataDir(dataDir);
		const paths = initOperatorCredential({ dataDir: resolved, rotate });
		process.stdout.write(
			`${JSON.stringify({ dataDir: resolved, publicKeyPath: paths.publicKeyPath, fingerprint: paths.fingerprint })}\n`,
		);
		return 0;
	}
	process.stderr.write("usage: codeteam auth init [--data-dir <path>] [--rotate]\n");
	return 2;
}

function option(argv: readonly string[], name: string): string | undefined {
	const prefix = `${name}=`;
	for (const arg of argv) {
		if (arg.startsWith(prefix)) return arg.slice(prefix.length);
	}
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] : undefined;
}

try {
	process.exitCode = main(process.argv.slice(2));
} catch (error) {
	if (error instanceof ControlError) {
		process.stderr.write(`${JSON.stringify({ error: { code: error.code, message: error.message } })}\n`);
	} else {
		process.stderr.write(`${String(error)}\n`);
	}
	process.exitCode = 1;
}
