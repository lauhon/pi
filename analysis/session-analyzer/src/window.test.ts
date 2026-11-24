import { describe, expect, it } from "vitest";
import { SHAPES } from "../fixtures/shapes.ts";
import { parseSession } from "./load.ts";
import { sessionSummary, turnObservables } from "./observables.ts";
import { sliceSince, turnBeforeWindow } from "./window.ts";

const jsonl = (name: keyof typeof SHAPES) => SHAPES[name]().toJsonl();

describe("until (load-time truncation)", () => {
	it("is the file as it was at that time: later entries, forks and compactions do not exist", () => {
		const full = parseSession(jsonl("compaction"), "c.jsonl");
		const atE7 = parseSession(jsonl("compaction"), "c.jsonl", { until: "2026-08-01T10:00:07.000Z" });
		expect(full.entries).toHaveLength(12);
		expect(atE7.entries.map((entry) => entry.id)).toEqual(["e1", "e2", "e3", "e4", "e5", "e6", "e7"]);
		expect(atE7.leafId).toBe("e7");
		expect(atE7.requestPoints).toHaveLength(3);
		expect(atE7.compactions).toEqual([]);
		expect(atE7.window).toEqual({ until: "2026-08-01T10:00:07.000Z" });
		expect(atE7.endedAt).toBe("2026-08-01T10:00:07.000Z");
		const fork = parseSession(jsonl("fork"), "f.jsonl", { until: "2026-08-01T10:00:05.000Z" });
		expect(fork.forks).toEqual([]);
		expect(fork.requestPoints.map((rp) => rp.textChars)).toEqual(["First answer".length, "Abandoned answer".length]);
	});

	it("accepts a date without a time and leaves nothing for a time before the first entry", () => {
		const whole = parseSession(jsonl("linear"), "l.jsonl", { until: "2026-08-02" });
		expect(whole.requestPoints).toHaveLength(3);
		const empty = parseSession(jsonl("linear"), "l.jsonl", { until: "2026-08-01" });
		expect(empty.entries).toHaveLength(0);
		expect(empty.requestPoints).toHaveLength(0);
		expect(() => parseSession(jsonl("linear"), "l.jsonl", { until: "yesterday" })).toThrow(/until: not a date/);
	});
});

describe("sliceSince", () => {
	it("keeps the requests at or after the cut, renumbered, with turn indexes unchanged", () => {
		const session = parseSession(jsonl("compaction"), "c.jsonl");
		const sliced = sliceSince(session, "2026-08-01T10:00:09.000Z");
		expect(sliced).not.toBeNull();
		expect(sliced!.requestPoints.map((rp) => [rp.index, rp.assistantEntryId])).toEqual([
			[0, "e10"],
			[1, "e12"],
		]);
		expect(sliced!.turns.map((turn) => turn.requestIndexes)).toEqual([[], [], [], [0, 1]]);
		expect(sliced!.compactions).toEqual([]);
		expect(sliced!.window).toEqual({ since: "2026-08-01T10:00:09.000Z" });
		expect(sliced!.startedAt).toBe("2026-08-01T10:00:09.000Z");
		expect(sliced!.durationMs).toBe(3000);
		expect(turnBeforeWindow(sliced!, 1)).toBe(true);
		expect(turnBeforeWindow(sliced!, 3)).toBe(false);
		expect(turnBeforeWindow(session, 1)).toBe(false);
	});

	it("drops forks before the cut and keeps a compaction after it", () => {
		const fork = parseSession(jsonl("fork"), "f.jsonl");
		expect(sliceSince(fork, "2026-08-01T10:00:06.000Z")!.forks).toEqual([]);
		expect(sliceSince(fork, "2026-08-01T10:00:03.000Z")!.forks).toHaveLength(1);
		const compaction = parseSession(jsonl("compaction"), "c.jsonl");
		expect(sliceSince(compaction, "2026-08-01T10:00:08.000Z")!.compactions).toHaveLength(1);
	});

	it("returns null when no request remains and rejects a bad date", () => {
		const session = parseSession(jsonl("linear"), "l.jsonl");
		expect(sliceSince(session, "2027-01-01")).toBeNull();
		expect(() => sliceSince(session, "soon")).toThrow(/since: not a date/);
	});

	it("is honored by the observables: turns before the window are skipped", () => {
		const sliced = sliceSince(parseSession(jsonl("compaction"), "c.jsonl"), "2026-08-01T10:00:09.000Z")!;
		expect(turnObservables(sliced).map((turn) => turn.turnIndex)).toEqual([3]);
		const summary = sessionSummary(sliced);
		expect(summary.turns).toBe(1);
		expect(summary.requests).toBe(2);
		expect(summary.rereadAfterCompaction).toBe(0);
	});
});
