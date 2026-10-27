import { ControlError } from "../control/errors.ts";
import type { ControlStore } from "../control/store.ts";
import { newId } from "../control/stores/helpers.ts";
import type { InvocationCredential, OwnerAuthProvenance } from "../control/stores/types.ts";
import {
	createInvocationTokenMaterial,
	formatInvocationToken,
	hashInvocationSecret,
	writeInvocationTokenFile,
} from "./tokens.ts";

export interface MintInvocationCredentialInput {
	readonly runId: string;
	readonly ownerAuthProvenance?: OwnerAuthProvenance;
	readonly callbackAllowlist?: readonly string[];
	readonly toolPolicy?: Record<string, unknown>;
	readonly expiresAt?: number | null;
	readonly tokenDir?: string | null;
}

export interface MintedInvocationCredential {
	readonly credential: InvocationCredential;
	readonly token: string;
	readonly tokenPath: string | null;
}

interface RunCoordinatesRow {
	task_id: string;
	role: string;
	agent_session_id: string;
	recipient_profile_id: string;
	status: string;
	thread_id: string;
	user_id: string | null;
}

export function mintInvocationCredential(
	store: ControlStore,
	input: MintInvocationCredentialInput,
): MintedInvocationCredential {
	const run = store.database
		.prepare(
			"SELECT r.task_id, r.role, r.agent_session_id, r.recipient_profile_id, r.status, s.thread_id, t.user_id FROM runs r JOIN agent_sessions s ON s.id = r.agent_session_id JOIN tasks t ON t.id = r.task_id WHERE r.id = ?",
		)
		.get(input.runId) as RunCoordinatesRow | undefined;
	if (!run) throw new ControlError("not_found", `run ${input.runId} not found`);
	if (run.status !== "running") throw new ControlError("invalid_state", `run ${input.runId} is not running`);

	const material = createInvocationTokenMaterial();
	const credentialId = newId();
	const credential = store.credentials.create({
		id: credentialId,
		tokenHash: hashInvocationSecret(material.salt, material.secret),
		tokenSalt: material.salt,
		runId: input.runId,
		taskId: run.task_id,
		role: run.role,
		agentSessionId: run.agent_session_id,
		agentProfileId: run.recipient_profile_id,
		threadId: run.thread_id,
		userId: run.user_id ?? "unpaired-user",
		ownerAuthProvenance: input.ownerAuthProvenance ?? "strict",
		toolPolicy: input.toolPolicy ?? {},
		callbackAllowlist: [...(input.callbackAllowlist ?? [])],
		expiresAt: input.expiresAt ?? null,
	});
	const token = formatInvocationToken(credential.id, material.secret);
	const tokenPath = input.tokenDir
		? writeInvocationTokenFile({ dir: input.tokenDir, runId: input.runId, token })
		: null;
	return { credential, token, tokenPath };
}
