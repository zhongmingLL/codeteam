import { describe, expect, it } from "vitest";
import {
	classifyReviewRisk,
	evaluateReviewPolicy,
	MODEL_FAMILIES,
	policyForRisk,
	type ReviewActor,
	type ReviewerContext,
	resolveModelFamily,
} from "../src/review/index.ts";

const author: ReviewActor = {
	sessionId: "session-coder",
	profileId: "profile-coder",
	model: "deepseek-flash",
	modelFamily: "deepseek",
};

const reviewer: ReviewActor = {
	sessionId: "session-reviewer",
	profileId: "profile-reviewer",
	model: "glm-5.3-flash",
	modelFamily: "glm",
};

const freshBlind: ReviewerContext = { fresh: true, blind: true, transcriptExcluded: true };

function context(overrides: Partial<Parameters<typeof evaluateReviewPolicy>[0]> = {}) {
	return {
		risk: "code" as const,
		author,
		reviewer,
		reviewerContext: freshBlind,
		...overrides,
	};
}

describe("W3 review policy", () => {
	it("publishes a controlled model family registry and resolves models without provider identity", () => {
		expect(MODEL_FAMILIES).toEqual(
			expect.arrayContaining(["deepseek", "glm", "kimi", "qwen", "gemini", "openai", "anthropic"]),
		);
		expect(resolveModelFamily("deepseek-flash")).toBe("deepseek");
		expect(resolveModelFamily("openai/gpt-5-codex")).toBe("openai");
		expect(resolveModelFamily("anthropic/claude-opus")).toBe("anthropic");
		expect(resolveModelFamily("glm-5.3-flash")).toBe("glm");
		expect(resolveModelFamily("qwen3.8-flash")).toBe("qwen");
		expect(resolveModelFamily("kimi-k3")).toBe("kimi");
		expect(resolveModelFamily("mystery-model")).toBeNull();
	});

	it("allows cross-family code review with independent profile, session, fresh and blind context", () => {
		const decision = evaluateReviewPolicy(context());
		expect(decision.status).toBe("allowed");
		expect(decision.mode).toBe("cross_family");
		expect(decision.sameFamilyException).toBe(false);
		expect(decision.requiresVerifier).toBe(true);
		expect(decision.requiresHumanGate).toBe(false);
		expect(decision.violations).toEqual([]);
		expect(decision.policy).toEqual(policyForRisk("code"));
	});

	it("rejects same session, same profile, same family, stale context, and leaked transcript", () => {
		expect(
			evaluateReviewPolicy(context({ reviewer: { ...reviewer, sessionId: author.sessionId } })).violations,
		).toContain("same_session");
		expect(
			evaluateReviewPolicy(context({ reviewer: { ...reviewer, profileId: author.profileId } })).violations,
		).toContain("same_profile");

		const sameFamily = evaluateReviewPolicy(
			context({ reviewer: { ...reviewer, model: "deepseek-chat", modelFamily: "deepseek" } }),
		);
		expect(sameFamily.status).toBe("blocked");
		expect(sameFamily.mode).toBeNull();
		expect(sameFamily.violations).toContain("different_model_family_required");

		const stale = evaluateReviewPolicy(
			context({ reviewerContext: { fresh: false, blind: false, transcriptExcluded: false } }),
		);
		expect(stale.status).toBe("blocked");
		expect(stale.violations).toEqual(
			expect.arrayContaining(["fresh_context_required", "blind_context_required", "transcript_not_excluded"]),
		);
	});

	it("allows same-family low-risk docs only with the explicit same_family_fresh mode", () => {
		const decision = evaluateReviewPolicy(
			context({
				risk: "low_risk_docs",
				reviewer: { ...reviewer, model: "glm-5.3-flash", modelFamily: "glm" },
				author: { ...author, model: "glm-5.3-flash", modelFamily: "glm" },
				reviewerContext: { fresh: false, blind: true, transcriptExcluded: true },
			}),
		);
		expect(decision.status).toBe("allowed");
		expect(decision.mode).toBe("same_family_fresh");
		expect(decision.sameFamilyException).toBe(true);

		const sameProfile = evaluateReviewPolicy(
			context({
				risk: "low_risk_docs",
				reviewer: {
					sessionId: "session-reviewer-2",
					profileId: author.profileId,
					model: "glm-5.3-flash",
					modelFamily: "glm",
				},
				reviewerContext: { fresh: false, blind: true, transcriptExcluded: true },
			}),
		);
		expect(sameProfile.status).toBe("blocked");
		expect(sameProfile.violations).toContain("same_profile");
	});

	it("escalates high-risk gaps to human review instead of claiming an independent verdict", () => {
		const sameFamily = evaluateReviewPolicy(
			context({
				risk: "high_risk",
				reviewer: { ...reviewer, model: "deepseek-chat", modelFamily: "deepseek" },
			}),
		);
		expect(sameFamily.status).toBe("human_required");
		expect(sameFamily.requiresHumanGate).toBe(true);

		const stale = evaluateReviewPolicy(
			context({ risk: "high_risk", reviewerContext: { fresh: false, blind: true, transcriptExcluded: true } }),
		);
		expect(stale.status).toBe("human_required");
		expect(stale.requiresHumanGate).toBe(true);
	});

	it("fails closed on unknown or mismatched family claims", () => {
		const unknown = evaluateReviewPolicy(
			context({ reviewer: { ...reviewer, model: "mystery-model", modelFamily: "mystery" } }),
		);
		expect(unknown.status).toBe("blocked");
		expect(unknown.violations.join(" ")).toMatch(/model family/i);

		const mismatch = evaluateReviewPolicy(
			context({ reviewer: { ...reviewer, model: "glm-5.3-flash", modelFamily: "qwen" } }),
		);
		expect(mismatch.status).toBe("blocked");
		expect(mismatch.violations.join(" ")).toMatch(/belongs to|does not match|glm/i);
	});

	it("classifies docs, code, and sensitive changes without letting a caller self-downgrade", () => {
		expect(classifyReviewRisk({ changedFiles: ["docs/plans/0008.md", "README.md"] })).toBe("low_risk_docs");
		expect(classifyReviewRisk({ changedFiles: ["docs/plans/0008.md", "src/a.ts"] })).toBe("code");
		expect(classifyReviewRisk({ changedFiles: ["src/a.ts"], securitySensitive: true })).toBe("high_risk");
		expect(classifyReviewRisk({ changedFiles: ["src/a.ts"], dataSensitive: true })).toBe("high_risk");
	});
});
