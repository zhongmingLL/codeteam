function normalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalize);
	if (value === null || typeof value !== "object") return value;
	const source = value as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(source).sort()) {
		const item = source[key];
		if (item !== undefined) result[key] = normalize(item);
	}
	return result;
}

/** Stable JSON used for persisted identity comparisons; array order stays significant. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(normalize(value)) ?? "null";
}
