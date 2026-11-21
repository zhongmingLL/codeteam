export type Theme = "light" | "dark";

const THEME_KEY = "superagentteam:theme";

export function readTheme(): Theme {
	try {
		return window.localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
	} catch {
		return "light";
	}
}

export function applyTheme(theme: Theme): void {
	document.documentElement.dataset.theme = theme;
	try {
		window.localStorage.setItem(THEME_KEY, theme);
	} catch {
		// Storage can be unavailable in privacy modes; the applied theme still works.
	}
}
