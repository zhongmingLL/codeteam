import { CORE_SCHEMA_STATEMENTS } from "./001-core.ts";
import { WORK_SCHEMA_STATEMENTS } from "./002-work.ts";
import { GOVERNANCE_SCHEMA_STATEMENTS } from "./003-governance.ts";
import { QUEUE_SOURCE_STATEMENTS } from "./004-queue-source.ts";
import { RUNS_QUEUE_REF_STATEMENTS } from "./005-runs-queue-ref.ts";
import { INVOCATION_ALLOWLIST_STATEMENTS } from "./006-invocation-allowlist.ts";
import { REVIEW_EVIDENCE_STATEMENTS } from "./007-review-evidence.ts";
import { REVIEW_ROUND_DECISION_STATEMENTS } from "./008-review-round-decision.ts";
import { SOP_CHECK_EVIDENCE_STATEMENTS } from "./009-sop-check-evidence.ts";
import { MERGE_RECEIPT_CONTRACT_STATEMENTS } from "./010-merge-receipt-contract.ts";

export interface ControlMigration {
	readonly version: number;
	readonly name: string;
	readonly statements: readonly string[];
	readonly foreignKeysOff?: boolean;
}

export const CONTROL_MIGRATIONS: readonly ControlMigration[] = [
	{ version: 1, name: "core-control-plane", statements: CORE_SCHEMA_STATEMENTS },
	{ version: 2, name: "work-sop-artifacts", statements: WORK_SCHEMA_STATEMENTS },
	{ version: 3, name: "custody-approval-review", statements: GOVERNANCE_SCHEMA_STATEMENTS },
	{ version: 4, name: "queue-source-uniqueness", statements: QUEUE_SOURCE_STATEMENTS },
	{ version: 5, name: "runs-queue-ref-set-null", statements: RUNS_QUEUE_REF_STATEMENTS, foreignKeysOff: true },
	{ version: 6, name: "invocation-callback-allowlist", statements: INVOCATION_ALLOWLIST_STATEMENTS },
	{ version: 7, name: "review-evidence-chain", statements: REVIEW_EVIDENCE_STATEMENTS },
	{ version: 8, name: "review-round-decision", statements: REVIEW_ROUND_DECISION_STATEMENTS },
	{ version: 9, name: "sop-check-evidence", statements: SOP_CHECK_EVIDENCE_STATEMENTS },
	{ version: 10, name: "merge-receipt-contract", statements: MERGE_RECEIPT_CONTRACT_STATEMENTS },
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
	"sop_check_evidence",
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
