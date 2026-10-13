import { describe, expect, it } from "vitest";
import { SessionBuilder } from "../fixtures/build.ts";
import { SHAPES } from "../fixtures/shapes.ts";
import { LABEL_TARGET, LEVELS, excerpt, labelEvidence, labelRecord, labelReport, labelTurns, parseLabels, turnFlags } from "./labels.ts";
import { parseSession } from "./load.ts";
import { turnObservables } from "./observables.ts";

function load(name: keyof typeof SHAPES) {
	return parseSession(SHAPES[name]().toJsonl(), `${name}.jsonl`);
}

function evidenceOf(b: SessionBuilder) {
	const session = parseSession(b.toJsonl(), "built.jsonl");
	return labelEvidence(session, turnObservables(session));
}

function evidence(name: keyof typeof SHAPES) {
	return evidenceOf(SHAPES[name]());
}

describe("parseLabels", () => {
	it("keeps records that name a session and an outcome, and names every problem", () => {
		const text = JSON.stringify([
			{ session: "a.jsonl", outcome: "bad", earliestSaveTurn: 3, level: "prompt", note: "asked for an assessment, agent edited" },
			{ session: "b.jsonl", outcome: "good" },
			{ session: "c.jsonl", outcome: "bad" },
			{ session: "d.jsonl", outcome: "mixed", level: "promt", earliestSaveTurn: -1, note: 5, extra: true },
			{ session: "", outcome: "good" },
			{ session: "a.jsonl", outcome: "good" },
			"x",
			{ session: "e.jsonl", outcome: "fine" },
		]);
		const { labels, problems } = parseLabels(text);
		expect(labels.map((label) => label.session)).toEqual(["a.jsonl", "b.jsonl", "c.jsonl", "d.jsonl"]);
		expect(labels[0]).toEqual({ session: "a.jsonl", outcome: "bad", earliestSaveTurn: 3, level: "prompt", note: "asked for an assessment, agent edited" });
		expect(labels[3]).toEqual({ session: "d.jsonl", outcome: "mixed" });
		expect(problems).toEqual([
			'record 2 (c.jsonl): a bad session needs "earliestSaveTurn"',
			'record 2 (c.jsonl): a bad session needs "level"',
			'record 3 (d.jsonl): unknown key "extra"',
			'record 3 (d.jsonl): "earliestSaveTurn" must be a turn index (an integer, 0 or more)',
			`record 3 (d.jsonl): "level" must be one of ${LEVELS.join(", ")}`,
			'record 3 (d.jsonl): "note" must be a string',
			'record 4: "session" must be a non-empty string',
			"record 5 (a.jsonl): labeled twice",
			"record 6: not an object",
			'record 7 (e.jsonl): "outcome" must be one of good, bad, mixed',
		]);
	});

	it("rejects anything but an array of records", () => {
		expect(parseLabels("{").problems[0]).toMatch(/^not JSON/);
		expect(parseLabels("{}").problems).toEqual(["the file must hold an array of records"]);
		expect(parseLabels("[]")).toEqual({ labels: [], problems: [] });
	});
});

describe("labelReport", () => {
	it("counts outcomes, clusters by level and states the done-when", () => {
		const parsed = parseLabels(
			JSON.stringify([
				{ session: "a", outcome: "bad", earliestSaveTurn: 2, level: "prompt" },
				{ session: "b", outcome: "bad", earliestSaveTurn: 1, level: "prompt" },
				{ session: "c", outcome: "mixed", level: "process" },
				{ session: "d", outcome: "good" },
				{ session: "e", outcome: "bad" },
			]),
		);
		const report = labelReport(parsed);
		expect(report).toMatchObject({ count: 5, byOutcome: { good: 1, bad: 3, mixed: 1 }, target: LABEL_TARGET, incomplete: ["e"], done: false });
		expect(report.clusters).toEqual([
			{ level: "prompt", bad: 2, mixed: 0, good: 0, total: 2 },
			{ level: "none", bad: 1, mixed: 0, good: 1, total: 2 },
			{ level: "process", bad: 0, mixed: 1, good: 0, total: 1 },
		]);
		expect(report.problems).toHaveLength(2);
	});

	it("checks the labels against the loaded sessions", () => {
		const parsed = parseLabels(JSON.stringify([{ session: "a", outcome: "bad", earliestSaveTurn: 9, level: "habit" }, { session: "zz", outcome: "good" }]));
		const report = labelReport(parsed, (session) => (session === "a" ? 3 : undefined));
		expect(report.problems).toEqual(["a: earliestSaveTurn 9 is past the last turn (3)", "zz: not found under the given directories"]);
		expect(labelReport(parsed).problems).toEqual([]);
	});

	it("is done at the target with nothing incomplete", () => {
		const records = Array.from({ length: LABEL_TARGET }, (_, i) => ({ session: `s${i}`, outcome: "good" }));
		expect(labelReport(parseLabels(JSON.stringify(records))).done).toBe(true);
		expect(labelReport(parseLabels(JSON.stringify(records.slice(1)))).done).toBe(false);
		expect(labelReport(parseLabels(JSON.stringify([...records.slice(1), { session: "bad", outcome: "bad" }]))).done).toBe(false);
	});
});

