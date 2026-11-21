import { describe, expect, it } from "vitest";

import { canonicalJson } from "../src/infrastructure/canonical-json.ts";

describe("canonicalJson", () => {
	it("is stable across object key order but preserves array order", () => {
		const left = { v: 1, blocks: [{ kind: "card", id: "b1", payload: { b: 2, a: 1 } }] };
		const right = { blocks: [{ payload: { a: 1, b: 2 }, id: "b1", kind: "card" }], v: 1 };

		expect(canonicalJson(left)).toBe(canonicalJson(right));
		expect(canonicalJson({ blocks: [1, 2] })).not.toBe(canonicalJson({ blocks: [2, 1] }));
		expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
	});

	it("drops undefined object properties like JSON serialization", () => {
		expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
	});
});
