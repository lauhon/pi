import { describe, expect, it } from "vitest";
import { SessionBuilder } from "../fixtures/build.ts";
import { SHAPES } from "../fixtures/shapes.ts";
import { parseSession } from "./load.ts";
import {
	THRESHOLDS,
	classifyFollowUp,
	directorySummary,
	endsWithQuestion,
	isCorrectionText,
	isMissingPathError,
	isTestCommand,
	sessionSummary,
	turnObservables,
	type TurnObservables,
} from "./observables.ts";

function load(name: keyof typeof SHAPES) {
	return parseSession(SHAPES[name]().toJsonl(), `${name}.jsonl`);
}

function turns(name: keyof typeof SHAPES): TurnObservables[] {
	return turnObservables(load(name));
}

describe("tables", () => {
	it("recognizes missing-path errors and nothing else", () => {
		expect(isMissingPathError("ENOENT: no such file or directory, open '/x'")).toBe(true);
		expect(isMissingPathError("EISDIR: illegal operation on a directory, read")).toBe(true);
		expect(isMissingPathError("ls: cannot access '/x': No such file or directory")).toBe(true);
		expect(isMissingPathError("Could not find the exact text in /x. The old text must match exactly")).toBe(false);
		expect(isMissingPathError("Command failed with exit code 1")).toBe(false);
	});

	it("recognizes test runners by word", () => {
		for (const command of ["npm test", "npm run test -- --watch=false", "npx vitest run tools", "pnpm test", "bun test", "go test ./...", "cargo test", "pytest -q", "jest src"]) {
			expect(isTestCommand(command), command).toBe(true);
		}
		for (const command of ["npm run build", "ls tests", "cargo build", "echo vitesting"]) expect(isTestCommand(command), command).toBe(false);
	});

	it("recognizes short corrections by their opening words", () => {
		expect(isCorrectionText("No, I meant the other file")).toBe(true);
		expect(isCorrectionText("actually, use the second one")).toBe(true);
		expect(isCorrectionText("That's not what I asked")).toBe(true);
		expect(isCorrectionText("Thanks, looks good")).toBe(false);
		expect(isCorrectionText("Notice the test")).toBe(false);
		expect(isCorrectionText(`No. ${"x".repeat(THRESHOLDS.correctionMaxChars)}`)).toBe(false);
		expect(isCorrectionText("")).toBe(false);
	});

	it("sees a question at the end of visible text", () => {
		expect(endsWithQuestion("Should I revert?")).toBe(true);
		expect(endsWithQuestion("Should I revert?**")).toBe(true);
		expect(endsWithQuestion("Should I revert? \n")).toBe(true);
		expect(endsWithQuestion("Done.")).toBe(false);
		expect(endsWithQuestion("Why? Because.")).toBe(false);
	});
});

