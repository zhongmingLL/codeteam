export const KEYWORD_SEPARATOR = "\u001f";

export function encodeKeywords(keywords: readonly string[]): string {
	return keywords.join(KEYWORD_SEPARATOR);
}

export function decodeKeywords(value: string | null): string[] {
	if (!value) return [];
	if (value.includes(KEYWORD_SEPARATOR)) {
		return value.split(KEYWORD_SEPARATOR).filter((entry) => entry !== "");
	}
	return value.split(/\s+/).filter((entry) => entry !== "");
}
