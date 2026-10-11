import { describe, expect, it } from "vitest";
import { SessionBuilder } from "../fixtures/build.ts";
import { SHAPES } from "../fixtures/shapes.ts";
import { parseSession } from "./load.ts";
import { sessionSummary } from "./observables.ts";
import { RANK_CAPS, rankSessions, scoreSession } from "./rank.ts";

function summarize(name: keyof typeof SHAPES) {
	return sessionSummary(parseSession(SHAPES[name]().toJsonl(), `${name}.jsonl`));
}

describe("scoreSession", () => {
	it("normalizes each signal by its cap and sums them", () => {
		const aborted = scoreSession(summarize("abortedAndCacheDrop"));
		expect(aborted.components).toEqual({ correctionTurns: 0, rewinds: 0, errorRuns: 0, repeatedIdenticalCalls: 0, aborted: 1, largeContext: 0 });
		expect(aborted.score).toBe(1);
		const correction = scoreSession(summarize("correctionTurn"));
		expect(correction.components.correctionTurns).toBeCloseTo(1 / RANK_CAPS.correctionTurns, 3);
		expect(correction.score).toBeCloseTo(1 / RANK_CAPS.correctionTurns, 3);
		expect(scoreSession(summarize("linear")).score).toBe(0);
		expect(scoreSession(summarize("fork")).components.rewinds).toBeCloseTo(1 / RANK_CAPS.rewinds, 3);
		expect(scoreSession(summarize("toolErrors")).components.repeatedIdenticalCalls).toBeCloseTo(1 / RANK_CAPS.repeatedIdenticalCalls, 3);
	});

	it("clips a runaway signal at one and scores context above 200k", () => {
		const b = new SessionBuilder();
		b.user("go");
		b.assistant({ text: "a".repeat(1200) });
		for (let i = 0; i < 5; i++) {
			b.user("No, not that");
			b.assistant({ text: "b".repeat(1200), usage: { input: 250_000 } });
		}
		b.user("still no");
		b.assistant({ text: "c", stopReason: "aborted", usage: { input: 310_000 } });
		for (let i = 0; i < 4; i++) b.toolTurn("read", { path: "/x" }, "ENOENT: no such file or directory", { isError: true });
		b.assistant({ text: "d" });
		const scored = scoreSession(sessionSummary(parseSession(b.toJsonl(), "bad.jsonl")));
		expect(scored.components.correctionTurns).toBe(1);
		expect(scored.components.largeContext).toBe(1);
		expect(scored.components.aborted).toBeCloseTo(1 / RANK_CAPS.aborted, 3);
		expect(scored.components.errorRuns).toBeCloseTo(1 / RANK_CAPS.errorRuns, 3);
		expect(scored.components.repeatedIdenticalCalls).toBeCloseTo(3 / RANK_CAPS.repeatedIdenticalCalls, 3);
		const mild = new SessionBuilder();
		mild.user("go");
		mild.assistant({ text: "ok", usage: { input: 250_000 } });
		expect(scoreSession(sessionSummary(parseSession(mild.toJsonl(), "mild.jsonl"))).components.largeContext).toBe(0.5);
	});
});

describe("rankSessions", () => {
	it("orders by score, then cost, then path", () => {
		const ranked = rankSessions([summarize("linear"), summarize("correctionTurn"), summarize("abortedAndCacheDrop"), summarize("fork"), summarize("compaction")]);
		expect(ranked.map((row) => row.path)).toEqual(["abortedAndCacheDrop.jsonl", "correctionTurn.jsonl", "fork.jsonl", "compaction.jsonl", "linear.jsonl"]);
		expect(ranked[1].score).toBeCloseTo(ranked[2].score, 6);
		expect(ranked[1].summary.cost).toBeGreaterThan(ranked[2].summary.cost);
	});
});
