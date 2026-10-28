import { ControlError } from "../control/errors.ts";
import type {
	AssuranceLevel,
	DiffFileStat,
	RiskAxis,
	RiskClassification,
	RiskClassificationInput,
	RiskLane,
	RiskMismatch,
} from "./types.ts";

const ASSURANCE_RANK: Record<AssuranceLevel, number> = { light: 0, standard: 1, high: 2, critical: 3 };
const LANE_RANK: Record<RiskLane, number> = { docs: 0, product_fast: 1, small_change: 2, standard: 3 };

const META_PATH =
	/^(packages\/codeteam-daemon\/src\/(?:gates|review|sop|auth|policy|merge)\/|packages\/codeteam-daemon\/src\/control\/migrations\/|scripts\/sop-definitions\.mjs$|\.github\/)/;
const SECURITY_PATH = /(?:^|\/)(?:auth|credentials?|tokens?|secrets?|sandbox|policy)(?:\/|\.|$)/i;
const DATA_PATH = /(?:^|\/)(?:migrations?|\.sql$|database\.ts$)/i;
const CONTRACT_PATH =
	/^(packages\/codeteam-daemon\/src\/(?:cli(?:\.ts|\/)|control\/|index\.ts$)|packages\/[^/]+\/package\.json$|sop-definitions\/|package\.json$|tsconfig|test\.sh$)/;
const BEHAVIOR_PATH = /^(packages\/[^/]+\/src\/|apps\/|scripts\/)/;
const DOCS_PATH = /^(?:docs\/|.*\.md$|LICENSE(?:\.|$)|CHANGELOG(?:\.|$)|UPSTREAM\.md$|KERNEL_GAPS\.md$)/i;

function normalizePath(value: string): string {
	const path = value.trim().replace(/\\/g, "/");
	if (path === "" || path.startsWith("/") || path.split("/").includes("..")) {
		throw new ControlError("invalid_input", `diff path must be worktree-relative: ${value}`);
	}
	return path;
}

function addAxis(axes: Set<RiskAxis>, axis: RiskAxis, reasons: string[], reason: string): void {
	if (!axes.has(axis)) {
		axes.add(axis);
		reasons.push(reason);
	}
}

function atLeast(current: AssuranceLevel, minimum: AssuranceLevel): AssuranceLevel {
	return ASSURANCE_RANK[current] >= ASSURANCE_RANK[minimum] ? current : minimum;
}

function classifyPaths(files: readonly DiffFileStat[]): {
	axes: Set<RiskAxis>;
	reasons: string[];
	docsOnly: boolean;
} {
	const axes = new Set<RiskAxis>();
	const reasons: string[] = [];
	let docsOnly = true;
	for (const file of files) {
		const path = normalizePath(file.path);
		if (!DOCS_PATH.test(path)) docsOnly = false;
		if (META_PATH.test(path)) {
			addAxis(axes, "contract", reasons, `meta/harness path: ${path}`);
			addAxis(axes, "behavior", reasons, `meta/harness path: ${path}`);
		}
		if (SECURITY_PATH.test(path)) addAxis(axes, "security", reasons, `security boundary: ${path}`);
		if (DATA_PATH.test(path)) addAxis(axes, "data", reasons, `persistence/migration: ${path}`);
		if (CONTRACT_PATH.test(path)) addAxis(axes, "contract", reasons, `public/control contract: ${path}`);
		if (BEHAVIOR_PATH.test(path)) addAxis(axes, "behavior", reasons, `runtime behavior: ${path}`);
	}
	if (!docsOnly) addAxis(axes, "behavior", reasons, "code or executable file changed");
	return { axes, reasons, docsOnly };
}