describe("turnObservables", () => {
	it("counts tool calls, files and the final text per turn, skipping an empty turn 0", () => {
		const result = turns("linear");
		expect(result.map((turn) => turn.turnIndex)).toEqual([1, 2]);
		expect(result[0]).toMatchObject({ requests: 1, toolCalls: 0, narrationOnly: true, askedQuestion: false, finalTextChars: "It parses session files.".length });
		expect(result[1]).toMatchObject({ requests: 2, toolCalls: 1, toolCallsByName: { read: 1 }, filesRead: ["/repo/src/load.ts"], filesEdited: [], testsRun: 0, toolErrors: 0, narrationOnly: false });
		expect(result[1].cost).toBeCloseTo(load("linear").requestPoints[1].usage.cost + load("linear").requestPoints[2].usage.cost, 8);
		expect(result[1].peakContextTokens).toBe(4300);
		expect(result[1].models).toEqual(["gpt-5.6-terra"]);
	});

	it("flags a correction after a long turn, a closing question and a narration-only turn", () => {
		const result = turns("correctionTurn");
		expect(result[0]).toMatchObject({ toolCalls: 3, correctionTurn: false, askedQuestion: false, staleFilesInContext: ["/repo/src/a.ts"], textBeforeFirstTool: 0 });
		expect(result[1]).toMatchObject({ correctionTurn: true, askedQuestion: true, narrationOnly: false, userChars: "No, I meant the helper in b.ts, not a.ts".length });
		expect(result[1].staleFilesInContext).toEqual(["/repo/src/a.ts", "/repo/src/b.ts"]);
		expect(result[2]).toMatchObject({ correctionTurn: false, narrationOnly: true, askedQuestion: false, toolCalls: 0 });
		expect(turns("linear").every((turn) => !turn.correctionTurn && !turn.askedQuestion)).toBe(true);
	});

	it("does not flag a correction after a short turn", () => {
		const b = new SessionBuilder();
		b.user("Hi");
		b.assistant({ text: "Hello" });
		b.user("No, I meant goodbye");
		b.assistant({ text: "Goodbye" });
		const result = turnObservables(parseSession(b.toJsonl(), "s.jsonl"));
		expect(result[1].correctionTurn).toBe(false);
	});

	it("counts edit churn and test runs", () => {
		const result = turns("editChurn");
		expect(result[0]).toMatchObject({ editChurn: 2, testsRun: 1, filesEdited: ["/repo/README.md"], toolCalls: 3 });
		expect(turns("staleRead")[0].editChurn).toBe(0);
		expect(turns("staleRead")[1].testsRun).toBe(1);
		expect(turns("linear").every((turn) => turn.editChurn === 0 && turn.testsRun === 0)).toBe(true);
	});

	it("counts long and very long responses per assistant message", () => {
		const result = turns("longResponses");
		expect(result.map((turn) => [turn.longResponses, turn.veryLongResponses])).toEqual([
			[1, 0],
			[1, 1],
			[0, 0],
		]);
		expect(result[2].finalTextChars).toBe(1999);
	});

	it("counts aborted and errored requests, failed commands and cache drops", () => {
		const result = turns("abortedAndCacheDrop");
		expect(result[0]).toMatchObject({ aborted: 1, requests: 1 });
		expect(Number.isNaN(result[0].cacheHitRatioMin)).toBe(true);
		expect(result[1]).toMatchObject({ aborted: 1, toolErrors: 1, toolErrorsByName: { bash: 1 }, missingPathErrors: 0, cacheDrops: 1, cacheHitRatioMin: 0 });
		expect(result[2]).toMatchObject({ aborted: 0, cacheDrops: 0 });
		expect(result[2].cacheHitRatioMin).toBeCloseTo(9000 / 11000, 6);
		expect(turns("linear").every((turn) => turn.aborted === 0 && turn.cacheDrops === 0)).toBe(true);
	});

	it("counts tool errors, error runs, missing paths and identical retries", () => {
		const result = turns("toolErrors");
		expect(result[0]).toMatchObject({
			toolErrors: 2,
			toolErrorsByName: { read: 2 },
			errorRunMax: 2,
			missingPathErrors: 2,
			repeatedErrorText: 1,
			repeatedIdenticalCalls: 1,
			immediateRepeats: 1,
			errorFollowUps: { identical: 1, sameTarget: 0, otherTarget: 0, otherTool: 1, none: 0 },
			toolCalls: 4,
		});
		expect(result[0].filesRead).toEqual(["/repo/docs/adr-001.md", "/repo/docs/0001-record.md"]);
		expect(turns("linear")[1]).toMatchObject({ toolErrors: 0, errorRunMax: 0, missingPathErrors: 0, repeatedIdenticalCalls: 0, immediateRepeats: 0 });
	});

	it("does not call a repeat immediate when a user message sits between the two calls", () => {
		const b = new SessionBuilder();
		b.user("read a");
		b.toolTurn("read", { path: "/a" }, "a");
		b.assistant({ text: "done" });
		b.user("read it again");
		b.toolTurn("read", { path: "/a" }, "a");
		b.assistant({ text: "done again" });
		const result = turnObservables(parseSession(b.toJsonl(), "again.jsonl"));
		expect(result[1]).toMatchObject({ repeatedIdenticalCalls: 1, immediateRepeats: 0 });
	});

	it("counts an immediate repeat of a successful call without any error follow-up", () => {
		const b = new SessionBuilder();
		b.user("status");
		b.toolTurn("bash", { command: "git status" }, "clean");
		b.toolTurn("bash", { command: "git status" }, "clean");
		b.assistant({ text: "clean twice" });
		const result = turnObservables(parseSession(b.toJsonl(), "twice.jsonl"));
		expect(result[0]).toMatchObject({ repeatedIdenticalCalls: 1, immediateRepeats: 1, errorFollowUps: { identical: 0, sameTarget: 0, otherTarget: 0, otherTool: 0, none: 0 } });
	});

	it("classifies what followed each error: same file variant, other path, other tool, nothing", () => {
		const b = new SessionBuilder();
		b.user("fix it");
		b.toolTurn("edit", { path: "/a.ts", oldText: "x", newText: "y" }, "Could not find the exact text in /a.ts", { isError: true });
		b.toolTurn("edit", { path: "/a.ts", oldText: "xx", newText: "y" }, "Edited /a.ts");
		b.toolTurn("read", { path: "/docs/adr-1.md" }, "ENOENT: no such file or directory", { isError: true });
		b.toolTurn("read", { path: "/docs/adr-001.md" }, "ENOENT: no such file or directory", { isError: true });
		b.toolTurn("bash", { command: "ls /docs" }, "adr.md");
		b.toolTurn("bash", { command: "npm test" }, "Command failed with exit code 1", { isError: true });
		b.assistant({ text: "The tests fail; should I continue?" });
		const result = turnObservables(parseSession(b.toJsonl(), "follow.jsonl"));
		expect(result[0].errorFollowUps).toEqual({ identical: 0, sameTarget: 1, otherTarget: 1, otherTool: 1, none: 1 });
		expect(result[0].missingPathFollowUps).toEqual({ identical: 0, sameTarget: 0, otherTarget: 1, otherTool: 1, none: 0 });
		expect(result[0].toolErrors).toBe(4);
		const aborted = turns("abortedAndCacheDrop");
		expect(aborted[1].errorFollowUps).toEqual({ identical: 0, sameTarget: 0, otherTarget: 0, otherTool: 0, none: 1 });
	});

	it("classifyFollowUp picks the closest match among parallel calls", () => {
		const failed = { id: "c1", name: "read", argsHash: "h1", path: "/a", args: { path: "/a" } };
		const identical = { id: "c2", name: "read", argsHash: "h1", path: "/a", args: { path: "/a" } };
		const variant = { id: "c3", name: "read", argsHash: "h2", path: "/a", args: { path: "/a", offset: 10 } };
		const other = { id: "c4", name: "read", argsHash: "h3", path: "/b", args: { path: "/b" } };
		const ls = { id: "c5", name: "bash", argsHash: "h4", args: { command: "ls" } };
		expect(classifyFollowUp(failed, [])).toBe("none");
		expect(classifyFollowUp(failed, [ls])).toBe("otherTool");
		expect(classifyFollowUp(failed, [ls, other])).toBe("otherTarget");
		expect(classifyFollowUp(failed, [other, variant])).toBe("sameTarget");
		expect(classifyFollowUp(failed, [variant, identical])).toBe("identical");
		const command = { id: "c6", name: "bash", argsHash: "h4", args: { command: "ls" } };
		expect(classifyFollowUp(command, [{ ...ls, argsHash: "h9", args: { command: "ls -la" } }])).toBe("otherTarget");
	});

	it("tells an identical call apart from an immediate repeat", () => {
		const b = new SessionBuilder();
		b.user("go");
		b.toolTurn("read", { path: "/a" }, "a");
		b.toolTurn("read", { path: "/b" }, "b");
		b.toolTurn("read", { path: "/a" }, "a");
		b.assistant({ text: "done" });
		const result = turnObservables(parseSession(b.toJsonl(), "r.jsonl"));
		expect(result[0]).toMatchObject({ repeatedIdenticalCalls: 1, immediateRepeats: 0 });
	});

	it("sees a read repeated after a compaction, but not one before it", () => {
		const result = turns("compaction");
		expect(result.map((turn) => turn.rereadAfterCompaction)).toEqual([0, 0, 1]);
		expect(result[2]).toMatchObject({ repeatedIdenticalCalls: 1, immediateRepeats: 0 });
		expect(turns("compactionRetainNone").every((turn) => turn.rereadAfterCompaction === 0)).toBe(true);
	});

	it("reports a read result left in context after a later edit, evaluated at the turn's last request", () => {
		const result = turns("staleRead");
		expect(result[0].staleFilesInContext).toEqual(["/repo/src/a.ts"]);
		expect(result[1].staleFilesInContext).toEqual(["/repo/src/a.ts"]);
		expect(turns("linear").every((turn) => turn.staleFilesInContext.length === 0)).toBe(true);
		const edited = load("contextEdit");
		expect(turnObservables(edited).every((turn) => turn.staleFilesInContext.length === 0)).toBe(true);
	});

	it("counts rewinds as abandoned branches and branch summaries separately", () => {
		expect(turns("fork")[0]).toMatchObject({ rewinds: 1, branchSummaries: 0 });
		expect(turns("rewindWithSummary")[0]).toMatchObject({ rewinds: 1, branchSummaries: 1 });
		expect(turns("linear").every((turn) => turn.rewinds === 0)).toBe(true);
	});

	it("counts model and thinking changes and injections in the turn they happened", () => {
		const result = turns("modelChange");
		expect(result[0]).toMatchObject({ modelChanges: 1, thinkingChanges: 1 });
		expect(result[1]).toMatchObject({ modelChanges: 0, thinkingChanges: 0, models: ["gpt-5.6-sol"] });
		const injected = turns("injections");
		expect(injected[0].injections).toEqual({ "subagents-monitor": "Child worker finished: out-1.md".length });
		expect(injected[1].injections).toEqual({});
	});

	it("measures text before the first tool call across the turn", () => {
		const b = new SessionBuilder();
		b.user("go");
		b.assistant({ text: "Let me look.", toolCalls: [{ name: "read", args: { path: "/a" } }] });
		b.toolResult({ callId: "call_1", name: "read", text: "a" });
		b.assistant({ text: "Now editing.", toolCalls: [{ name: "edit", args: { path: "/a", oldText: "a", newText: "b" } }] });
		b.toolResult({ callId: "call_2", name: "edit", text: "ok" });
		b.assistant({ text: "Done." });
		const result = turnObservables(parseSession(b.toJsonl(), "t.jsonl"));
		expect(result[0].textBeforeFirstTool).toBe("Let me look.".length);
		expect(turns("correctionTurn")[2].textBeforeFirstTool).toBe("Reverting now, this takes one edit.".length);
	});
});

