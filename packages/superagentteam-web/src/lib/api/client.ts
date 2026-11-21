export interface ApiErrorBody {
	error?: string;
	message?: string;
	[key: string]: unknown;
}

export class ApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly body: unknown;

	constructor(status: number, code: string, message: string, body: unknown) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
		this.body = body;
	}
}

export interface ApiClientOptions {
	baseUrl?: string;
	fetchImpl?: typeof fetch;
	getCsrfToken?: () => string | undefined;
}

export interface ApiClient {
	request<T>(path: string, init?: RequestInit): Promise<T>;
	get<T>(path: string): Promise<T>;
	post<T>(path: string, body: unknown): Promise<T>;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
	const baseUrl = options.baseUrl ?? "";
	const fetchImpl = options.fetchImpl ?? fetch;

	async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
		const headers = new Headers(init.headers);
		const method = (init.method ?? "GET").toUpperCase();
		if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
		if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
			const csrf = options.getCsrfToken?.();
			if (csrf) headers.set("x-csrf-token", csrf);
		}
		const response = await fetchImpl(`${baseUrl}${path}`, { ...init, headers, credentials: "include" });
		const text = await response.text();
		let body: unknown;
		if (text !== "") {
			try {
				body = JSON.parse(text) as unknown;
			} catch {
				body = text;
			}
		}
		if (!response.ok) {
			const errorBody = typeof body === "object" && body !== null ? (body as ApiErrorBody) : undefined;
			throw new ApiError(
				response.status,
				typeof errorBody?.error === "string" ? errorBody.error : `http_${response.status}`,
				typeof errorBody?.message === "string" ? errorBody.message : response.statusText,
				body,
			);
		}
		return body as T;
	}

	return {
		request,
		get: (path) => request(path),
		post: (path, body) => request(path, { method: "POST", body: JSON.stringify(body) }),
	};
}
