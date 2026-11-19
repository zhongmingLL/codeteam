// F018 operator mention parsing (0007 §3.0, DP-F018MENTION-1=B).
//
// Provenance: scanning primitives (handle boundary/continuation classes,
// longest-pattern-first ordering, markdown list/quote prefix tolerance,
// fenced-code stripping) are adapted from the Clowder reference
// implementation (a2a-mentions.ts + AgentRouter user-message scanning).
// The body-wide semantics are the F018 contract: explicit @ anywhere in
// operator prose; fenced/inline code and URL-ish tokens excluded;
// unmatched @tokens are plain text (no reject); resolution is separate.

/** @internal Token boundary after a handle (borrowed from Clowder). */
const TOKEN_BOUNDARY = String.raw`(?=$|[\s,.:;!?()\[\]{}<>，。！？、：；（）【】《》「」『』〈〉]|[^a-z0-9_.-])`;
const LINE_START_PREFIX = String.raw`(?:\s|>|\*|-|\+|\d+[.)])*`;

export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Spans to exclude from scanning: fenced code, inline code, URL-ish tokens. */
export function computeExclusionSpans(text: string): Array<[number, number]> {
	const spans: Array<[number, number]> = [];
	const fenced = /```[\s\S]*?(```|$)/g;
	for (const match of text.matchAll(fenced)) {
		if (match.index !== undefined) spans.push([match.index, match.index + match[0].length]);
	}
	const inline = /`[^`\n]*`/g;
	for (const match of text.matchAll(inline)) {
		if (match.index === undefined) continue;
		const span: [number, number] = [match.index, match.index + match[0].length];
		if (!spans.some(([s, e]) => span[0] >= s && span[1] <= e)) spans.push(span);
	}
	// URL-ish: scheme://... or www. token (with a leading char class so the
	// preceding @ in user@host does not swallow into a handle scan).
	const urlish = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>()]+/gi;
	for (const match of text.matchAll(urlish)) {
		if (match.index === undefined) continue;
		spans.push([match.index, match.index + match[0].length]);
	}
	return spans.sort((a, b) => a[0] - b[0]);
}

function inSpans(spans: Array<[number, number]>, index: number): boolean {
	return spans.some(([s, e]) => index >= s && index < e);
}

export interface MentionMatch {
	/** Matched pattern including the leading @, lowercased. */
	pattern: string;
	index: number;
}

/**
 * Scan explicit @mentions anywhere in operator prose.
 * Patterns must be pre-lowercased with leading @. Longest-first matching:
 * a longer pattern wins over its prefix at the same position. First match
 * at a position wins; overlapping shorter matches are skipped.
 */
export function scanOperatorMentions(
	text: string,
	patterns: readonly string[],
): MentionMatch[] {
	if (!text || patterns.length === 0) return [];
	const lower = text.toLowerCase();
	const spans = computeExclusionSpans(text);
	const sorted = [...patterns].sort((a, b) => b.length - a.length);
	const matches: MentionMatch[] = [];
	const taken: Array<[number, number]> = [];
	const candidates = [...lower.matchAll(/@/g)];
	for (const candidate of candidates) {
		const at = candidate.index;
		if (at === undefined || inSpans(spans, at)) continue;
		for (const pattern of sorted) {
			const start = at;
			const end = at + pattern.length;
			if (lower.startsWith(pattern, at)) {
				const suffix = lower.charAt(end);
				const boundaryRe = new RegExp(`^${TOKEN_BOUNDARY}`, "u");
				const boundaryOk = suffix === "" || boundaryRe.test(suffix);
				if (!boundaryOk) break; // shorter patterns also fail boundary at same spot
				if (taken.some(([s, e]) => start >= s && start < e)) break;
				matches.push({ pattern, index: at });
				taken.push([start, end]);
				break;
			}
		}
	}
	return matches.sort((a, b) => a.index - b.index);
}

/**
 * parseOperatorMentions (0007 §3.0 step 1): returns matched patterns in
 * position order. Unmatched @tokens are plain text and produce nothing.
 * Resolution (enabled/missing/ambiguity) belongs to the registry step.
 */
export function parseOperatorMentions(body: string, patterns: readonly string[]): string[] {
	return scanOperatorMentions(body, patterns).map((match) => match.pattern);
}
