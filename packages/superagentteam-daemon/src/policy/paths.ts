import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ControlError } from "../control/errors.ts";
import type { ToolPolicy } from "./types.ts";

const DENIED_BASENAME_PATTERNS: readonly RegExp[] = [/^\.env(\..*)?$/, /\.pem$/i, /^id_rsa/, /^credentials(\..*)?$/i];
const DENIED_SEGMENTS = new Set([".ssh", "credentials", ".git"]);

export function assertReadablePath(policy: ToolPolicy, path: string, cwd = policy.cwd): string {
	const canonical = canonicalize(path, cwd, "read");
	assertInsideRoots(policy.readRoots, canonical, "read");
	assertNotDenied(policy, canonical);
	const stats = lstatSync(canonical);
	if (!stats.isDirectory() && stats.nlink > 1) {
		throw forbidden(`hardlinked file not allowed: ${path}`);
	}
	return canonical;
}

export function assertWritablePath(policy: ToolPolicy, path: string, cwd = policy.cwd): string {
	const canonical = canonicalize(path, cwd, "write");
	assertInsideRoots(policy.writeRoots, canonical, "write");
	assertNotDenied(policy, canonical);
	assertSafeWriteTarget(path, cwd);
	return canonical;
}

export function assertAllowedCwd(policy: ToolPolicy, cwd: string): string {
	let canonical: string;
	try {
		canonical = realpathSync.native(resolve(cwd));
	} catch {
		throw forbidden(`cwd does not exist: ${cwd}`);
	}
	if (!policy.readRoots.some((root) => isInside(root, canonical))) {
		throw forbidden(`cwd outside allowed roots: ${cwd}`);
	}
	return canonical;
}

function assertSafeWriteTarget(input: string, cwd: string): void {
	const absolute = isAbsolute(input) ? input : join(cwd, input);
	try {
		const stats = lstatSync(absolute);
		if (stats.isSymbolicLink()) throw forbidden(`symlink write target not allowed: ${input}`);
		if (!stats.isDirectory() && stats.nlink > 1) throw forbidden(`hardlinked write target not allowed: ${input}`);
	} catch (error) {
		if (error instanceof ControlError) throw error;
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") throw forbidden(`cannot inspect write target: ${input}`);
	}
}

function canonicalize(input: string, cwd: string, mode: "read" | "write"): string {
	if (input.trim() === "") throw forbidden("empty path");
	if (input.split(/[\\/]+/).includes("..")) throw forbidden(`path traversal not allowed: ${input}`);
	const absolute = isAbsolute(input) ? input : join(cwd, input);
	try {
		return realpathSync.native(absolute);
	} catch {
		if (mode !== "write") throw forbidden(`path does not exist: ${input}`);
		const parent = realpathSync.native(dirname(absolute));
		return join(parent, basename(absolute));
	}
}

function assertInsideRoots(roots: readonly string[], path: string, mode: "read" | "write"): void {
	if (roots.some((root) => isInside(root, path))) return;
	throw forbidden(`${mode} path outside allowed roots: ${path}`);
}

function isInside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertNotDenied(policy: ToolPolicy, canonical: string): void {
	for (const denied of policy.deniedReadPaths) {
		if (canonical === denied || isInside(denied, canonical)) {
			throw forbidden(`path is in a denied location: ${canonical}`);
		}
	}
	const segments = canonical.split(sep);
	for (const segment of segments) {
		if (DENIED_SEGMENTS.has(segment)) throw forbidden(`path segment denied: ${segment}`);
	}
	const name = basename(canonical);
	for (const pattern of DENIED_BASENAME_PATTERNS) {
		if (pattern.test(name)) throw forbidden(`path name denied: ${name}`);
	}
}

function forbidden(message: string): ControlError {
	return new ControlError("forbidden", message);
}
