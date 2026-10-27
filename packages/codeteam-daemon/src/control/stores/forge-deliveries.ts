import type { DatabaseSync } from "node:sqlite";
import { ControlError } from "../errors.ts";
import { type Clock, changesOf, mapStoreError, newId, nonEmpty } from "./helpers.ts";
import type { CreateForgeDeliveryInput, ForgeDelivery } from "./types.ts";

interface ForgeDeliveryRow {
	id: string;
	provider: string;
	repo: string;
	delivery_id: string;
	natural_key: string;
	status: string;
	retry_count: number;
	received_at: number;
	processed_at: number | null;
}

function mapDelivery(row: ForgeDeliveryRow): ForgeDelivery {
	return {
		id: row.id,
		provider: row.provider,
		repo: row.repo,
		deliveryId: row.delivery_id,
		naturalKey: row.natural_key,
		status: row.status,
		retryCount: row.retry_count,
		receivedAt: row.received_at,
		processedAt: row.processed_at,
	};
}

export class ForgeDeliveryStore {
	private readonly database: DatabaseSync;
	private readonly clock: Clock;

	constructor(database: DatabaseSync, clock: Clock) {
		this.database = database;
		this.clock = clock;
	}

	get(id: string): ForgeDelivery | null {
		const row = this.database.prepare("SELECT * FROM forge_deliveries WHERE id = ?").get(id) as
			| ForgeDeliveryRow
			| undefined;
		return row ? mapDelivery(row) : null;
	}

	record(input: CreateForgeDeliveryInput): ForgeDelivery {
		const id = input.id ?? newId();
		try {
			this.database
				.prepare(
					"INSERT INTO forge_deliveries (id, provider, repo, delivery_id, natural_key, status, retry_count, received_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
				)
				.run(
					id,
					nonEmpty(input.provider, "provider"),
					nonEmpty(input.repo, "repo"),
					nonEmpty(input.deliveryId, "deliveryId"),
					nonEmpty(input.naturalKey, "naturalKey"),
					input.status ?? "received",
					input.receivedAt ?? this.clock(),
				);
		} catch (error) {
			throw mapStoreError(error, "invalid_input");
		}
		return this.get(id)!;
	}

	markProcessed(id: string, processedAt?: number): ForgeDelivery {
		try {
			const result = this.database
				.prepare("UPDATE forge_deliveries SET status = 'processed', processed_at = ? WHERE id = ?")
				.run(processedAt ?? this.clock(), id);
			if (changesOf(result) === 0) throw new ControlError("not_found", `forge delivery ${id} not found`);
			return this.get(id)!;
		} catch (error) {
			throw mapStoreError(error);
		}
	}

	listUnprocessed(limit = 100): ForgeDelivery[] {
		const rows = this.database
			.prepare("SELECT * FROM forge_deliveries WHERE status <> 'processed' ORDER BY received_at LIMIT ?")
			.all(Math.min(Math.max(limit, 1), 500)) as unknown as ForgeDeliveryRow[];
		return rows.map(mapDelivery);
	}
}
