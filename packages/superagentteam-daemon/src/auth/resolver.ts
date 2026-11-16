import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import type { OwnerAuthProvenance } from "../control/stores/types.ts";
import { parseInvocationToken } from "./tokens.ts";

export interface InvocationBinding {
	readonly credentialId: string;
	readonly runId: string;
	readonly taskId: string;
	readonly role: string;
	readonly agentSessionId: string;
	readonly agentProfileId: string;
	readonly threadId: string;
	readonly userId: string;
	readonly ownerAuthProvenance: OwnerAuthProvenance;
	readonly callbackAllowlist: readonly string[];
}

export interface ResolveInvocationOptions {
	readonly now?: number;
}

export function resolveInvocationToken(
	store: ControlStore,
	token: string,
	options: ResolveInvocationOptions = {},
): InvocationBinding {
	const { credentialId, secret } = parseInvocationToken(token);
	const credential = store.credentials.get(credentialId);
	if (!credential || !store.credentials.verifyTokenSecret(credentialId, secret)) {
		throw new ControlError("invalid_token", "invalid invocation token");
	}
	if (credential.state !== "active") {
		throw new ControlError("invalid_token", "invocation credential is terminal");
	}
	const now = options.now ?? Date.now();
	if (credential.expiresAt !== null && credential.expiresAt <= now) {
		throw new ControlError("invalid_token", "invocation credential expired");
	}
	return {
		credentialId: credential.id,
		runId: credential.runId,
		taskId: credential.taskId,
		role: credential.role,
		agentSessionId: credential.agentSessionId,
		agentProfileId: credential.agentProfileId,
		threadId: credential.threadId,
		userId: credential.userId,
		ownerAuthProvenance: credential.ownerAuthProvenance,
		callbackAllowlist: credential.callbackAllowlist ?? [],
	};
}
