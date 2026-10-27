#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DOC_PATTERNS = [
	/^docs\//,
	/^BACKLOG\.md$/,
	/^README\.md$/,
	/^UPSTREAM\.md$/,
	/^KERNEL_GAPS\.md$/,
	/^AGENTS\.md$/,
	/^CLAUDE\.md$/,
];

const CODETEAM_PATTERN = /^packages\/codeteam-[^/]+\//;

export function classify(paths) {
	const files = paths.map((path) => path.trim()).filter(Boolean);
	if (files.length === 0) return "upstream";
	const isDoc = (file) => DOC_PATTERNS.some((pattern) => pattern.test(file));
	const isCodeteam = (file) => CODETEAM_PATTERN.test(file);
	if (files.every(isDoc)) return "docs";
	if (files.every((file) => isDoc(file) || isCodeteam(file))) return "codeteam";
	return "upstream";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const input = process.argv.length > 2 ? process.argv.slice(2) : readFileSync(0, "utf8").split("\n");
	process.stdout.write(classify(input));
}
