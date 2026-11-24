import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionBuilder } from "../fixtures/build.ts";
import { SHAPES } from "../fixtures/shapes.ts";
import { findSessionFiles, hashArgs, parseSession, replaySystemMessages, stableStringify } from "./load.ts";

function load(name: keyof typeof SHAPES) {
	return parseSession(SHAPES[name]().toJsonl(), `${name}.jsonl`);
}

describe("parseSession", () => {
	it("reads the header", () => {
		const session = load("linear");
		expect(session.id).toBe("linear");
		expect(session.version).toBe(3);
		expect(session.cwd).toBe("/repo");
		expect(session.parentSession).toBeUndefined();
		expect(session.leafId).toBe(session.entries[session.entries.length - 1].id);
		expect(session.entryTypeCounts).toEqual({ message: 7 });
		expect(session.messageRoleCounts).toEqual({ system: 1, user: 2, assistant: 3, toolResult: 1 });
	});

	it("makes one request point per assistant message on the active branch, in order", () => {
		const session = load("linear");
		expect(session.requestPoints.map((rp) => rp.index)).toEqual([0, 1, 2]);
		expect(session.requestPoints.map((rp) => rp.turnIndex)).toEqual([1, 2, 2]);
		expect(session.turns.map((turn) => turn.requestIndexes)).toEqual([[], [0], [1, 2]]);
		expect(session.turns[2].userText).toBe("Read the file and tell me.");
		expect(session.turns[2].userChars).toBe("Read the file and tell me.".length);
		expect(session.requestPoints[2].textChars).toBe("The loader reads the file.".length);
		expect(session.requestPoints[2].stopReason).toBe("stop");
		expect(session.requestPoints[1].stopReason).toBe("toolUse");
	});

	it("attaches tool calls and their results to the request point that made them", () => {
		const session = load("linear");
		const rp = session.requestPoints[1];
		expect(rp.toolCalls).toHaveLength(1);
		expect(rp.toolCalls[0]).toMatchObject({ id: "call_1", name: "read", path: "/repo/src/load.ts" });
		expect(rp.toolCalls[0].argsHash).toBe(hashArgs({ path: "/repo/src/load.ts" }));
		expect(rp.toolResults).toHaveLength(1);
		expect(rp.toolResults[0]).toMatchObject({ id: "call_1", name: "read", isError: false, chars: "export function loadSession() {}".length });
		expect(session.requestPoints[0].toolResults).toHaveLength(0);
		expect(session.requestPoints[2].toolCalls).toHaveLength(0);
	});

	it("takes usage from the assistant message", () => {
		const session = load("linear");
		const rp = session.requestPoints[1];
		expect(rp.usage).toMatchObject({ input: 2100, output: 100, cacheRead: 1900, cacheWrite: 0, contextTokens: 4000 });
		expect(rp.usage.cost).toBeCloseTo((2100 * 3 + 100 * 15 + 1900 * 0.3) / 1_000_000, 8);
		expect(rp.provider).toBe("github-copilot");
		expect(rp.model).toBe("gpt-5.6-terra");
	});

	it("treats a missing usage as zeros instead of failing", () => {
		const b = new SessionBuilder({ id: "no-usage" });
		b.user("Hi");
		b.assistant({ text: "Hello" });
		const entries = b.toEntries();
		delete entries[2].message.usage;
		const session = parseSession(entries.map((entry) => JSON.stringify(entry)).join("\n"), "no-usage.jsonl");
		expect(session.requestPoints[0].usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 });
	});

	it("reports forks and leaves abandoned branches out of the request points", () => {
		const session = load("fork");
		expect(session.requestPoints.map((rp) => rp.textChars)).toEqual(["First answer".length, "Second answer".length]);
		expect(session.turns.length - 1).toBe(2);
		expect(session.forks).toHaveLength(1);
		expect(session.forks[0]).toMatchObject({ parentId: "e3", turnIndex: 1, childIds: ["e4", "e6"] });
		expect(session.forks[0].abandoned).toEqual([{ headId: "e4", entryCount: 2, assistantCount: 1 }]);
	});

	it("counts branch summaries and keeps them on the active branch", () => {
		const session = load("rewindWithSummary");
		expect(session.branchSummaryCount).toBe(1);
		expect(session.forks).toHaveLength(1);
		expect(session.requestPoints).toHaveLength(1);
		expect(session.requestPoints[0].context.messages.some((message) => message.role === "branchSummary")).toBe(true);
	});

	it("has no forks in a linear session", () => {
		expect(load("linear").forks).toEqual([]);
		expect(load("linear").branchSummaryCount).toBe(0);
	});

	it("describes compactions and builds the context after one from the checkpoint", () => {
		const session = load("compaction");
		expect(session.compactions).toHaveLength(1);
		expect(session.compactions[0]).toMatchObject({ tokensBefore: 70_000, hasSystemMessage: true, firstKeptEntryId: "e6", turnIndex: 2 });
		expect(session.compactions[0].summaryChars).toBe("Turn one read a.ts.".length);
		const after = session.requestPoints[3];
		expect(after.turnIndex).toBe(3);
		expect(after.context.entries[0].type).toBe("compaction");
		expect(after.context.entries.map((entry) => entry.id)).toEqual(["e8", "e6", "e7", "e9"]);
		expect(after.context.messages.map((message) => message.role)).toEqual(["system", "compactionSummary", "user", "assistant", "user"]);
		expect(after.context.sourceEntryIds.slice(0, 2)).toEqual(["e8", "e8"]);
		const before = session.requestPoints[2];
		expect(before.context.entries.map((entry) => entry.id)).toEqual(["e1", "e2", "e3", "e4", "e5", "e6"]);
	});

	it("handles a retain-none compaction without a checkpoint", () => {
		const session = load("compactionRetainNone");
		const after = session.requestPoints[1];
		expect(after.context.entries.map((entry) => entry.id)).toEqual(["e4", "e5"]);
		expect(after.context.messages.map((message) => message.role)).toEqual(["compactionSummary", "user"]);
		expect(session.compactions[0]).toMatchObject({ hasSystemMessage: false, firstKeptEntryId: "e4" });
	});

	it("keeps custom entries out of context and custom messages in it, without starting turns", () => {
		const session = load("injections");
		expect(session.turns.length - 1).toBe(2);
		expect(session.requestPoints.map((rp) => rp.turnIndex)).toEqual([1, 1, 2]);
		const last = session.requestPoints[2].context.messages.map((message) => message.role);
		expect(last).toEqual(["system", "user", "assistant", "toolResult", "custom", "assistant", "bashExecution", "user"]);
		expect(session.entryTypeCounts).toMatchObject({ custom: 1, custom_message: 1 });
	});

	it("tracks thinking level from entries or the message, and thinking chars", () => {
		const session = load("modelChange");
		expect(session.requestPoints[0].thinkingLevel).toBe("medium");
		expect(session.requestPoints[1].thinkingLevel).toBe("high");
		expect(session.requestPoints[0].thinkingChars).toBe(0);
		expect(session.requestPoints[1].thinkingChars).toBe("Let me think.".length);
		expect(session.requestPoints[1].model).toBe("gpt-5.6-sol");
		expect(session.entryTypeCounts).toMatchObject({ model_change: 1, thinking_level_change: 2 });
	});

	it("loads a session with no system message and a user root", () => {
		const session = load("noSystemMessage");
		expect(session.requestPoints).toHaveLength(1);
		expect(session.requestPoints[0].context.messages.map((message) => message.role)).toEqual(["user"]);
		expect(session.turns.length - 1).toBe(1);
	});

	it("applies context edits to the projected messages", () => {
		const session = load("contextEdit");
		const last = session.requestPoints[2];
		const roles = last.context.messages.map((message) => message.role);
		expect(roles).toEqual(["system", "user", "assistant", "assistant", "user"]);
		const user = last.context.messages[1] as { content: unknown };
		expect(user.content).toBe("Read something big (trimmed)");
	});

	it("measures duration from the header to the last entry", () => {
		const session = load("linear");
		expect(session.startedAt).toBe("2026-08-01T10:00:00.000Z");
		expect(session.endedAt).toBe("2026-08-01T10:00:07.000Z");
		expect(session.durationMs).toBe(7000);
	});

	it("skips malformed lines and rejects files without a header", () => {
		const jsonl = SHAPES.linear().toJsonl();
		const lines = jsonl.split("\n");
		lines.splice(2, 0, "{not json");
		const session = parseSession(lines.join("\n"), "x.jsonl");
		expect(session.requestPoints).toHaveLength(3);
		expect(() => parseSession('{"type":"message","id":"a"}\n', "y.jsonl")).toThrow(/not a pi session file/);
		expect(() => parseSession("", "z.jsonl")).toThrow(/not a pi session file/);
	});
});

