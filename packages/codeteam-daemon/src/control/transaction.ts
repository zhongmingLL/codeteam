import type { DatabaseSync } from "node:sqlite";
import { ControlError } from "./errors.ts";

export class ControlTransaction {
	private readonly database: DatabaseSync;
	private depth = 0;

	constructor(database: DatabaseSync) {
		this.database = database;
	}

	get inTransaction(): boolean {
		return this.depth > 0;
	}

	run<T>(callback: () => T): T {
		if (this.depth > 0) return callback();
		this.depth = 1;
		let started = false;
		try {
			this.database.exec("BEGIN IMMEDIATE");
			started = true;
			const result = callback();
			this.database.exec("COMMIT");
			return result;
		} catch (error) {
			if (started) {
				try {
					this.database.exec("ROLLBACK");
				} catch (rollbackError) {
					throw new ControlError("conflict", "control transaction failed and rollback failed", {
						cause: new AggregateError([error, rollbackError]),
					});
				}
			}
			throw error;
		} finally {
			this.depth = 0;
		}
	}
}
