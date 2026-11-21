import { randomUUID } from "node:crypto";

import {
	loadOperatorPrivateKey,
	loadOperatorPublicKey,
	operatorCredentialPaths,
	signOperatorPayload,
	verifyOperatorSignature,
} from "../auth/operator.ts";
import { ControlError } from "../control/errors.ts";

const TOKEN_PREFIX = "v1";
const TOKEN_VERSION = 1;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

export interface ConsoleTokenPayload {
	v: 1;
	sub: string;
	aud: "daemon";
	iat: number;
	exp: number;
	nonce: string;
}

export interface CreateConsoleTokenOptions {
	dataDir: string;
	ttlMs?: number;
	now?: number;
	nonce?: string;
}

export interface CreatedConsoleToken {
	token: string;
	payload: ConsoleTokenPayload;
}

export interface VerifyConsoleTokenOptions {
	dataDir: string;
	token: string;
	now?: number;
}

function encode(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string {
	return Buffer.from(value, "base64url").toString("utf8");
}

export function createConsoleToken(options: CreateConsoleTokenOptions): CreatedConsoleToken {
	const now = options.now ?? Date.now();
	const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
	if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
		throw new ControlError("invalid_input", "console token ttl must be a positive number");
	}
	const paths = operatorCredentialPaths(options.dataDir);
	const payload: ConsoleTokenPayload = {
		v: TOKEN_VERSION,
		sub: `operator:${paths.fingerprint}`,
		aud: "daemon",
		iat: now,
		exp: now + ttlMs,
		nonce: options.nonce ?? randomUUID(),
	};
	const payloadB64 = encode(JSON.stringify(payload));
	const signingInput = `${TOKEN_PREFIX}.${payloadB64}`;
	const signature = signOperatorPayload(loadOperatorPrivateKey(options.dataDir), signingInput);
	return { token: `${signingInput}.${signature}`, payload };
}

export function verifyConsoleToken(options: VerifyConsoleTokenOptions): ConsoleTokenPayload {
	const now = options.now ?? Date.now();
	const parts = options.token.split(".");
	if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
		throw new ControlError("forbidden", "invalid console token");
	}
	const payloadB64 = parts[1]!;
	const signature = parts[2]!;
	let payload: ConsoleTokenPayload;
	try {
		payload = JSON.parse(decode(payloadB64)) as ConsoleTokenPayload;
	} catch {
		throw new ControlError("forbidden", "invalid console token payload");
	}
	const paths = operatorCredentialPaths(options.dataDir);
	const signingInput = `${TOKEN_PREFIX}.${payloadB64}`;
	if (!verifyOperatorSignature(loadOperatorPublicKey(options.dataDir), signingInput, signature)) {
		throw new ControlError("forbidden", "invalid console token signature");
	}
	if (
		payload.v !== TOKEN_VERSION ||
		payload.aud !== "daemon" ||
		payload.sub !== `operator:${paths.fingerprint}` ||
		typeof payload.nonce !== "string" ||
		payload.nonce.length === 0
	) {
		throw new ControlError("forbidden", "invalid console token claims");
	}
	if (!Number.isFinite(payload.exp) || payload.exp <= now) {
		throw new ControlError("forbidden", "console token expired");
	}
	return payload;
}
