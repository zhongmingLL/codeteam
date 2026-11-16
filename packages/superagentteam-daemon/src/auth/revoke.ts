import type { ControlStore } from "../control/store.ts";
import type { CredentialDisposition, InvocationCredential } from "../control/stores/types.ts";

export function revokeCredentialsForRun(
	store: ControlStore,
	runId: string,
	disposition: CredentialDisposition,
): InvocationCredential | null {
	const credential = store.credentials.getByRun(runId);
	if (!credential || credential.state !== "active") return null;
	return store.credentials.terminalize(credential.id, disposition);
}
