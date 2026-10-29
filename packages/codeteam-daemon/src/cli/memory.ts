import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Coverage, EvidenceKind, RetrievalTrigger } from "../memory/contract.ts";
import { type MemoryDatabase, openMemoryDatabase, resolveMemoryDatabasePath } from "../memory/database.ts";
import { buildSessionDigest } from "../memory/digest.ts";
import { MemoryError } from "../memory/errors.ts";
import { MemoryIndexer } from "../memory/indexer.ts";
import { MemoryService } from "../memory/service.ts";
import { ControlEvidenceReader } from "../memory/sources/control.ts";
import { flag, option, options, type ParsedArgs, parseArgs } from "./args.ts";
import { writeJson, writeLine } from "./output.ts";

const TRIGGERS: readonly RetrievalTrigger[] = ["kickoff", "design", "impl", "review", "verify", "merge", "completion"];
const EVIDENCE_KINDS: readonly EvidenceKind[] = [
	"feature",
	"decision",
	"plan",
	"lesson",
	"architecture",
	"thread",
	"session",
	"research",
	"discussion",
	"task",
	"artifact",
	"review",
	"verification",
	"merge",
];

function dataDir(args: ParsedArgs): string {
	const value = option(args, "data-dir") ?? process.env.CODETEAM_DATA_DIR;
	if (!value || value.trim() === "") {
		throw new MemoryError("memory_unavailable", "CODETEAM_DATA_DIR or --data-dir is required");
	}
	return value;
}

function memoryPath(args: ParsedArgs): string {
	return resolveMemoryDatabasePath({ path: option(args, "memory-db"), dataDir: dataDir(args) });
}

function syntheticCoverage(reason: string): Coverage {
	return {
		workspaceId: "",
		collectionId: "",
		scope: "indexed_scope_only",
		indexRunId: null,
		indexedAt: null,
		indexStatus: "never_run",
		stale: true,
		degraded: true,
		reasons: [reason],
		counts: { evidence: 0, file: 0, control: 0 },
	};
}

function openReadMemory(args: ParsedArgs): MemoryDatabase | null {
	try {
		return openMemoryDatabase({ path: memoryPath(args), create: false });
	} catch (error) {
		if (error instanceof MemoryError && error.code === "memory_unavailable") return null;
		throw error;
	}
}

function openControl(args: ParsedArgs): ControlEvidenceReader | null {
	const data = dataDir(args);
	const path = join(data, "control.db");
	return existsSync(path) ? ControlEvidenceReader.open({ path }) : null;
}

function parseKinds(args: ParsedArgs): EvidenceKind[] | undefined {
	const values = options(args, "kind");
	if (values.length === 0) return undefined;
	for (const value of values) {
		if (!EVIDENCE_KINDS.includes(value as EvidenceKind)) {
			throw new MemoryError("invalid_input", `unknown evidence kind: ${value}`);
		}
	}
	return values as EvidenceKind[];
}

function parseTrigger(value: string | undefined): RetrievalTrigger | undefined {
	if (value === undefined) return undefined;
	if (!TRIGGERS.includes(value as RetrievalTrigger)) {
		throw new MemoryError("invalid_input", `unknown retrieval trigger: ${value}`);
	}
	return value as RetrievalTrigger;
}

function limit(args: ParsedArgs): number | undefined {
	const raw = option(args, "limit");
	if (raw === undefined) return undefined;
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 50) {
		throw new MemoryError("invalid_input", "--limit must be an integer between 1 and 50");
	}
	return parsed;
}

function requirePositional(args: ParsedArgs, label: string): string {
	const value = args.positionals[0];
	if (!value || value.trim() === "") throw new MemoryError("invalid_input", `${label} is required`);
	return value;
}

function writeCoverage(coverage: Coverage): void {
	writeLine(
		`coverage: scope=${coverage.scope} indexStatus=${coverage.indexStatus} stale=${coverage.stale} degraded=${coverage.degraded}`,
	);
	writeLine(
		`counts: evidence=${coverage.counts.evidence} file=${coverage.counts.file} control=${coverage.counts.control}`,
	);
	if (coverage.reasons.length > 0) writeLine(`reasons: ${coverage.reasons.join(",")}`);
}