describe("sessionSummary", () => {
	it("totals the turns and describes cost, models and findings", () => {
		const summary = sessionSummary(load("toolErrors"));
		expect(summary).toMatchObject({ turns: 1, requests: 5, toolCalls: 4, toolErrors: 2, missingPathErrors: 2, failedCommands: 0, immediateRepeats: 1, repeatedIdenticalCalls: 1, errorRunMax: 2, compactions: 0, forks: 0 });
		expect(summary.errorFollowUps).toEqual({ identical: 1, sameTarget: 0, otherTarget: 0, otherTool: 1, none: 0 });
		expect(summary.missingPathFollowUps).toEqual(summary.errorFollowUps);
		expect(summary.modelMix).toEqual([{ model: "gpt-5.6-terra", requests: 5, cost: summary.cost, outputTokens: 500 }]);
		expect(summary.topRequestCostShare).toBeCloseTo(0.2, 6);
		expect(summary.top5RequestCostShare).toBeCloseTo(1, 6);
		expect(summary.findings.map((finding) => finding.kind)).toEqual(["repeated_identical_call", "error_follow_up", "missing_path_error"]);
		expect(summary.findings[0].evidence).toEqual(["e2"]);
	});

	it("includes compaction cost and tokens, and reports an error run only from three errors", () => {
		const b = new SessionBuilder();
		b.user("go");
		for (let i = 0; i < 3; i++) b.toolTurn("read", { path: `/missing-${i}` }, `ENOENT: no such file or directory, open '/missing-${i}'`, { isError: true });
		b.assistant({ text: "Giving up." });
		b.compaction({ summary: "s", firstKeptEntryId: null, tokensBefore: 120_000, usage: { input: 1000, output: 100, cost: 0.5 } });
		b.usage("cache_warm", "github-copilot", "gpt-5.6-terra", { input: 0, output: 0, cacheRead: 50_000, cost: 0.015 });
		b.user("next");
		b.assistant({ text: "ok", usage: { input: 250_000 } });
		const summary = sessionSummary(parseSession(b.toJsonl(), "e.jsonl"));
		expect(summary.errorRunMax).toBe(3);
		expect(summary.otherCost).toBeCloseTo(0.515, 6);
		expect(summary.compactionTokensBefore).toEqual([120_000]);
		expect(summary.peakContextTokens).toBe(250_000);
		expect(summary.findings.map((finding) => finding.kind)).toEqual(["error_run", "error_follow_up", "missing_path_error", "compaction", "large_context"]);
		expect(summary.errorFollowUps).toEqual({ identical: 0, sameTarget: 0, otherTarget: 2, otherTool: 0, none: 1 });
		const twoErrors = sessionSummary(load("toolErrors"));
		expect(twoErrors.findings.some((finding) => finding.kind === "error_run")).toBe(false);
	});

	it("counts questions, narration, corrections, rewinds, aborted and cache statistics", () => {
		expect(sessionSummary(load("correctionTurn"))).toMatchObject({ askedQuestions: 1, narrationOnlyTurns: 1, correctionTurns: 1, staleFileTurns: 3 });
		expect(sessionSummary(load("rewindWithSummary"))).toMatchObject({ rewinds: 1, branchSummaries: 1, forks: 1 });
		const aborted = sessionSummary(load("abortedAndCacheDrop"));
		expect(aborted).toMatchObject({ aborted: 2, cacheDrops: 1, failedCommands: 1, toolErrors: 1 });
		expect(aborted.cacheHitRatioMean).toBeCloseTo((0.9 + 0 + 9000 / 11000) / 3, 6);
		expect(sessionSummary(load("modelChange"))).toMatchObject({ modelChanges: 1, thinkingChanges: 2 });
		expect(sessionSummary(load("longResponses"))).toMatchObject({ longResponses: 2, veryLongResponses: 1 });
	});
});

