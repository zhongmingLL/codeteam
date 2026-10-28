export const TOOL_USAGE_SCHEMA_STATEMENTS: readonly string[] = [
	`CREATE TABLE tool_usage_events (
		id TEXT PRIMARY KEY,
		run_id TEXT NOT NULL,
		profile_id TEXT NOT NULL,
		day TEXT NOT NULL,
		category TEXT NOT NULL CHECK (category IN ('native', 'mcp', 'skill')),
		tool_name TEXT NOT NULL,
		recorded_at INTEGER NOT NULL
	) STRICT`,
	`CREATE INDEX tool_usage_events_day ON tool_usage_events(day)`,
	`CREATE INDEX tool_usage_events_recorded ON tool_usage_events(recorded_at)`,
	`CREATE INDEX tool_usage_events_run ON tool_usage_events(run_id)`,
	`CREATE TABLE tool_usage_counters (
		day TEXT NOT NULL,
		profile_id TEXT NOT NULL,
		category TEXT NOT NULL CHECK (category IN ('native', 'mcp', 'skill')),
		tool_name TEXT NOT NULL,
		count INTEGER NOT NULL CHECK (count >= 0),
		updated_at INTEGER NOT NULL,
		PRIMARY KEY (day, profile_id, category, tool_name)
	) STRICT, WITHOUT ROWID`,
];