function writeResult(result: {
	items: readonly {
		kind: string;
		title: string;
		source: { ref: string };
		passage: string;
		stale: boolean;
		staleReasons: readonly string[];
	}[];
	coverage: Coverage;
}): void {
	if (result.items.length === 0) {
		writeLine("(no indexed evidence in scope)");
	} else {
		for (const item of result.items) {
			const stale = item.stale ? ` [stale: ${item.staleReasons.join(",")}]` : "";
			writeLine(`[${item.kind}] ${item.title} (${item.source.ref})${stale}`);
			const passage = item.passage.replace(/\s+/g, " ").trim();
			if (passage !== "") writeLine(`  ${passage.length > 300 ? `${passage.slice(0, 297)}...` : passage}`);
		}
	}
	writeCoverage(result.coverage);
}

export function runMemoryCommand(argv: readonly string[]): number {
	const args = parseArgs(argv, ["json", "full", "redact-secrets"]);
	const json = flag(args, "json");
	const [subcommand] = args.positionals;
	if (!subcommand || subcommand === "help") {
		writeLine("usage: codeteam memory <index|status|recall|read|digest|trigger> [options]");
		return 0;
	}
	if (subcommand === "index") return runIndex(args, json);
	if (subcommand === "status") return runStatus(args, json);
	if (subcommand === "recall") return runRecall(args, json);
	if (subcommand === "read") return runRead(args, json);
	if (subcommand === "digest") return runDigest(args, json);
	if (subcommand === "trigger") return runTrigger(args, json);
	throw new MemoryError("invalid_input", `unknown memory command: ${subcommand}`);
}

function runIndex(args: ParsedArgs, json: boolean): number {
	const data = dataDir(args);
	const root = option(args, "repo") ?? process.cwd();
	const path = memoryPath(args);
	const memory = openMemoryDatabase({ path });
	try {
		const summary = new MemoryIndexer(memory, {
			root,
			dataDir: data,
			mode: flag(args, "full") ? "full" : "incremental",
			secretMode: flag(args, "redact-secrets") ? "redact" : "skip",
		}).run();
		if (json) writeJson({ memoryDb: path, ...summary });
		else {
			writeLine(
				`indexed ${summary.sourceCount} sources (${summary.skippedCount} unchanged) in ${summary.endedAt - summary.startedAt}ms`,
			);
			writeLine(
				`status: ${summary.status}; errors: ${summary.errorCount}; file=${summary.counts.file} control=${summary.counts.control}`,
			);
			for (const error of summary.errors)
				writeLine(`  ${error.errorKind}: ${error.sourcePath ?? "-"} ${error.detail}`);
		}
		return 0;
	} finally {
		memory.close();
	}
}

function runStatus(args: ParsedArgs, json: boolean): number {
	const path = memoryPath(args);
	const memory = openReadMemory(args);
	const control = openControl(args);
	try {
		if (!memory) {
			const coverage = syntheticCoverage("memory_db_absent");
			if (json) writeJson({ memoryDb: path, exists: false, coverage });
			else {
				writeLine(`memory: ${path} (absent)`);
				writeCoverage(coverage);
			}
			return 0;
		}
		const service = new MemoryService(memory, { controlReader: control });
		const coverage = service.coverage();
		if (json) writeJson({ memoryDb: path, exists: true, coverage });
		else {
			writeLine(`memory: ${path}`);
			writeCoverage(coverage);
		}
		return 0;
	} finally {
		control?.close();
		memory?.close();
	}
}

function runRecall(args: ParsedArgs, json: boolean): number {
	const query = args.positionals.slice(1).join(" ").trim();
	if (query === "") throw new MemoryError("invalid_input", "memory recall requires a query");
	const trigger = parseTrigger(option(args, "trigger"));
	const kinds = parseKinds(args);
	const memory = openReadMemory(args);
	const control = openControl(args);
	try {
		if (!memory) {
			const result = {
				query,
				items: [],
				coverage: syntheticCoverage("memory_db_absent"),
			};
			if (json) writeJson(result);
			else writeResult(result);
			return 0;
		}
		const service = new MemoryService(memory, { controlReader: control });
		if (trigger) {
			const result = service.retrieveForTrigger(trigger, {
				query,
				files: options(args, "file"),
				limit: limit(args),
			});
			if (json) writeJson(result);
			else {
				writeLine(result.contextBlock);
				writeCoverage(result.result.coverage);
			}
			return 0;
		}
		const result = service.search({ query, kinds, limit: limit(args) });
		if (json) writeJson(result);
		else writeResult(result);
		return 0;
	} finally {
		control?.close();
		memory?.close();
	}
}

