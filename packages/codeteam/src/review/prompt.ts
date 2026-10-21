export interface ReviewPromptInput {
	diff: string;
	testReport: string;
	constraints: string[];
}

export function buildReviewPrompt(input: ReviewPromptInput): string {
	return [
		"Review the following change.",
		"Return only a JSON object with this exact shape:",
		'{"verdict":"approve|changes_requested|blocked","findings":[{"severity":"P1|P2|P3","file":"path","line":1,"claim":"...","evidenceKind":"red_test|repro_command|static_check|code_reading|judgment","falsifier":"exact command or test name","requiredAction":"..."}]}',
		"Rules:",
		"- P1/P2 must include an executable falsifier.",
		"- If you cannot substantiate a finding, use P3.",
		"- Do not modify files.",
		"- The test file must not be modified.",
		`Constraints: ${input.constraints.join("; ")}`,
		"Diff:",
		"```diff",
		input.diff,
		"```",
		"Test report:",
		"```text",
		input.testReport,
		"```",
	].join("\n");
}
