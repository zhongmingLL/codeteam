import type { KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadOperatorPrivateKey, operatorCredentialPaths, signOperatorPayload } from "../auth/operator.ts";
import { principalFromOperatorProof } from "../auth/principals.ts";
import { resolveControlDataDir } from "../control/database.ts";
import { ControlError } from "../control/errors.ts";
import { type ControlStore, openControlStore } from "../control/store.ts";
import { flag, option, type ParsedArgs } from "./args.ts";

export interface CliContext {
	readonly dataDir: string;
	readonly store: ControlStore;
	readonly json: boolean;
}

export interface OperatorContext {
	readonly id: string;
	readonly privateKey: KeyObject;
	readonly publicKeyPem: string;
}

export function openCliContext(args: ParsedArgs): CliContext {
	const dataDir = resolveControlDataDir(option(args, "data-dir"));
	return { dataDir, store: openControlStore({ dataDir }), json: flag(args, "json") };
}

export function requireOperator(context: CliContext): OperatorContext {
	const paths = operatorCredentialPaths(context.dataDir);
	const privateKey = loadOperatorPrivateKey(context.dataDir);
	const publicKeyPem = readFileSync(paths.publicKeyPath, "utf8");
	const payload = `codeteam-cli:${process.pid}:${Date.now()}`;
	const signature = signOperatorPayload(privateKey, payload);
	const principal = principalFromOperatorProof({ publicKeyPem, payload, signature });
	if (principal.kind !== "operator") {
		throw new ControlError("forbidden", "operator credential did not resolve to an operator principal");
	}
	return { id: principal.id, privateKey, publicKeyPem };
}