describe("hashArgs", () => {
	it("ignores key order and notices value changes", () => {
		expect(stableStringify({ b: [1, { d: 2, c: 3 }], a: "x" })).toBe('{"a":"x","b":[1,{"c":3,"d":2}]}');
		expect(hashArgs({ path: "a", offset: 1 })).toBe(hashArgs({ offset: 1, path: "a" }));
		expect(hashArgs({ path: "a" })).not.toBe(hashArgs({ path: "b" }));
		expect(hashArgs({ path: "a" })).toHaveLength(12);
	});
});

describe("replaySystemMessages", () => {
	it("patches sections by name and removes tools", () => {
		const session = load("modelChange");
		const last = session.requestPoints[1];
		const state = replaySystemMessages(last.context.messages, last.context.sourceEntryIds);
		expect([...state.sections.keys()]).toEqual(["preamble", "tools", "rules", "project_context", "cwd"]);
		expect([...state.tools.keys()]).toEqual(["read", "bash", "edit"]);
		expect(state.sections.get("cwd")?.entryId).toBe("e1");
		const first = session.requestPoints[0];
		const before = replaySystemMessages(first.context.messages, first.context.sourceEntryIds);
		expect(before.sections.has("skills")).toBe(true);
		expect(before.tools.has("write")).toBe(true);
	});
});

describe("findSessionFiles", () => {
	it("finds nested session files and skips other jsonl files and node_modules", () => {
		const dir = mkdtempSync(join(tmpdir(), "analyzer-"));
		mkdirSync(join(dir, "--repo--"), { recursive: true });
		mkdirSync(join(dir, "runs", "child"), { recursive: true });
		mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
		writeFileSync(join(dir, "--repo--", "b.jsonl"), SHAPES.linear().toJsonl());
		writeFileSync(join(dir, "--repo--", "a.jsonl"), SHAPES.fork().toJsonl());
		writeFileSync(join(dir, "runs", "child", "session.jsonl"), SHAPES.linear().toJsonl());
		writeFileSync(join(dir, "runs", "turns.jsonl"), '{"turn":1}\n');
		writeFileSync(join(dir, "node_modules", "pkg", "s.jsonl"), SHAPES.linear().toJsonl());
		writeFileSync(join(dir, "notes.txt"), "x");
		expect(findSessionFiles(dir)).toEqual([join(dir, "--repo--", "a.jsonl"), join(dir, "--repo--", "b.jsonl"), join(dir, "runs", "child", "session.jsonl")]);
		expect(findSessionFiles(join(dir, "--repo--", "a.jsonl"))).toEqual([join(dir, "--repo--", "a.jsonl")]);
	});
});