describe("labelEvidence", () => {
	it("lists the turns with each signal and how the session ended", () => {
		expect(evidence("correctionTurn")).toMatchObject({ correctionTurns: [2], questionTurns: [2], rewindTurns: [], errorRunTurns: [], lastTurn: 3, ending: "answered" });
		expect(evidence("rewindWithSummary")).toMatchObject({ rewindTurns: [1], correctionTurns: [], ending: "answered" });
		expect(evidence("fork")).toMatchObject({ rewindTurns: [1], ending: "answered" });
		expect(evidence("abortedAndCacheDrop")).toMatchObject({ erroredTurns: [1], interruptedTurns: [2], ending: "answered" });
		const costliest = evidence("linear").costliestTurns;
		expect(costliest.map((turn) => turn.turnIndex).sort()).toEqual([1, 2]);
		expect(costliest.map((turn) => turn.cost)).toEqual([...costliest.map((turn) => turn.cost)].sort((a, b) => b - a));
	});

	it("tells the endings apart", () => {
		const unanswered = new SessionBuilder({ id: "u" });
		unanswered.system();
		unanswered.user("Hello");
		unanswered.assistant({ text: "Hi" });
		unanswered.user("Are you there?");
		expect(evidenceOf(unanswered)).toMatchObject({ ending: "unanswered", lastTurn: 2 });

		const interrupted = new SessionBuilder({ id: "i" });
		interrupted.system();
		interrupted.user("Go");
		interrupted.assistant({ text: "Stopping", stopReason: "aborted" });
		expect(evidenceOf(interrupted)).toMatchObject({ ending: "interrupted", interruptedTurns: [1] });

		const errored = new SessionBuilder({ id: "e" });
		errored.system();
		errored.user("Go");
		errored.assistant({ text: "", stopReason: "error", errorMessage: "Unknown error" });
		expect(evidenceOf(errored)).toMatchObject({ ending: "errored", erroredTurns: [1] });

		const midRun = new SessionBuilder({ id: "m" });
		midRun.system();
		midRun.user("Go");
		midRun.assistant({ toolCalls: [{ name: "bash", args: { command: "ls" } }] });
		expect(evidenceOf(midRun)).toMatchObject({ ending: "midRun" });

		const question = new SessionBuilder({ id: "q" });
		question.system();
		question.user("Go");
		question.assistant({ text: "Which one?" });
		expect(evidenceOf(question)).toMatchObject({ ending: "question", questionTurns: [1] });

		const empty = new SessionBuilder({ id: "0" });
		empty.system();
		expect(evidenceOf(empty)).toMatchObject({ ending: "empty", lastTurn: 0, costliestTurns: [] });
	});
});

describe("labelTurns", () => {
	it("excerpts the request and the final answer of each turn with its flags", () => {
		const session = load("correctionTurn");
		const turns = labelTurns(session, turnObservables(session));
		expect(turns.map((turn) => turn.turnIndex)).toEqual([1, 2, 3]);
		expect(turns[1]).toMatchObject({
			user: "No, I meant the helper in b.ts, not a.ts",
			final: "Renamed it in b.ts. Should I revert the change in a.ts?",
			flags: ["q", "corr"],
			requests: 2,
			toolCalls: 1,
			toolCallsByName: { edit: 1 },
		});
		expect(turns[2]).toMatchObject({ user: "Yes", flags: ["narr"], toolCalls: 0 });
		const offsets = turns.map((turn) => turn.offsetMs);
		expect(offsets[0]).toBeGreaterThanOrEqual(0);
		expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
	});

	it("flags interrupts, provider errors and error runs by name", () => {
		const turns = turnObservables(load("abortedAndCacheDrop"));
		expect(turnFlags(turns[0])).toContain("errored");
		expect(turnFlags(turns[1])).toContain("interrupted");
		expect(turnFlags(turns[1])).not.toContain("abort");
		expect(turnFlags(turns[2])).toEqual(["narr"]);
	});
});

describe("excerpt and record", () => {
	it("collapses whitespace and cuts long text", () => {
		expect(excerpt("  a\n\n b\tc ", 10)).toBe("a b c");
		expect(excerpt("abcdefghij", 10)).toBe("abcdefghij");
		expect(excerpt("abcdefghijk", 10)).toBe("abcdefghi…");
		expect(excerpt("abcde fghijk", 7)).toBe("abcde…");
		expect(excerpt("", 5)).toBe("");
	});

	it("gives the record to fill in the spec's order", () => {
		expect(labelRecord("x.jsonl")).toEqual({ session: "x.jsonl", outcome: "", earliestSaveTurn: null, level: "", note: "" });
	});
});
