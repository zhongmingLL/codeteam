import type { KeyObject } from "node:crypto";
import { ControlError } from "../control/errors.ts";
import { signOperatorPayload, verifyOperatorSignature } from "./operator.ts";

export const MERGE_SERVICE_ACTOR = "service:merge-owner";
export const MAX_MERGE_CREDENTIAL_TTL_MS = 15 * 60 * 1000;

export interface MergeCredentialBinding {
	readonly repo: string;
	readonly prRef: string;
	readonly headSha: string;
}

export interface MergeServiceCredential {
	readonly token: string;
	readonly expiresAt: number;
}

export interface MergeServicePayload extends MergeCredentialBinding {
	readonly v: 1;
	readonly actor: string;
	readonly expiresAt: number;
}

export interface IssueMergeCredentialOptions {
	readonly ttlMs: number;
	readonly now?: number;
}

export function issueMergeServiceCredential(
	privateKey: KeyObject,
	binding: MergeCredentialBinding,
	options: IssueMergeCredentialOptions,
): MergeServiceCredential {
	if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0 || options.ttlMs > MAX_MERGE_CREDENTIAL_TTL_MS) {
		throw new ControlError("invalid_input", "merge credential ttl must be within 1ms..15min");
	}
	const now = options.now ?? Date.now();
	const payload: MergeServicePayload = {
		v: 1,
		actor: MERGE_SERVICE_ACTOR,
		repo: requireField(binding.repo, "repo"),
		prRef: requireField(binding.prRef, "prRef"),
		headSha: requireField(binding.headSha, "headSha"),
		expiresAt: now + options.ttlMs,
	};
	const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
	return { token: `${encoded}.${signOperatorPayload(privateKey, encoded)}`, expiresAt: payload.expiresAt };
}

export function verifyMergeServiceCredential(
	publicKey: KeyObject,
	token: string,
	binding: MergeCredentialBinding,
	options: { now?: number } = {},
): MergeServicePayload {
	const parts = token.split(".");
	const encoded = parts[0];
	const signature = parts[1];
	if (!encoded || !signature || parts.length !== 2) throw forbidden("malformed merge credential");
	if (!verifyOperatorSignature(publicKey, encoded, signature)) throw forbidden("invalid merge credential signature");
	let payload: MergeServicePayload;
	try {
		payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as MergeServicePayload;
	} catch {
		throw forbidden("malformed merge credential payload");
	}
	if (payload.v !== 1 || payload.actor !== MERGE_SERVICE_ACTOR) throw forbidden("merge credential actor mismatch");
	if (payload.repo !== binding.repo || payload.prRef !== binding.prRef || payload.headSha !== binding.headSha) {
		throw forbidden("merge credential binding mismatch");
	}
	const now = options.now ?? Date.now();
	if (payload.expiresAt <= now) throw forbidden("merge credential expired");
	return payload;
}

function requireField(value: string, field: string): string {
	if (!value || value.trim() === "") throw new ControlError("invalid_input", `merge credential ${field} is required`);
	return value;
}

function forbidden(message: string): ControlError {
	return new ControlError("forbidden", message);
}
