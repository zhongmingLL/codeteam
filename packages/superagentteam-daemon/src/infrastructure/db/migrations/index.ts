import { coreMigration } from "./001-core.ts";
import { messagesMigration } from "./002-messages.ts";

/**
 * F018 migration unit. 0005 §4.2 defines the v1 table set; migrations are
 * additive and registered in order. Greenfield baseline: only F018 tables.
 */
export interface ControlMigration {
	version: number;
	name: string;
	up: readonly string[];
	down: readonly string[];
}

export const F018_MIGRATIONS: readonly ControlMigration[] = [coreMigration, messagesMigration];

export function assertF018MigrationSet(migrations: readonly ControlMigration[]): void {
	if (migrations.length === 0) throw new Error("f018_migrations_empty");
	for (const [index, migration] of migrations.entries()) {
		if (migration.version !== index + 1) {
			throw new Error(
				`f018_migration_version_gap: expected ${index + 1}, got ${migration.version} (${migration.name})`,
			);
		}
		if (migration.up.length === 0) throw new Error(`f018_migration_empty_up: ${migration.name}`);
		if (migration.down.length === 0) throw new Error(`f018_migration_empty_down: ${migration.name}`);
		if (new Set(migration.down).size !== migration.down.length) {
			throw new Error(`f018_migration_down_duplicate: ${migration.name}`);
		}
	}
}