export function classifyRisk(input: RiskClassificationInput): RiskClassification {
	if (!Array.isArray(input.changedFiles)) throw new ControlError("invalid_input", "changedFiles must be an array");
	const files = input.changedFiles.map((file) => {
		if (!Number.isSafeInteger(file.additions) || file.additions < 0) {
			throw new ControlError("invalid_input", "diff additions must be non-negative integers");
		}
		if (!Number.isSafeInteger(file.deletions) || file.deletions < 0) {
			throw new ControlError("invalid_input", "diff deletions must be non-negative integers");
		}
		return { path: normalizePath(file.path), additions: file.additions, deletions: file.deletions };
	});
	const additions = files.reduce((total, file) => total + file.additions, 0);
	const deletions = files.reduce((total, file) => total + file.deletions, 0);
	const changedLines = additions + deletions;
	const { axes: pathAxes, reasons, docsOnly } = classifyPaths(files);
	const axes = new Set<RiskAxis>(pathAxes);
	for (const axis of input.declaredAxes ?? []) addAxis(axes, axis, reasons, `declared axis: ${axis}`);
	if (input.irreversible) addAxis(axes, "irreversible", reasons, "operation declared irreversible");
	if (files.length === 0) reasons.push("empty diff");

	let assurance: AssuranceLevel = "light";
	if (axes.has("irreversible")) assurance = "critical";
	else if ([...axes].some((axis) => axis === "security" || axis === "data" || axis === "contract")) assurance = "high";
	else if (axes.has("behavior")) assurance = "standard";
	if (files.some((file) => META_PATH.test(file.path))) assurance = "critical";
	if (changedLines > 1200 || files.length > 40) assurance = atLeast(assurance, "high");
	if (changedLines > 3000 || files.length > 100) assurance = atLeast(assurance, "critical");

	let lane: RiskLane;
	if (docsOnly && axes.size === 0) lane = "docs";
	else if (assurance === "high" || assurance === "critical") lane = "standard";
	else if (axes.size === 1 && axes.has("behavior") && changedLines <= 200 && files.length <= 8) lane = "product_fast";
	else if (axes.size === 1 && axes.has("behavior") && changedLines <= 400 && files.length <= 15) lane = "small_change";
	else lane = "standard";

	const mismatches: RiskMismatch[] = [];
	if (input.declaredAssurance && ASSURANCE_RANK[input.declaredAssurance] < ASSURANCE_RANK[assurance]) {
		mismatches.push({
			code: "declared_assurance_understated",
			severity: "P1",
			message: `declared assurance ${input.declaredAssurance} is lower than computed ${assurance}`,
		});
	}
	if (input.declaredLane && LANE_RANK[input.declaredLane] < LANE_RANK[lane]) {
		mismatches.push({
			code: "declared_lane_understated",
			severity: "P1",
			message: `declared lane ${input.declaredLane} is lower than computed ${lane}`,
		});
	}
	const declaredAxes = new Set(input.declaredAxes ?? []);
	for (const axis of axes) {
		if (!declaredAxes.has(axis)) {
			mismatches.push({
				code: "declared_axes_incomplete",
				severity: "P2",
				message: `computed risk axis ${axis} was not declared`,
			});
		}
	}
	return {
		axes: [...axes],
		assurance,
		lane,
		changedFiles: files.length,
		additions,
		deletions,
		reasons,
		mismatches,
	};
}

export function parseGitNumstat(output: string): DiffFileStat[] {
	const files: DiffFileStat[] = [];
	for (const line of output.split(/\r?\n/)) {
		if (line.trim() === "") continue;
		const parts = line.split("\t");
		if (parts.length < 3) throw new ControlError("invalid_input", `malformed git numstat line: ${line}`);
		const additions = Number(parts[0]);
		const deletions = Number(parts[1]);
		if (!Number.isSafeInteger(additions) || !Number.isSafeInteger(deletions)) {
			throw new ControlError("invalid_input", `binary diff is not supported in risk classification: ${line}`);
		}
		files.push({ path: parts[2]!, additions, deletions });
	}
	return files;
}
