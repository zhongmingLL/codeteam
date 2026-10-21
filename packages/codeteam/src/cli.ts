#!/usr/bin/env node
import { runPhase3Demo } from "./dev/phase3-demo.ts";

const command = process.argv[2];

if (command === "phase3-demo") {
	await runPhase3Demo();
} else {
	console.log("usage: codeteam phase3-demo");
	process.exitCode = 1;
}
