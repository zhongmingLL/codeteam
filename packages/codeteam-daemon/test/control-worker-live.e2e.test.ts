import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createW5BFixture, type W5BFixture } from "./helpers/w5b-fixture.ts";

const liveEnabled = process.env.CODETEAM_LIVE_PROVIDER === "1" && Boolean(process.env.OPENROUTER_API_KEY);
const liveModel = process.env.CODETEAM_LIVE_MODEL ?? "~deepseek/deepseek-flash-latest";
const REAL_CLI_PATH = join(import.meta.dirname, "..", "..", "coding-agent", "dist", "cli.js");

let fixture: W5BFixture | null = null;

afterEach(async () => {
	await fixture?.cleanup();
	fixture = null;
});

describe.skipIf(!liveEnabled)("W5b live provider smoke", () => {
	it("gets a real OpenRouter reply through a pi RPC worker", async () => {
		fixture = createW5BFixture({
			cliPath: REAL_CLI_PATH,
			sessionProvider: "openrouter",
			sessionModelForRole: { coder: liveModel },
			offline: true,
		});
		await fixture.runtime.start();
		const source = fixture.createSource("Reply with exactly LIVE_W5B_OK and nothing else.");
		fixture.enqueue({ sourceId: source.id });
		const drain = await fixture.dispatch.drain({ maxEntries: 1 });
		expect(drain.outcomes[0]?.status).toBe("completed");
		const run = fixture.store.runs.get(drain.runs[0]!.id)!;
		expect(fixture.store.messages.get(run.responseMessageId!)!.bodyMd).toContain("LIVE_W5B_OK");
	}, 120_000);
});
