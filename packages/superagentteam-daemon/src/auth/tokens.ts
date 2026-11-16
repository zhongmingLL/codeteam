import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { ControlError } from "../control/errors.ts";

export const INVOCATION_TOKEN_PREFIX = "ct1";

const SECRET_BYTES = 32;
const SALT_BYTES = 16;
const SAFE_RUN_ID = /^[A-Za-z0-9._:-]+$/;

export interface InvocationTokenMaterial {
	readonly secret: string;
	readonly salt: string;
}

export function createInvocationTokenMaterial(): InvocationTokenMaterial {
	return {
		secret: randomBytes(SECRET_BYTES).toString("base64url"),
		salt: randomBytes(SALT_BYTES).toString("hex"),
	};
}

export function hashInvocationSecret(salt: string, secret: string): string {
	return createHash("sha256").update(`${salt}:${secret}`).digest("hex");
}

export function formatInvocationToken(credentialId: string, secret: string): string {
	return `${INVOCATION_TOKEN_PREFIX}.${credentialId}.${secret}`;
}

export function parseInvocationToken(token: string): { credentialId: string; secret: string } {
	const parts = token.trim().split(".");
	if (parts.length !== 3 || parts[0] !== INVOCATION_TOKEN_PREFIX) {
		throw new ControlError("invalid_token", "malformed invocation token");
	}
	const credentialId = parts[1];
	const secret = parts[2];
	if (!credentialId || !secret) throw new ControlError("invalid_token", "malformed invocation token");
	return { credentialId, secret };
}

export function resolveInvocationTokenDir(dataDir: string): string {
	return join(dataDir, "tokens");
}

export interface WriteInvocationTokenFileOptions {
	readonly dir: string;
	readonly runId: string;
	readonly token: string;
}

export function writeInvocationTokenFile(options: WriteInvocationTokenFileOptions): string {
	if (!SAFE_RUN_ID.test(options.runId) || options.runId.includes("..")) {
		throw new ControlError("invalid_input", "runId is not a safe token file name");
	}
	mkdirSync(options.dir, { recursive: true, mode: 0o700 });
	chmodSync(options.dir, 0o700);
	const path = join(options.dir, `${options.runId}.token`);
	const temp = `${path}.tmp`;
	const fd = openSync(temp, "w", 0o600);
	try {
		writeSync(fd, options.token);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	chmodSync(temp, 0o600);
	renameSync(temp, path);
	chmodSync(path, 0o600);
	return path;
}

export function writeSecretFile(path: string, content: string): string {
	const temp = `${path}.tmp`;
	const fd = openSync(temp, "w", 0o600);
	try {
		writeSync(fd, content);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	chmodSync(temp, 0o600);
	renameSync(temp, path);
	chmodSync(path, 0o600);
	return path;
}
