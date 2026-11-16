import { ControlError } from "../control/errors.ts";
import { scanSecrets } from "../memory/redaction.ts";

export interface EvalSecretFinding {
	readonly path: string;
	readonly pattern: string;
}

/**
 * Content-level secret scan for eval-agent generated free text and JSON
 * artifacts. We intentionally fail closed instead of redacting: a verdict that
 * was produced from leaked credentials is not evidence we can publish.
 *
 * The scanner itself is the pure W6a redaction utility; this module never opens
 * memory.db or the memory index.
 */
export function scanEvalContent(value: unknown, rootLabel = "eval"): EvalSecretFinding[] {
	const findings: EvalSecretFinding[] = [];
	walk(value, rootLabel, findings);
	return findings;
}

export function assertNoEvalSecrets(value: unknown, rootLabel = "eval"): void {
	const findings = scanEvalContent(value, rootLabel);
	if (findings.length === 0) return;
	const summary = findings.map((finding) => `${finding.path}:${finding.pattern}`).join(", ");
	throw new ControlError("forbidden", `secret detected in ${rootLabel}: ${summary}`);
}

function walk(value: unknown, path: string, findings: EvalSecretFinding[]): void {
	if (typeof value === "string") {
		for (const finding of scanSecrets(value)) {
			findings.push({ path, pattern: finding.pattern });
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) walk(item, `${path}[${index}]`, findings);
		return;
	}
	if (value && typeof value === "object") {
		for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`, findings);
	}
}
