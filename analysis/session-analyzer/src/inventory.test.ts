import { describe, expect, it } from "vitest";
import { SessionBuilder, defaultSections, defaultTools } from "../fixtures/build.ts";
import { SHAPES } from "../fixtures/shapes.ts";
import {
	groupBySource,
	inlineSkillName,
	inventoryDirectory,
	inventoryRequestPoint,
	inventorySession,
	parseSkillLocations,
	percentile,
	skillForCall,
} from "./inventory.ts";
import { parseSession } from "./load.ts";
import type { Segment, SegmentSource } from "./types.ts";

function load(name: keyof typeof SHAPES) {
	return parseSession(SHAPES[name]().toJsonl(), `${name}.jsonl`);
}

function sources(segments: Segment[]): SegmentSource[] {
	return [...new Set(segments.map((segment) => segment.source))].sort();
}

describe("skill attribution helpers", () => {
	const skills = parseSkillLocations(defaultSections().skills);

	it("parses skill names and locations from the skills section", () => {
		expect(skills).toEqual([{ name: "cmux", location: "/repo/skills/cmux/SKILL.md" }]);
		expect(parseSkillLocations(undefined)).toEqual([]);
		expect(parseSkillLocations("<skills>\n<available_skills>\n  <skill>\n    <name>a &amp; b</name>\n    <description>d</description>\n    <location>/x/SKILL.md</location>\n  </skill>\n</available_skills>\n</skills>")).toEqual([
			{ name: "a & b", location: "/x/SKILL.md" },
		]);
	});

	it("matches a read of the listed location or a bash command naming it, nothing else", () => {
		expect(skillForCall("read", { path: "/repo/skills/cmux/SKILL.md" }, skills)).toBe("cmux");
		expect(skillForCall("bash", { command: "cat /repo/skills/cmux/SKILL.md" }, skills)).toBe("cmux");
		expect(skillForCall("read", { path: "/repo/src/load.ts" }, skills)).toBeUndefined();
		expect(skillForCall("read", { path: "/repo/skills/other/SKILL.md" }, skills)).toBeUndefined();
		expect(skillForCall("bash", { command: "ls" }, skills)).toBeUndefined();
		expect(skillForCall("read", { path: "/repo/skills/cmux/SKILL.md" }, [])).toBeUndefined();
	});

	it("recognizes an inlined /skill: block at the start of a user message", () => {
		expect(inlineSkillName('<skill name="cmux" location="/repo/skills/cmux/SKILL.md">\nbody\n</skill>')).toBe("cmux");
		expect(inlineSkillName("please load the cmux skill")).toBeUndefined();
		expect(inlineSkillName("")).toBeUndefined();
	});
});