describe("directorySummary", () => {
	it("computes the audit's quantitative section over sessions", () => {
		const summaries = [load("toolErrors"), load("abortedAndCacheDrop"), load("longResponses"), load("compaction")].map(sessionSummary);
		const result = directorySummary(summaries);
		expect(result.sessions).toBe(4);
		expect(result.requests).toBe(summaries.reduce((sum, summary) => sum + summary.requests, 0));
		expect(result.cost).toBeCloseTo(summaries.reduce((sum, summary) => sum + summary.cost, 0), 8);
		const sorted = summaries.map((summary) => summary.cost).sort((a, b) => b - a);
		expect(result.topSessionCostShare).toBeCloseTo(sorted[0] / result.cost, 8);
		expect(result.top5SessionCostShare).toBeCloseTo(1, 8);
		expect(result.modelMix).toHaveLength(1);
		expect(result.modelMix[0]).toMatchObject({ model: "gpt-5.6-terra", requests: result.requests, requestShare: 1, costShare: 1 });
		expect(result).toMatchObject({ toolErrors: 3, toolErrorsByName: { read: 2, bash: 1 }, missingPathErrors: 2, failedCommands: 1, immediateRepeats: 1, repeatedIdenticalCalls: 2, compactions: 1, peakContextTokens: 70_000, longResponses: 2, veryLongResponses: 1, aborted: 2 });
		expect(result.errorFollowUps).toEqual({ identical: 1, sameTarget: 0, otherTarget: 0, otherTool: 1, none: 1 });
		expect(result.missingPathFollowUps).toEqual({ identical: 1, sameTarget: 0, otherTarget: 0, otherTool: 1, none: 0 });
		expect(result.sessionsBySize[0].path).toBe("compaction.jsonl");
		expect(directorySummary([])).toMatchObject({ sessions: 0, requests: 0, cost: 0, topSessionCostShare: 0, modelMix: [] });
	});
});
