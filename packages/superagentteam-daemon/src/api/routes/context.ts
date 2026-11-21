import type { BrowserSession } from "../session.ts";

export interface ApiRouteContext {
	session: BrowserSession;
	origin: string | undefined;
}
