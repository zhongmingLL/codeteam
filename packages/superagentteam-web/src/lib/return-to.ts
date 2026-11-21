const RETURN_TO_KEY = "superagentteam:returnTo";

function isSafeInternalPath(path: string): boolean {
	return path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/relogin");
}

export function rememberReturnTo(pathname: string, search: string): void {
	const path = `${pathname}${search}`;
	if (!isSafeInternalPath(path)) return;
	try {
		window.sessionStorage.setItem(RETURN_TO_KEY, path);
	} catch {
		// Storage may be unavailable; relogin still works without deep-link return.
	}
}

export function consumeReturnTo(): string | null {
	try {
		const value = window.sessionStorage.getItem(RETURN_TO_KEY);
		window.sessionStorage.removeItem(RETURN_TO_KEY);
		return value !== null && isSafeInternalPath(value) ? value : null;
	} catch {
		return null;
	}
}
