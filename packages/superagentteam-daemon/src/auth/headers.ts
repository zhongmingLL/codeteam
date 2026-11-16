import { ControlError } from "../control/errors.ts";

export interface InvocationRequestEnvelope {
	readonly headers: Record<string, string | string[] | undefined>;
	readonly queryToken?: string | null;
	readonly bodyToken?: string | null;
}

export function extractInvocationToken(request: InvocationRequestEnvelope): string {
	if ((request.queryToken ?? "") !== "" || (request.bodyToken ?? "") !== "") {
		throw new ControlError("invalid_token", "invocation token must be supplied via the Authorization header only");
	}
	const header = headerValue(request.headers, "authorization");
	if (!header) throw new ControlError("invalid_token", "missing Authorization header");
	const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
	const token = match?.[1];
	if (!token) throw new ControlError("invalid_token", "Authorization header must use the Bearer scheme");
	return token;
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | null {
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== name) continue;
		if (Array.isArray(value)) return value[0] ?? null;
		return value ?? null;
	}
	return null;
}
