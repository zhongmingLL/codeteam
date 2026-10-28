import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export interface SecretFinding {
	readonly pattern: string;
	readonly start: number;
	readonly end: number;
}

interface SecretPattern {
	readonly name: string;
	readonly regex: RegExp;
	readonly useFirstCapture?: boolean;
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
	{
		name: "private_key",
		regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
	},
	{ name: "private_key", regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
	{ name: "aws_access_key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
	{ name: "github_token", regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
	{ name: "github_pat", regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
	{ name: "anthropic_key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
	{ name: "openai_key", regex: /\bsk-[A-Za-z0-9]{20,}\b/g },
	{ name: "slack_token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
	{ name: "google_api_key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
	{ name: "jwt", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
	{
		name: "assigned_secret",
		regex: /\b(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)\s*[:=]\s*["']?([^\s"'`]{8,})/gi,
		useFirstCapture: true,
	},
];

const HIGH_ENTROPY_TOKEN = /[A-Za-z0-9+/=_-]{32,}/g;

const DENIED_DIRS = new Set([
	"node_modules",
	"dist",
	"build",
	"target",
	".git",
	".worktrees",
	".cat-cafe",
	".codex",
	"coverage",
	".nyc_output",
	"vendor",
]);

const DENIED_NAMES = new Set([
	".env",
	".npmrc",
	".netrc",
	".pypirc",
	"id_rsa",
	"id_dsa",
	"id_ecdsa",
	"id_ed25519",
	"credentials",
	"credentials.json",
	"secrets",
	"secrets.json",
]);

const DENIED_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".keystore", ".jks"];

function isPlaceholder(value: string): boolean {
	return (
		/^\$\{?[A-Z0-9_]+\}?$/.test(value) ||
		/^<.*>$/.test(value) ||
		/^process\.env/.test(value) ||
		/^env\./.test(value) ||
		/^(true|false|null|undefined|changeme|placeholder|example|your[_-])/i.test(value)
	);
}

function entropy(value: string): number {
	const counts = new Map<string, number>();
	for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
	let result = 0;
	for (const count of counts.values()) {
		const probability = count / value.length;
		result -= probability * Math.log2(probability);
	}
	return result;
}

function isHighEntropy(value: string): boolean {
	if (value.length < 40) return false;
	if (/^[0-9a-fA-F]+$/.test(value)) return false;
	if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)) return false;
	const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[+/=_-]/].filter((regex) => regex.test(value)).length;
	if (classes < 3) return false;
	return entropy(value) >= 4.5;
}

function overlaps(findings: readonly SecretFinding[], start: number, end: number): boolean {
	return findings.some((finding) => start < finding.end && end > finding.start);
}

export function scanSecrets(text: string): SecretFinding[] {
	const findings: SecretFinding[] = [];
	for (const pattern of SECRET_PATTERNS) {
		const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
		for (const match of text.matchAll(regex)) {
			const start = match.index;
			if (start === undefined) continue;
			const value = pattern.useFirstCapture ? (match[1] ?? match[0]) : match[0];
			if (pattern.useFirstCapture && isPlaceholder(value)) continue;
			const end = start + match[0].length;
			if (overlaps(findings, start, end)) continue;
			findings.push({ pattern: pattern.name, start, end });
		}
	}
	const tokenRegex = new RegExp(HIGH_ENTROPY_TOKEN.source, HIGH_ENTROPY_TOKEN.flags);
	for (const match of text.matchAll(tokenRegex)) {
		const start = match.index;
		if (start === undefined) continue;
		const end = start + match[0].length;
		if (overlaps(findings, start, end)) continue;
		if (!isHighEntropy(match[0])) continue;
		findings.push({ pattern: "high_entropy", start, end });
	}
	return findings.sort((left, right) => left.start - right.start || left.end - right.end);
}

export function redactSecrets(text: string): { text: string; findings: SecretFinding[] } {
	const findings = scanSecrets(text);
	if (findings.length === 0) return { text, findings };
	const merged: SecretFinding[] = [];
	for (const finding of findings) {
		const previous = merged.at(-1);
		if (previous && finding.start < previous.end) {
			merged[merged.length - 1] = {
				pattern: previous.pattern,
				start: previous.start,
				end: Math.max(previous.end, finding.end),
			};
		} else {
			merged.push(finding);
		}
	}
	let result = "";
	let cursor = 0;
	for (const finding of merged) {
		result += text.slice(cursor, finding.start);
		result += `[REDACTED:${finding.pattern}]`;
		cursor = finding.end;
	}
	result += text.slice(cursor);
	return { text: result, findings: merged };
}

export interface PathPolicyOptions {
	readonly root: string;
	readonly denyPrefixes?: readonly string[];
}

export type PathDecision =
	| { readonly allowed: true; readonly absolutePath: string; readonly relativePath: string }
	| {
			readonly allowed: false;
			readonly reason: "outside_root" | "denied_prefix" | "denied_name" | "symlink_escape";
			readonly detail: string;
	  };

export function defaultMemoryDenyPrefixes(): string[] {
	const home = homedir();
	const configured = (process.env.CODETEAM_MEMORY_DENY_PREFIXES ?? "")
		.split(delimiter)
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
	return [
		...new Set([
			join(home, ".ssh"),
			join(home, ".aws"),
			join(home, ".gnupg"),
			join(home, ".config"),
			join(home, ".cat-cafe"),
			join(home, ".codeteam", "auth"),
			"/etc",
			"/proc",
			"/sys",
			"/dev",
			...configured,
		]),
	];
}

function isInside(candidate: string, prefix: string): boolean {
	const rel = relative(resolve(prefix), resolve(candidate));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isDeniedName(basename: string): boolean {
	const lower = basename.toLowerCase();
	if (lower === ".env" || lower.startsWith(".env.")) return true;
	if (DENIED_NAMES.has(lower)) return true;
	if (DENIED_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true;
	return lower.startsWith("credentials") || lower.startsWith("secrets");
}

function toPosix(path: string): string {
	return sep === "/" ? path : path.split(sep).join("/");
}

function realpathForContainment(absolute: string): string {
	try {
		return realpathSync(absolute);
	} catch {
		try {
			return join(realpathSync(dirname(absolute)), absolute.slice(absolute.lastIndexOf(sep) + 1));
		} catch {
			return absolute;
		}
	}
}

export function evaluateMemoryPath(input: string, options: PathPolicyOptions): PathDecision {
	const root = realpathForContainment(resolve(options.root));
	const absolute = isAbsolute(input) ? normalize(input) : resolve(root, input);
	const basename = absolute.slice(absolute.lastIndexOf(sep) + 1);
	if (isDeniedName(basename)) {
		return { allowed: false, reason: "denied_name", detail: basename };
	}
	const denyPrefixes = options.denyPrefixes ?? defaultMemoryDenyPrefixes();
	for (const prefix of denyPrefixes) {
		if (isInside(absolute, prefix)) {
			return { allowed: false, reason: "denied_prefix", detail: prefix };
		}
	}
	const rel = relative(root, absolute);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
		return { allowed: false, reason: "outside_root", detail: absolute };
	}
	const real = realpathForContainment(absolute);
	const realRel = relative(root, real);
	if (realRel.startsWith("..") || isAbsolute(realRel)) {
		return { allowed: false, reason: "symlink_escape", detail: real };
	}
	for (const prefix of denyPrefixes) {
		if (isInside(real, prefix)) {
			return { allowed: false, reason: "denied_prefix", detail: prefix };
		}
	}
	return { allowed: true, absolutePath: absolute, relativePath: toPosix(rel) };
}

export function isAllowedEvidenceFile(relativePath: string): boolean {
	const normalized = relativePath.replaceAll("\\", "/");
	const segments = normalized.split("/").filter((segment) => segment !== "");
	if (segments.some((segment) => DENIED_DIRS.has(segment))) return false;
	const basename = segments.at(-1) ?? "";
	if (isDeniedName(basename)) return false;
	return basename.endsWith(".md");
}
