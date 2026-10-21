import { spawnSync } from "node:child_process";
import type { ReviewFinding, ReviewVerdict } from "../review/types.ts";
import { CommandPolicy } from "./policy.ts";
import type {
	FalsifierAuditRecord,
	FalsifierMode,
	FindingVerification,
	ParsedCommand,
	VerificationStatus,
	VerifierOptions,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 8_192;

function truncateTail(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text);
	if (buffer.length <= maxBytes) return text;
	return buffer.subarray(buffer.length - maxBytes).toString("utf8");
}

function blocked(
	index: number,
	finding: ReviewFinding,
	options: VerifierOptions,
	reason: string,
	command?: ParsedCommand,
): FindingVerification {
	const mode: FalsifierMode = options.mode ?? "strict";
	const audit: FalsifierAuditRecord = {
		index,
		finding,
		mode,
		cwd: options.workdir,
		command: finding.falsifier,
		...(finding.falsifierExpected === undefined ? {} : { expected: finding.falsifierExpected }),
		status: "blocked",
		reason,
		...(command === undefined ? {} : { executable: command.executable, args: command.args }),
	};
	return { finding, status: "blocked", reason, audit };
}

export function verifyFinding(finding: ReviewFinding, index: number, options: VerifierOptions): FindingVerification {
	const expected = finding.falsifierExpected;
	if (expected === undefined) {
		return blocked(index, finding, options, "finding has no falsifierExpected");
	}
	if (finding.evidenceKind === "judgment" || finding.evidenceKind === "code_reading") {
		return blocked(index, finding, options, "evidence kind is not executable");
	}
	if (finding.falsifier.trim().length === 0) {
		return blocked(index, finding, options, "finding has no falsifier");
	}

	const mode: FalsifierMode = options.mode ?? "strict";
	const policy = new CommandPolicy(options.workdir, mode);
	const decision = policy.evaluate(finding.falsifier, options.workdir);
	if (!decision.allowed || decision.command === undefined) {
		return blocked(index, finding, options, decision.reason, decision.command);
	}

	const startedAt = Date.now();
	const outputLimitBytes = options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;
	const result = spawnSync(decision.command.executable, decision.command.args, {
		cwd: options.workdir,
		encoding: "utf8",
		timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		maxBuffer: Math.max(outputLimitBytes * 4, 1_000_000),
		shell: false,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: options.workdir,
			LANG: process.env.LANG ?? "C.UTF-8",
			LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
		},
	});
	const durationMs = Date.now() - startedAt;
	if (result.error !== undefined) {
		return blocked(index, finding, options, `execution failed: ${result.error.message}`, decision.command);
	}
	if (result.signal !== null) {
		return blocked(index, finding, options, `execution terminated by ${result.signal}`, decision.command);
	}

	const exitCode = result.status ?? -1;
	const status: VerificationStatus =
		expected === "zero" ? (exitCode === 0 ? "confirmed" : "rejected") : exitCode !== 0 ? "confirmed" : "rejected";
	const reason = `exit ${exitCode}, expected ${expected}`;
	const audit: FalsifierAuditRecord = {
		index,
		finding,
		mode,
		cwd: options.workdir,
		command: finding.falsifier,
		expected,
		status,
		reason,
		executable: decision.command.executable,
		args: decision.command.args,
		exitCode,
		durationMs,
		stdoutTail: truncateTail(result.stdout ?? "", outputLimitBytes),
		stderrTail: truncateTail(result.stderr ?? "", outputLimitBytes),
	};
	return { finding, status, reason, audit };
}

export function verifyVerdict(verdict: ReviewVerdict, options: VerifierOptions): FindingVerification[] {
	return verdict.findings.map((finding, index) => verifyFinding(finding, index, options));
}
