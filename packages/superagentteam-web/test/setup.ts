import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

class NoopEventSource {
	static readonly instances: NoopEventSource[] = [];
	onerror: ((event: Event) => void) | null = null;
	constructor(readonly url: string) {
		NoopEventSource.instances.push(this);
	}
	addEventListener(): void {}
	removeEventListener(): void {}
	close(): void {}
}

if (typeof globalThis.EventSource === "undefined") {
	globalThis.EventSource = NoopEventSource as unknown as typeof EventSource;
}

afterEach(() => {
	cleanup();
});
