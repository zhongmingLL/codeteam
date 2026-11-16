import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const L0_ROLES = ["coder", "reviewer", "verifier"] as const;
export type L0Role = (typeof L0_ROLES)[number];

export interface L0Section {
	id: string;
	body: string;
}

export interface CompileL0Options {
	role: L0Role;
	sections?: readonly L0Section[];
}

export interface CompiledL0 {
	text: string;
	revision: string;
	role: L0Role;
}

const GOVERNANCE = `## Governance

- Follow the accepted task and its acceptance criteria; do not replace them with a convenient local task.
- Keep the pi kernel read-only unless a reproducible failure is recorded in KERNEL_GAPS.md.
- Do not read production credentials or point tests at production data.
- Do not claim completion without a fresh command run and its output.`;

function normalizeText(value: string): string {
	return `${value
		.replace(/\r\n?/g, "\n")
		.replace(/[ \t]+$/gm, "")
		.trim()}\n`;
}

function isL0Role(value: string): value is L0Role {
	return (L0_ROLES as readonly string[]).includes(value);
}

export function loadRoleTemplate(role: L0Role): string {
	const path = fileURLToPath(new URL(`./templates/${role}.md`, import.meta.url));
	return normalizeText(readFileSync(path, "utf8"));
}

export function compileL0(options: CompileL0Options): CompiledL0 {
	if (!isL0Role(options.role)) {
		throw new Error(`Unknown L0 role: ${String(options.role)}`);
	}

	const sections = [...(options.sections ?? [])].sort((left, right) => left.id.localeCompare(right.id));
	const body = [
		loadRoleTemplate(options.role),
		GOVERNANCE,
		...sections.map((section) => `## ${section.id}\n\n${normalizeText(section.body)}`),
	].join("\n");
	const text = normalizeText(body);
	const revision = `sha256-${createHash("sha256").update(text).digest("hex")}`;
	return { text, revision, role: options.role };
}
