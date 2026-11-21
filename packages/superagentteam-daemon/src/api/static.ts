import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".txt": "text/plain; charset=utf-8",
};

export interface StaticHandler {
	readonly root: string;
	handle(request: IncomingMessage, response: ServerResponse, url: URL): boolean;
}

function isInside(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function resolveCandidate(root: string, pathname: string): { file: string; fallback: boolean } | null {
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return null;
	}
	if (decoded.includes("\0")) return null;
	if (decoded === "/") return { file: join(root, "index.html"), fallback: false };

	const candidate = resolve(root, decoded.replace(/^\/+/, ""));
	if (!isInside(root, candidate)) return null;
	const extension = extname(candidate);
	if (existsSync(candidate)) {
		let real: string;
		try {
			real = realpathSync(candidate);
		} catch {
			return null;
		}
		if (!isInside(root, real) || !statSync(real).isFile()) return null;
		return { file: real, fallback: false };
	}
	if (extension !== "") return null;
	return { file: join(root, "index.html"), fallback: true };
}

function serveFile(
	request: IncomingMessage,
	response: ServerResponse,
	file: string,
	pathname: string,
	fallback: boolean,
): void {
	const stat = statSync(file);
	const extension = extname(file).toLowerCase();
	const cacheControl =
		!fallback && pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
	response.writeHead(200, {
		"content-type": CONTENT_TYPES[extension] ?? "application/octet-stream",
		"content-length": String(stat.size),
		"cache-control": cacheControl,
		"x-content-type-options": "nosniff",
	});
	if (request.method === "HEAD") {
		response.end();
		return;
	}
	const stream = createReadStream(file);
	stream.on("error", () => response.destroy());
	stream.pipe(response);
}

export function createStaticHandler(root: string): StaticHandler | null {
	const resolvedRoot = resolve(root);
	let realRoot: string;
	try {
		realRoot = realpathSync(resolvedRoot);
	} catch {
		return null;
	}
	const index = join(realRoot, "index.html");
	if (!existsSync(index) || !statSync(index).isFile()) return null;

	return {
		root: realRoot,
		handle(request, response, url) {
			if (request.method !== "GET" && request.method !== "HEAD") return false;
			const candidate = resolveCandidate(realRoot, url.pathname);
			if (!candidate) {
				response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" });
				response.end("Not found");
				return true;
			}
			try {
				serveFile(request, response, candidate.file, url.pathname, candidate.fallback);
			} catch {
				if (!response.headersSent) {
					response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
					response.end("Not found");
				} else {
					response.destroy();
				}
			}
			return true;
		},
	};
}
