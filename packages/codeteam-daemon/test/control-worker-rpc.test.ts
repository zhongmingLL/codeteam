import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RpcConnection, RpcProtocolError } from "../src/workers/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "framing-worker.mjs");

function connection(mode: string, maxFrameBytes = 1024): RpcConnection {
	return new RpcConnection({
		cliPath: fixture,
		cwd: here,
		env: { ...process.env, FRAMING_MODE: mode, FRAMING_BYTES: "4096" },
		maxFrameBytes,
	});
}

describe("W5b strict RPC JSONL framing", () => {
	it("reassembles split UTF-8 frames without splitting on U+2028", async () => {
		const client = connection("split");
		await client.start();
		try {
			const state = await client.getState();
			expect(state).toMatchObject({ sessionId: "split", text: "a\u2028b" });
		} finally {
			await client.finish();
		}
	});

	it("fails closed on invalid JSON stdout", async () => {
		const client = connection("invalid");
		await client.start();
		try {
			await expect(client.getState()).rejects.toBeInstanceOf(RpcProtocolError);
		} finally {
			await client.finish();
		}
	});

	it("fails closed when a frame exceeds the configured maximum", async () => {
		const client = connection("oversize", 128);
		await client.start();
		try {
			await expect(client.getState()).rejects.toBeInstanceOf(RpcProtocolError);
		} finally {
			await client.finish();
		}
	});

	it("fails closed when an unterminated frame exceeds the configured maximum", async () => {
		const client = connection("partial-oversize", 128);
		await client.start();
		try {
			await expect(client.getState()).rejects.toBeInstanceOf(RpcProtocolError);
		} finally {
			await client.finish();
		}
	});
});
