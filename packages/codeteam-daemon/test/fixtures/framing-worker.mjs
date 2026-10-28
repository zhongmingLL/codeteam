#!/usr/bin/env node
import { createInterface } from "node:readline";

const mode = process.env.FRAMING_MODE ?? "split";
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
	if (line.trim() === "") return;
	const command = JSON.parse(line);
	if (mode === "invalid") {
		process.stdout.write("not json\n");
		return;
	}
	if (mode === "oversize") {
		process.stdout.write(`${"x".repeat(Number(process.env.FRAMING_BYTES ?? 4096))}\n`);
		return;
	}
	const payload = `${JSON.stringify({
		id: command.id,
		type: "response",
		command: "get_state",
		success: true,
		data: { sessionId: "split", text: "a\u2028b" },
	})}\n`;
	process.stdout.write(payload.slice(0, 10));
	setTimeout(() => process.stdout.write(payload.slice(10, 25)), 5);
	setTimeout(() => process.stdout.write(payload.slice(25)), 10);
});
setInterval(() => {}, 1_000);
