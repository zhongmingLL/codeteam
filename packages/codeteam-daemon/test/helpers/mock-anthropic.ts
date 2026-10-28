import { createServer, type Server } from "node:http";

export interface MockAnthropicRequest {
	readonly model: string;
	readonly body: Record<string, unknown>;
}

export interface MockAnthropicServer {
	readonly baseUrl: string;
	readonly requests: MockAnthropicRequest[];
	close(): Promise<void>;
}

export async function startMockAnthropic(
	respond: (request: MockAnthropicRequest) => string,
): Promise<MockAnthropicServer> {
	const requests: MockAnthropicRequest[] = [];
	const server: Server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(body) as Record<string, unknown>;
			} catch {
				parsed = {};
			}
			const model = typeof parsed.model === "string" ? parsed.model : "unknown";
			const entry = { model, body: parsed };
			requests.push(entry);
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(respond(entry));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (typeof address !== "object" || address === null) throw new Error("mock provider did not bind");
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		requests,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

export function sse(events: Array<{ event: string; data: unknown }>): string {
	return events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

export function textResponse(text: string): string {
	return sse([
		{
			event: "message_start",
			data: {
				type: "message_start",
				message: {
					id: `msg-${Date.now()}`,
					type: "message",
					role: "assistant",
					model: "mock",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 10, output_tokens: 1 },
				},
			},
		},
		{
			event: "content_block_start",
			data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		},
		{
			event: "content_block_delta",
			data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		},
		{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
		{
			event: "message_delta",
			data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
		},
		{ event: "message_stop", data: { type: "message_stop" } },
	]);
}

export function toolCallResponse(toolName: string, input: Record<string, unknown>): string {
	return sse([
		{
			event: "message_start",
			data: {
				type: "message_start",
				message: {
					id: `msg-${Date.now()}`,
					type: "message",
					role: "assistant",
					model: "mock",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 10, output_tokens: 1 },
				},
			},
		},
		{
			event: "content_block_start",
			data: {
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: `tool-${Date.now()}`, name: toolName, input: {} },
			},
		},
		{
			event: "content_block_delta",
			data: {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
			},
		},
		{ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
		{
			event: "message_delta",
			data: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
		},
		{ event: "message_stop", data: { type: "message_stop" } },
	]);
}

export function lastMessageHasToolResult(body: Record<string, unknown>): boolean {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const last = messages.at(-1) as { content?: unknown } | undefined;
	if (!last || !Array.isArray(last.content)) return false;
	return last.content.some(
		(part) => part && typeof part === "object" && (part as { type?: unknown }).type === "tool_result",
	);
}