describe("inventoryRequestPoint", () => {
	it("lists every system section and tool description once, at position 0, with the age of the system entry", () => {
		const session = load("linear");
		const request = inventoryRequestPoint(session.requestPoints[2], session);
		const system = request.segments.filter((segment) => segment.source.startsWith("system."));
		expect(system.map((segment) => segment.source).sort()).toEqual(["system.cwd", "system.preamble", "system.project_context", "system.rules", "system.skills", "system.tools"]);
		for (const segment of system) expect(segment).toMatchObject({ entryId: "e1", position: 0, ageTurns: 2 });
		expect(system.find((segment) => segment.source === "system.preamble")?.chars).toBe(defaultSections().preamble.length);
		const tools = request.segments.filter((segment) => segment.source === "tool_description");
		expect(tools.map((segment) => segment.label)).toEqual(["read", "bash", "edit", "write"]);
		const read = defaultTools()[0];
		expect(tools[0].chars).toBe(read.description.length + JSON.stringify(read.parameters).length);
	});

	it("attributes conversation messages by role with position and age", () => {
		const session = load("linear");
		const request = inventoryRequestPoint(session.requestPoints[2], session);
		const conversation = request.segments.filter((segment) => !segment.source.startsWith("system.") && segment.source !== "tool_description");
		expect(conversation.map((segment) => [segment.source, segment.label, segment.position, segment.ageTurns])).toEqual([
			["user", undefined, 1, 1],
			["assistant.text", undefined, 2, 1],
			["user", undefined, 3, 0],
			["assistant.tool_call", "read", 4, 0],
			["tool_result", "read", 5, 0],
		]);
		expect(conversation[0].chars).toBe("What does the loader do?".length);
		expect(conversation[4].chars).toBe("export function loadSession() {}".length);
		expect(request.totalChars).toBe(request.segments.reduce((sum, segment) => sum + segment.chars, 0));
		expect(request.contextTokens).toBe(4300);
	});

	it("groups by source and label with shares that sum to one and token estimates from usage", () => {
		const session = load("linear");
		const request = inventoryRequestPoint(session.requestPoints[2], session);
		const shareSum = request.bySource.reduce((sum, total) => sum + total.share, 0);
		expect(shareSum).toBeCloseTo(1, 6);
		const user = request.bySource.find((total) => total.source === "user");
		expect(user).toMatchObject({ count: 2, position: 1, maxAgeTurns: 1 });
		expect(user?.tokensEstimate).toBe(Math.round((user!.chars / request.totalChars) * 4300));
		expect(request.bySource[0].chars).toBeGreaterThanOrEqual(request.bySource[1].chars);
		const unlabeled = groupBySource(request.segments, request.totalChars, request.contextTokens, false);
		expect(unlabeled.find((total) => total.source === "tool_description")?.count).toBe(4);
		expect(unlabeled.every((total) => total.label === undefined)).toBe(true);
	});

	it("after a compaction, the checkpoint supplies the system part once and the summary is a segment", () => {
		const session = load("compaction");
		const request = inventoryRequestPoint(session.requestPoints[3], session);
		const system = request.segments.filter((segment) => segment.source.startsWith("system."));
		expect(system).toHaveLength(6);
		for (const segment of system) expect(segment.entryId).toBe("e8");
		expect(request.segments.filter((segment) => segment.source === "tool_description")).toHaveLength(4);
		const summary = request.segments.find((segment) => segment.source === "compaction_summary");
		expect(summary).toMatchObject({ entryId: "e8", position: 1, ageTurns: 1, chars: "Turn one read a.ts.".length });
		expect(request.segments.some((segment) => ["e2", "e3", "e4", "e5"].includes(segment.entryId))).toBe(false);
		const before = inventoryRequestPoint(session.requestPoints[2], session);
		expect(before.segments.some((segment) => segment.source === "compaction_summary")).toBe(false);
	});

	it("reports no system part after a compaction that stored no checkpoint", () => {
		const session = load("compactionRetainNone");
		const request = inventoryRequestPoint(session.requestPoints[1], session);
		expect(sources(request.segments)).toEqual(["compaction_summary", "user"]);
	});

	it("labels injections by customType and counts bash executions and branch summaries", () => {
		const session = load("injections");
		const request = inventoryRequestPoint(session.requestPoints[2], session);
		expect(request.segments.find((segment) => segment.source === "custom_message")).toMatchObject({ label: "subagents-monitor", entryId: "e6" });
		expect(request.segments.find((segment) => segment.source === "bash_execution")?.chars).toBe("git status".length + "clean".length);
		expect(request.segments.some((segment) => segment.entryId === "e2")).toBe(false);
		const rewind = load("rewindWithSummary");
		const withSummary = inventoryRequestPoint(rewind.requestPoints[0], rewind);
		expect(withSummary.segments.find((segment) => segment.source === "branch_summary")?.chars).toBe("Approach A failed because of X.".length);
		expect(inventoryRequestPoint(load("linear").requestPoints[2], load("linear")).segments.some((segment) => segment.source === "custom_message")).toBe(false);
	});

	it("attributes a skill file read and an inlined /skill: block to skill:<name>", () => {
		const session = load("skillLoad");
		const request = inventoryRequestPoint(session.requestPoints[2], session);
		expect(request.segments.find((segment) => segment.source === "tool_result")?.label).toBe("skill:cmux");
		const users = request.segments.filter((segment) => segment.source === "user");
		expect(users.map((segment) => segment.label)).toEqual([undefined, "skill:cmux"]);
		const plain = load("linear");
		expect(inventoryRequestPoint(plain.requestPoints[2], plain).segments.find((segment) => segment.source === "tool_result")?.label).toBe("read");
	});

	it("keeps extension sections and free-form system content as system.other with a label", () => {
		const session = load("customSection");
		const request = inventoryRequestPoint(session.requestPoints[0], session);
		const other = request.segments.filter((segment) => segment.source === "system.other");
		expect(other.map((segment) => [segment.label, segment.entryId, segment.position, segment.chars])).toEqual([
			["guidelines", "e2", 1, "<guidelines>\n- Ask when ambiguous\n</guidelines>".length],
			["content", "e2", 1, "Always answer in German.".length],
		]);
		expect(inventoryRequestPoint(load("linear").requestPoints[0], load("linear")).segments.some((segment) => segment.source === "system.other")).toBe(false);
	});

	it("drops patched-away sections and removed tools", () => {
		const session = load("modelChange");
		const after = inventoryRequestPoint(session.requestPoints[1], session);
		expect(after.segments.some((segment) => segment.source === "system.skills")).toBe(false);
		expect(after.segments.filter((segment) => segment.source === "tool_description").map((segment) => segment.label)).toEqual(["read", "bash", "edit"]);
		expect(after.segments.find((segment) => segment.source === "assistant.thinking")).toBeUndefined();
		const before = inventoryRequestPoint(session.requestPoints[0], session);
		expect(before.segments.some((segment) => segment.source === "system.skills")).toBe(true);
	});

	it("measures what a context edit left in the window", () => {
		const session = load("contextEdit");
		const request = inventoryRequestPoint(session.requestPoints[2], session);
		expect(request.segments.some((segment) => segment.source === "tool_result")).toBe(false);
		expect(request.segments.find((segment) => segment.source === "user")?.chars).toBe("Read something big (trimmed)".length);
		const earlier = inventoryRequestPoint(session.requestPoints[1], session);
		expect(earlier.segments.find((segment) => segment.source === "tool_result")?.chars).toBe(5000);
	});

	it("counts thinking separately from visible text", () => {
		const b = new SessionBuilder();
		b.user("q");
		b.assistant({ text: "visible", thinking: "hidden reasoning" });
		b.user("again");
		b.assistant({ text: "more" });
		const session = parseSession(b.toJsonl(), "t.jsonl");
		const request = inventoryRequestPoint(session.requestPoints[1], session);
		expect(request.segments.find((segment) => segment.source === "assistant.thinking")?.chars).toBe("hidden reasoning".length);
		expect(request.segments.find((segment) => segment.source === "assistant.text")?.chars).toBe("visible".length);
	});
});

