export interface ReviewPromptInput {
	diff: string;
	testReport: string;
	constraints: string[];
}

export function buildReviewPrompt(input: ReviewPromptInput): string {
	return [
		"Review the following change.",
		"Return only a JSON object with this exact shape:",
		'{"verdict":"approve|changes_requested|blocked","findings":[{"severity":"P1|P2|P3","file":"path","line":1,"claim":"...","evidenceKind":"red_test|repro_command|static_check|code_reading|judgment","falsifier":"exact command or test name","falsifierExpected":"zero|nonzero","requiredAction":"..."}]}',
		"Rules:",
		"- P1/P2 must include an executable falsifier.",
		'- Set evidenceKind to "static_check" when the falsifier is a grep, rg, diff, ls, or cat command.',
		'- Set evidenceKind to "red_test" when the falsifier runs a test file, and "repro_command" when it runs a reproduction command.',
		"- Do not use code_reading for a finding that has a shell falsifier; code_reading is for findings that cannot be executed.",
		"- For static_check, use `grep -F` with the exact source text quoted in single quotes, for example: grep -F -n 'exact source text' path/to/file.js",
		"- Never leave shell operators such as <, >, ;, |, &, $, or backticks unquoted in a falsifier; the verifier rejects them.",
		'- Use falsifierExpected "nonzero" when the command reproduces the finding (it fails while the finding is present).',
		'- Use falsifierExpected "zero" when the command confirms the finding by succeeding (for example, grep finds the bad line).',
		"- Use one command with no shell composition: no ;, &&, |, redirects, cd, or command substitution.",
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
