import type { DatabaseSync } from "node:sqlite";
import { type ControlDatabase, type OpenControlDatabaseOptions, openControlDatabase } from "./database.ts";
import type { Clock } from "./stores/helpers.ts";
import { MessageStore } from "./stores/messages.ts";
import { AgentProfileStore } from "./stores/profiles.ts";
import { QueueStore } from "./stores/queue.ts";
import { RoleStore } from "./stores/roles.ts";
import { AgentSessionStore } from "./stores/sessions.ts";
import { ThreadStore } from "./stores/threads.ts";
import type { ProfileSeed } from "./stores/types.ts";
import { ControlTransaction } from "./transaction.ts";

export interface ControlStoreOptions extends OpenControlDatabaseOptions {
	readonly clock?: Clock;
}

export interface SeedIdentityConfig {
	readonly eval: ProfileSeed;
	readonly compress: ProfileSeed;
}

export class ControlStore {
	readonly control: ControlDatabase;
	readonly transaction: ControlTransaction;
	readonly roles: RoleStore;
	readonly profiles: AgentProfileStore;
	readonly sessions: AgentSessionStore;
	readonly threads: ThreadStore;
	readonly messages: MessageStore;
	readonly queue: QueueStore;

	constructor(control: ControlDatabase, clock: Clock = Date.now) {
		this.control = control;
		this.transaction = new ControlTransaction(control.database);
		this.roles = new RoleStore(control.database, clock);
		this.profiles = new AgentProfileStore(control.database, clock);
		this.sessions = new AgentSessionStore(control.database, this.transaction, clock);
		this.threads = new ThreadStore(control.database, this.transaction, clock);
		this.messages = new MessageStore(control.database, this.transaction, clock);
		this.queue = new QueueStore(control.database, this.transaction, clock);
	}

	get database(): DatabaseSync {
		return this.control.database;
	}

	seedIdentity(config?: SeedIdentityConfig): void {
		this.transaction.run(() => {
			this.roles.seedBuiltInRoles();
			if (config) this.profiles.seedDefaultProfiles(config);
		});
	}

	close(): void {
		this.control.close();
	}
}

export function openControlStore(options: ControlStoreOptions = {}): ControlStore {
	const { clock, ...databaseOptions } = options;
	return new ControlStore(openControlDatabase(databaseOptions), clock);
}