describe("inventorySession", () => {
	it("aggregates over every request, averages shares and finds the peak", () => {
		const session = load("linear");
		const summary = inventorySession(session);
		expect(summary.requestCount).toBe(3);
		const shareSum = Object.values(summary.meanShare).reduce((sum, share) => sum + share, 0);
		expect(shareSum).toBeCloseTo(1, 6);
		expect(summary.bySourceOnly.find((total) => total.source === "tool_description")?.count).toBe(12);
		expect(summary.bySource.find((total) => total.source === "tool_result")?.label).toBe("read");
		expect(summary.peak?.requestIndex).toBe(2);
		expect(summary.peak?.contextTokens).toBe(4300);
		expect(summary.skillsLoaded).toEqual([]);
		expect(summary.injections).toEqual({});
	});

	it("lists loaded skills and injected characters", () => {
		expect(inventorySession(load("skillLoad")).skillsLoaded).toEqual(["cmux"]);
		expect(inventorySession(load("injections")).injections).toEqual({ "subagents-monitor": "Child worker finished: out-1.md".length });
	});

	it("has no peak for a session without requests", () => {
		const b = new SessionBuilder();
		b.user("unanswered");
		const summary = inventorySession(parseSession(b.toJsonl(), "u.jsonl"));
		expect(summary.peak).toBeNull();
		expect(summary.requestCount).toBe(0);
	});
});

describe("inventoryDirectory", () => {
	it("averages session means and reports the distribution over requests", () => {
		const summary = inventoryDirectory([load("linear"), load("injections")]);
		expect(summary.sessionCount).toBe(2);
		expect(summary.requestCount).toBe(6);
		expect(summary.distribution.custom_message?.max).toBeGreaterThan(0);
		expect(summary.distribution.custom_message?.p50).toBeGreaterThan(0);
		expect(summary.meanShare.custom_message).toBeGreaterThan(0);
		expect(summary.meanShare.custom_message).toBeLessThan(summary.distribution.custom_message!.max);
		expect(summary.peaks.map((peak) => peak.path)).toEqual(["linear.jsonl", "injections.jsonl"]);
		expect(inventoryDirectory([]).sessionCount).toBe(0);
	});

	it("percentile uses nearest rank", () => {
		expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
		expect(percentile([1, 2, 3, 4], 0.9)).toBe(4);
		expect(percentile([7], 0.5)).toBe(7);
		expect(percentile([], 0.5)).toBe(0);
	});
});
