import { describe, expect, it } from "vitest";
import { canonicalModel } from "./model.ts";

describe("canonicalModel", () => {
	it("merges the hyphenated and dated Anthropic spellings into the dotted id", () => {
		expect(canonicalModel("claude-opus-5-5")).toBe("claude-opus-5.5");
		expect(canonicalModel("claude-opus-5.5")).toBe("claude-opus-5.5");
		expect(canonicalModel("claude-fable-5-1")).toBe("claude-fable-5.1");
		expect(canonicalModel("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4.5");
		expect(canonicalModel("claude-haiku-4-5-20251001")).toBe("claude-haiku-4.5");
		expect(canonicalModel("claude-opus-4-20250514")).toBe("claude-opus-4");
	});

	it("leaves every other id alone", () => {
		for (const id of ["claude-opus-5", "gpt-5.6-sol", "gpt-6-sol", "kimi-k2.7-code", "mai-code-1-flash-picker", "grok-4.7", "stub-echo", ""]) {
			expect(canonicalModel(id)).toBe(id);
		}
	});
});
