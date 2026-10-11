import { describe, expect, it } from "vitest";
import { SessionBuilder } from "../fixtures/build.ts";
import { SHAPES } from "../fixtures/shapes.ts";
import { parseSession } from "./load.ts";
import { sessionSummary, type SessionSummary } from "./observables.ts";
import { rankScales, rankSessions, rateOf, scoreSession } from "./rank.ts";

function summarize(name: keyof typeof SHAPES): SessionSummary {
	return sessionSummary(parseSession(SHAPES[name]().toJsonl(), `${name}.jsonl`));
}

/** `requests` plain requests with `aborted` of them aborted. */
function session(id: string, requests: number, aborted: number): SessionSummary {
	const b = new SessionBuilder({ id });
	b.user("go");
	for (let i = 0; i < requests; i++) b.assistant({ text: "ok", stopReason: i < aborted ? "aborted" : "stop" });
	return sessionSummary(parseSession(b.toJsonl(), `${id}.jsonl`));
}

describe("rates and scales", () => {
	it("expresses each signal per 100 requests", () => {
		expect(rateOf(summarize("abortedAndCacheDrop"), "aborted")).toBe(10);
		expect(rateOf(summarize("correctionTurn"), "correctionTurns")).toBe(5);
		expect(rateOf(summarize("linear"), "rewinds")).toBe(0);
		expect(rateOf(session("short", 10, 2), "aborted")).toBe(10);
		expect(rateOf(session("floor", 20, 2), "aborted")).toBe(10);
		expect(rateOf(session("long", 200, 2), "aborted")).toBe(1);
	});

	it("scales by the 90th percentile, falling back to the maximum and then to one", () => {
		const scales = rankScales([session("a", 10, 1), session("b", 10, 2), session("c", 10, 0), session("d", 10, 5)]);
		expect(scales.aborted).toBe(25);
		expect(scales.rewinds).toBe(1);
		expect(rankScales([session("only", 10, 3)]).aborted).toBe(15);
		expect(rankScales([]).aborted).toBe(1);
	});
});

describe("scoreSession", () => {
	it("ranks a short session with the same count above a long one, instead of by size", () => {
		const short = session("short", 10, 2);
		const long = session("long", 200, 2);
		const ranked = rankSessions([short, long]);
		expect(ranked.map((row) => row.path)).toEqual(["short.jsonl", "long.jsonl"]);
		expect(ranked[0].components.aborted).toBe(1);
		expect(ranked[1].components.aborted).toBeCloseTo(1 / 10, 3);
	});

	it("clips every component at one and scores context above 200k on its own", () => {
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
		const bad = sessionSummary(parseSession(b.toJsonl(), "bad.jsonl"));
		const scored = scoreSession(bad, rankScales([bad, summarize("linear")]));
		expect(scored.components).toEqual({ correctionTurns: 1, rewinds: 0, errorRuns: 1, repeatedIdenticalCalls: 1, aborted: 1, largeContext: 1 });
		expect(scored.score).toBe(5);
		expect(scored.rates.correctionTurns).toBe(25);
		const mild = new SessionBuilder();
		mild.user("go");
		mild.assistant({ text: "ok", usage: { input: 250_000 } });
		expect(scoreSession(sessionSummary(parseSession(mild.toJsonl(), "mild.jsonl"))).components.largeContext).toBe(0.5);
		expect(scoreSession(summarize("linear")).score).toBe(0);
	});
});

describe("rankSessions", () => {
	it("orders by score, then cost, then path, with directory-wide scales", () => {
		const ranked = rankSessions([summarize("linear"), summarize("correctionTurn"), summarize("abortedAndCacheDrop"), summarize("fork"), summarize("compaction")]);
		// Each of the four signal carriers is the only (or joint-highest) source of its signal, so
		// every one of them scores exactly 1 and the tie breaks by cost; linear carries nothing.
		expect(ranked.map((row) => [row.path, row.score])).toEqual([
			["compaction.jsonl", 1],
			["abortedAndCacheDrop.jsonl", 1],
			["correctionTurn.jsonl", 1],
			["fork.jsonl", 1],
			["linear.jsonl", 0],
		]);
		expect(ranked.find((row) => row.path === "fork.jsonl")!.components.rewinds).toBe(1);
		expect(ranked.find((row) => row.path === "correctionTurn.jsonl")!.components.correctionTurns).toBe(1);
		expect(ranked.find((row) => row.path === "compaction.jsonl")!.components.repeatedIdenticalCalls).toBe(1);
	});
});
