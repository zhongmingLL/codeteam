import { afterEach, describe, expect, it } from "vitest";

import { consumeReturnTo, rememberReturnTo } from "@/lib/return-to";

afterEach(() => {
	window.sessionStorage.clear();
});

describe("relogin return path", () => {
	it("remembers an internal thread path and consumes it once", () => {
		rememberReturnTo("/thread/thread%3A1", "");

		expect(consumeReturnTo()).toBe("/thread/thread%3A1");
		expect(consumeReturnTo()).toBeNull();
	});

	it("ignores relogin and protocol-relative paths", () => {
		rememberReturnTo("/relogin", "");
		expect(consumeReturnTo()).toBeNull();

		rememberReturnTo("//evil.example", "");
		expect(consumeReturnTo()).toBeNull();
	});
});