function runRead(args: ParsedArgs, json: boolean): number {
	const anchor = requirePositional({ ...args, positionals: args.positionals.slice(1) }, "anchor");
	const memory = openReadMemory(args);
	const control = openControl(args);
	try {
		if (!memory) {
			const result = {
				found: false,
				anchor,
				coverage: syntheticCoverage("memory_db_absent"),
				reason: "not_indexed",
			};
			if (json) writeJson(result);
			else writeResult({ items: [], coverage: result.coverage });
			return 0;
		}
		const service = new MemoryService(memory, { controlReader: control });
		const result = service.read(anchor);
		if (json) writeJson(result);
		else if (!result.found) {
			writeLine(`not indexed: ${anchor}`);
			writeCoverage(result.coverage);
		} else {
			writeLine(`anchor: ${result.item.anchor}`);
			writeLine(`title: ${result.item.title}`);
			writeLine(`source: ${result.item.source.ref}`);
			writeLine(`drill-down: ${JSON.stringify(result.item.drillDown)}`);
			writeLine(
				`stale: ${result.stale}${result.staleReasons.length > 0 ? ` (${result.staleReasons.join(",")})` : ""}`,
			);
			writeLine(
				`redacted: ${result.redacted}${result.redactionFindings.length > 0 ? ` (${result.redactionFindings.join(",")})` : ""}`,
			);
			writeLine("");
			writeLine(result.content);
			writeCoverage(result.coverage);
		}
		return 0;
	} finally {
		control?.close();
		memory?.close();
	}
}

function runDigest(args: ParsedArgs, json: boolean): number {
	const runId = option(args, "run");
	const sessionId = option(args, "session");
	if (!runId && !sessionId) throw new MemoryError("invalid_input", "memory digest requires --run or --session");
	const control = openControl(args);
	try {
		const result = buildSessionDigest({ reader: control, runId, sessionId });
		if (json) writeJson(result);
		else if (!result.found) {
			writeLine(`digest unavailable: ${result.reason}`);
		} else {
			const digest = result.digest;
			writeLine(`run: ${digest.runId ?? "-"} session: ${digest.sessionId} task: ${digest.taskId ?? "-"}`);
			writeLine(`status: ${digest.status} role=${digest.role} provider=${digest.provider} model=${digest.model}`);
			writeLine(
				`events: ${Object.entries(digest.eventCounts)
					.map(([kind, count]) => `${kind}=${count}`)
					.join(" ")}`,
			);
			for (const event of digest.events) writeLine(`  ${event.seq} ${event.kind} ${event.summary}`);
			for (const review of digest.reviews)
				writeLine(`review ${review.id}: ${review.verdict} (${review.findingCount} findings)`);
			for (const verification of digest.verifications) {
				writeLine(`verification ${verification.id}: ${verification.status} ${verification.command ?? ""}`);
			}
			for (const merge of digest.merges) writeLine(`merge ${merge.id}: ${merge.status} ${merge.mergeSha}`);
			writeLine(`sourceRefs: ${digest.sourceRefs.join(",")}`);
		}
		return 0;
	} finally {
		control?.close();
	}
}

function runTrigger(args: ParsedArgs, json: boolean): number {
	const trigger = parseTrigger(args.positionals[1]);
	if (!trigger) throw new MemoryError("invalid_input", "memory trigger requires a trigger name");
	const memory = openReadMemory(args);
	const control = openControl(args);
	try {
		const service = memory ? new MemoryService(memory, { controlReader: control }) : null;
		if (!service) {
			const result = {
				trigger,
				request: { trigger, query: option(args, "query") ?? trigger, kinds: [], limit: 0, rationale: "" },
				result: { query: "", items: [], coverage: syntheticCoverage("memory_db_absent") },
				contextBlock: "## Evidence (indexed_scope_only)\n- memory_db_absent",
			};
			if (json) writeJson(result);
			else writeLine(result.contextBlock);
			return 0;
		}
		const result = service.retrieveForTrigger(trigger, {
			query: option(args, "query"),
			taskTitle: option(args, "task-title"),
			taskWhy: option(args, "task-why"),
			featureId: option(args, "feature"),
			files: options(args, "file"),
			risk: option(args, "risk"),
			headSha: option(args, "head-sha"),
			limit: limit(args),
		});
		if (json) writeJson(result);
		else {
			writeLine(result.contextBlock);
			writeCoverage(result.result.coverage);
		}
		return 0;
	} finally {
		control?.close();
		memory?.close();
	}
}
