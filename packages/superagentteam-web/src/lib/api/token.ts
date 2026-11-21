let csrfToken: string | undefined;

export function setCsrfToken(token: string | undefined): void {
	csrfToken = token;
}

export function getCsrfToken(): string | undefined {
	return csrfToken;
}
