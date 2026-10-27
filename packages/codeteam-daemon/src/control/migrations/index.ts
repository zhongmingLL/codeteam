import { CORE_SCHEMA_STATEMENTS } from "./001-core.ts";
import { WORK_SCHEMA_STATEMENTS } from "./002-work.ts";
import { GOVERNANCE_SCHEMA_STATEMENTS } from "./003-governance.ts";

export interface ControlMigration {
	readonly version: number;
	readonly name: string;
	readonly statements: readonly string[];
}

export const CONTROL_MIGRATIONS: readonly ControlMigration[] = [
	{ version: 1, name: "core-control-plane", statements: CORE_SCHEMA_STATEMENTS },
	{ version: 2, name: "work-sop-artifacts", statements: WORK_SCHEMA_STATEMENTS },
	{ version: 3, name: "custody-approval-review", statements: GOVERNANCE_SCHEMA_STATEMENTS },
];

export const CONTROL_TABLE_NAMES: readonly string[] = [
	"roles",
	"agent_profiles",
	"threads",
	"tasks",
	"stages",
	"messages",
	"queue_entries",
	"agent_sessions",
	"runs",
	"run_events",
	"thread_events",
	"invocation_credentials",
	"backlog_items",
	"workflow_sops",
	"work_admissions",
	"work_attempts",
	"run_managed_work_bindings",
	"task_managed_work_bindings",
	"artifacts",
	"inbox",
	"handoffs",
	"handoff_holder_claims",
	"custody_events",
	"approvals",
	"waits",
	"wait_terminations",
	"reviews",
	"findings",
	"verifications",
	"merges",
	"budgets",
	"evals",
	"forge_deliveries",
	"audit",
];
