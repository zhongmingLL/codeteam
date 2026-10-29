export const A2A_REQUEST_DEDUPE_STATEMENTS: readonly string[] = [
	`CREATE TABLE a2a_requests (
		id TEXT PRIMARY KEY,
		task_id TEXT NOT NULL,
		profile_id TEXT NOT NULL,
		request_id TEXT NOT NULL,
		intent_hash TEXT NOT NULL,
		message_id TEXT NOT NULL,
		queue_entry_id TEXT,
		created_at INTEGER NOT NULL,
		UNIQUE (task_id, profile_id, request_id),
		FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
		FOREIGN KEY (profile_id) REFERENCES agent_profiles(id) ON DELETE RESTRICT,
		FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE RESTRICT
	) STRICT`,
	"CREATE INDEX a2a_requests_message ON a2a_requests(message_id)",
];
