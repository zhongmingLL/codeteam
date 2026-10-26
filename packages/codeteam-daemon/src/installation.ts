import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { DaemonError } from "./errors.ts";

export interface InstallationIdentity {
	realRoot: string;
	installationId: string;
}

export function resolveInstallation(root: string): InstallationIdentity {
	let realRoot: string;
	try {
		realRoot = realpathSync(root);
	} catch {
		throw new DaemonError("invalid_installation_root", `installation root does not exist: ${root}`);
	}
	if (!statSync(realRoot).isDirectory()) {
		throw new DaemonError("invalid_installation_root", `installation root is not a directory: ${root}`);
	}
	const installationId = createHash("sha256").update(`codeteam.installation.v1\0${realRoot}`).digest("hex");
	return { realRoot, installationId };
}
