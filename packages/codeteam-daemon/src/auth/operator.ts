import {
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	type KeyObject,
	sign,
	verify,
} from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { ControlError } from "../control/errors.ts";

export interface OperatorCredentialPaths {
	readonly privateKeyPath: string;
	readonly publicKeyPath: string;
	readonly fingerprint: string;
}

export interface InitOperatorCredentialOptions {
	readonly dataDir: string;
	readonly rotate?: boolean;
}

export function resolveOperatorCredentialsDir(dataDir: string): string {
	return join(dataDir, "credentials");
}

export function initOperatorCredential(options: InitOperatorCredentialOptions): OperatorCredentialPaths {
	const dir = resolveOperatorCredentialsDir(options.dataDir);
	const privateKeyPath = join(dir, "operator.key");
	const publicKeyPath = join(dir, "operator.pub");
	if (existsSync(privateKeyPath) && !options.rotate) return operatorCredentialPaths(options.dataDir);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
	const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
	const probe = `codeteam-operator-key-probe:${Date.now()}`;
	if (!verifyOperatorSignature(publicKey, probe, signOperatorPayload(privateKey, probe))) {
		throw new ControlError("invalid_input", "operator keypair self-check failed; refusing to use mismatched keys");
	}
	writeSecretFile(privateKeyPath, privatePem);
	writeSecretFile(publicKeyPath, publicPem);
	return operatorCredentialPaths(options.dataDir);
}

export function operatorCredentialPaths(dataDir: string): OperatorCredentialPaths {
	const dir = resolveOperatorCredentialsDir(dataDir);
	const privateKeyPath = join(dir, "operator.key");
	const publicKeyPath = join(dir, "operator.pub");
	if (!existsSync(privateKeyPath) || !existsSync(publicKeyPath)) {
		throw new ControlError("not_found", "operator credential is not initialized; run `codeteam auth init`");
	}
	return {
		privateKeyPath,
		publicKeyPath,
		fingerprint: fingerprintOfPublicKey(readFileSync(publicKeyPath, "utf8")),
	};
}

export function loadOperatorPrivateKey(dataDir: string): KeyObject {
	const { privateKeyPath } = operatorCredentialPaths(dataDir);
	try {
		return createPrivateKey(readFileSync(privateKeyPath, "utf8"));
	} catch (error) {
		throw new ControlError("invalid_input", "operator private key could not be loaded", { cause: error });
	}
}

export function loadOperatorPublicKey(dataDir: string): KeyObject {
	const { publicKeyPath } = operatorCredentialPaths(dataDir);
	try {
		return createPublicKey(readFileSync(publicKeyPath, "utf8"));
	} catch (error) {
		throw new ControlError("invalid_input", "operator public key could not be loaded", { cause: error });
	}
}

export function fingerprintOfPublicKey(publicPem: string): string {
	const key = createPublicKey(publicPem);
	const der = key.export({ type: "spki", format: "der" });
	return createHash("sha256").update(der).digest("hex").slice(0, 16);
}

export function signOperatorPayload(privateKey: KeyObject, payload: string | Buffer): string {
	return sign(null, Buffer.from(payload), privateKey).toString("base64url");
}

export function verifyOperatorSignature(publicKey: KeyObject, payload: string | Buffer, signature: string): boolean {
	try {
		return verify(null, Buffer.from(payload), publicKey, Buffer.from(signature, "base64url"));
	} catch {
		return false;
	}
}

function writeSecretFile(path: string, content: string): void {
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
}
