import { randomUUID } from "node:crypto";
import { ControlError, type ControlErrorCode } from "../errors.ts";

export type Clock = () => number;

export function newId(): string {
	return randomUUID();
}

export function parseJson(value: string): unknown {
	return JSON.parse(value) as unknown;
}

export function parseJsonArray(value: string): unknown[] {
	const parsed = parseJson(value);
	if (!Array.isArray(parsed)) throw new ControlError("invalid_input", "expected a JSON array");
	return parsed;
}

export function parseJsonObject(value: string): Record<string, unknown> {
	const parsed = parseJson(value);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ControlError("invalid_input", "expected a JSON object");
	}
	return parsed as Record<string, unknown>;
}

export function jsonObject(value: unknown, field: string): string {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ControlError("invalid_input", `${field} must be a JSON object`);
	}
	return JSON.stringify(value);
}

export function jsonArray(value: unknown, field: string): string {
	if (!Array.isArray(value)) throw new ControlError("invalid_input", `${field} must be a JSON array`);
	return JSON.stringify(value);
}

export function nonEmpty(value: string | undefined, field: string): string {
	if (!value || value.trim() === "") throw new ControlError("invalid_input", `${field} is required`);
	return value;
}

export function assertNoApprovalBlock(blocks: unknown[]): void {
	for (const block of blocks) {
		if (!block || typeof block !== "object" || Array.isArray(block)) continue;
		if ((block as { kind?: unknown }).kind === "approval") {
			throw new ControlError("invalid_input", "approval_rich_block_forbidden");
		}
	}
}

export function mapStoreError(error: unknown, fallback: ControlErrorCode = "conflict"): ControlError {
	if (error instanceof ControlError) return error;
	const message = error instanceof Error ? error.message : String(error);
	if (message.includes("reply_to_cross_thread")) {
		return new ControlError("invalid_input", "reply_to_cross_thread", { cause: error });
	}
	if (message.includes("approval_rich_block_forbidden")) {
		return new ControlError("invalid_input", "approval_rich_block_forbidden", { cause: error });
	}
	if (message.includes("UNIQUE constraint failed")) {
		return new ControlError("conflict", message, { cause: error });
	}
	if (message.includes("FOREIGN KEY constraint failed") || message.includes("CHECK constraint failed")) {
		return new ControlError("invalid_input", message, { cause: error });
	}
	return new ControlError(fallback, message, { cause: error });
}

export function changesOf(result: { changes: number | bigint }): number {
	return typeof result.changes === "bigint" ? Number(result.changes) : result.changes;
}
