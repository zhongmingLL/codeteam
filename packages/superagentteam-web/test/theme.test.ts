import { afterEach, describe, expect, it } from "vitest";

import { applyTheme, readTheme } from "@/lib/theme";

afterEach(() => {
	window.localStorage.clear();
	document.documentElement.removeAttribute("data-theme");
});

describe("theme", () => {
	it("applies and remembers the selected theme", () => {
		expect(readTheme()).toBe("light");

		applyTheme("dark");

		expect(document.documentElement.dataset.theme).toBe("dark");
		expect(readTheme()).toBe("dark");
	});
});
