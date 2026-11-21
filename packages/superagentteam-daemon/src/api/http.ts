import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = "HttpError";
		this.status = status;
		this.code = code;
	}
}

export function sendJson(
	response: ServerResponse,
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
): void {
	const payload = JSON.stringify(body);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		...headers,
	});
	response.end(payload);
}

export function sendError(response: ServerResponse, status: number, code: string, message: string): void {
	sendJson(response, status, { error: code, message });
}

export async function readJsonBody(request: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > maxBytes) throw new HttpError(413, "payload_too_large", "request body is too large");
		chunks.push(buffer);
	}
	if (chunks.length === 0) return undefined;
	const text = Buffer.concat(chunks).toString("utf8").trim();
	if (text === "") return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new HttpError(400, "invalid_input", "request body must be valid JSON");
	}
}
