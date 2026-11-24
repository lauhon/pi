import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionBuilder } from "../fixtures/build.ts";
import { appendVerdict, catchKey, extractCatches, extractOutcomes, linkOutcomes, readVerdicts, savingFor, sessionStatus, STEER_PREFIX, subRunInfo } from "./attention.ts";
import { parseSession } from "./load.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), "attn-an-"));
	dirs.push(d);
	return d;
};
const load = (b: SessionBuilder) => parseSession(b.toJsonl(), "/x/s.jsonl");
const assume = { kind: "scope", decision: "only the API, not the UI", alternatives: ["API and UI"], basis: "ticket title" };

function escSession(): SessionBuilder {
	const b = new SessionBuilder({ id: "s-esc", cwd: "/work/gls" });
	b.system();
	b.user("add reset");
	b.toolTurn("assumption", assume, "Noted; continue unless the user steers.", { usage: { input: 1000, output: 100, cost: 0.1 } });
	b.assistant({ text: "working", stopReason: "aborted", usage: { input: 2000, output: 300, cacheWrite: 50, cost: 0.2 } });
	b.user("no, the UI too ".repeat(20));
	b.assistant({ text: "ok", usage: { cost: 0.05 } });
	return b;
}

describe("catches and esc outcomes", () => {
	it("extracts the catch with its fields", () => {
		const s = load(escSession());
		const [c] = extractCatches(s);
		expect(c).toMatchObject({ sessionId: "s-esc", kind: "scope", decision: "only the API, not the UI", alternatives: ["API and UI"], basis: "ticket title", turnIndex: 1, requestIndex: 0 });
		expect(catchKey(c)).toBe(`s-esc:${c.entryId}`);
	});

	it("keeps keys unique for parallel calls in one message", () => {
		const b = new SessionBuilder({ id: "p" });
		b.system();
		b.user("go");
		b.assistant({ toolCalls: [{ name: "assumption", args: assume }, { name: "assumption", args: { ...assume, decision: "two" } }] });
		const keys = extractCatches(load(b)).map(catchKey);
		expect(new Set(keys).size).toBe(2);
	});

	it("links esc to the catch and estimates the work after it", () => {
		const s = load(escSession());
		const catches = extractCatches(s);
		const outcomes = linkOutcomes(catches, extractOutcomes(s));
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0].type).toBe("esc");
		expect(outcomes[0].correction).toHaveLength(160);
		expect(outcomes[0].catchKey).toBe(catchKey(catches[0]));
		const saving = savingFor(catches[0], outcomes, s)!;
		expect(saving.cost).toBeCloseTo(0.2);
		expect(saving.tokens).toBe(2000 + 300 + 50);
		expect(saving.via).toBe("esc");
	});

	it("does not link beyond 3 turns, nor across sessions", () => {
		const b = new SessionBuilder({ id: "far" });
		b.system();
		b.user("a");
		b.toolTurn("assumption", assume, "ok");
		b.assistant({ text: "done" });
		for (let i = 0; i < 4; i++) {
			b.user(`q${i}`);
			b.assistant({ text: "a" });
		}
		b.user("q5");
		b.assistant({ text: "a", stopReason: "aborted" });
		b.user("correction");
		b.assistant({ text: "a" });
		const s = load(b);
		const out = linkOutcomes(extractCatches(s), extractOutcomes(s));
		expect(out[0].catchKey).toBeNull();
		const other = linkOutcomes(extractCatches(load(escSession())), [{ ...out[0], sessionId: "elsewhere", turnIndex: 1 }]);
		expect(other[0].catchKey).toBeNull();
	});

	it("counts a message from the attention view as a steer outcome", () => {
		const b = new SessionBuilder({ id: "st" });
		b.system();
		b.user("a");
		b.toolTurn("assumption", assume, "ok", { usage: { cost: 0.1 } });
		b.assistant({ text: "more work", usage: { input: 500, output: 50, cost: 0.3 } });
		b.user(`${STEER_PREFIX}also the UI`);
		b.assistant({ text: "ok" });
		const s = load(b);
		const outs = linkOutcomes(extractCatches(s), extractOutcomes(s));
		expect(outs[0]).toMatchObject({ type: "steer", correction: "also the UI" });
		expect(savingFor(extractCatches(s)[0], outs, s)!.cost).toBeCloseTo(0.3);
	});

	it("returns no saving without an outcome", () => {
		const b = new SessionBuilder({ id: "n" });
		b.system();
		b.user("a");
		b.toolTurn("assumption", assume, "ok");
		b.assistant({ text: "done" });
		const s = load(b);
		expect(savingFor(extractCatches(s)[0], [], s)).toBeNull();
	});
});

describe("rewind outcomes", () => {
	it("counts requests and dropped context of the abandoned branch", () => {
		const b = new SessionBuilder({ id: "rw" });
		b.system();
		b.user("a");
		const t = b.toolTurn("assumption", assume, "ok", { usage: { input: 10_000, cost: 0.1 } });
		b.user("go on");
		b.assistant({ text: "x", usage: { input: 50_000, cost: 0.5 } });
		b.assistant({ text: "y", usage: { input: 60_000, cost: 0.6 } });
		b.branchFrom(t.resultId);
		b.user("different approach");
		b.assistant({ text: "z" });
		const s = load(b);
		const catches = extractCatches(s);
		const outs = linkOutcomes(catches, extractOutcomes(s));
		const rw = outs.find((o) => o.type === "rewind")!;
		expect(rw.requests).toBe(2);
		expect(rw.droppedContextTokens).toBe(50_000);
		expect(rw.catchKey).toBe(catchKey(catches[0]));
		const saving = savingFor(catches[0], outs, s)!;
		expect(saving.cost).toBeCloseTo(1.1);
		expect(saving.via).toBe("rewind");
	});
});

describe("status", () => {
	const now = Date.parse("2026-08-01T11:00:00Z");
	const mk = (end: (b: SessionBuilder) => void) => {
		const b = new SessionBuilder({ id: "x" });
		b.system();
		b.user("a");
		end(b);
		return load(b);
	};
	it("working: tool result, user message or tool-call assistant, changed within 3 min", () => {
		expect(sessionStatus(mk(() => {}), now - 60_000, now)).toBe("working");
		expect(sessionStatus(mk((b) => b.toolTurn("bash", {}, "r")), now - 60_000, now)).toBe("working");
		expect(sessionStatus(mk((b) => b.assistant({ toolCalls: [{ name: "bash", args: {} }] })), now - 60_000, now)).toBe("working");
	});
	it("waiting: last assistant message stopped without tool calls", () => {
		expect(sessionStatus(mk((b) => b.assistant({ text: "done" })), now - 60_000, now)).toBe("waiting");
		expect(sessionStatus(mk((b) => b.assistant({ text: "done" })), now - 29 * 60_000, now)).toBe("waiting");
	});
	it("stalled work shape (3 to 30 min) shows as waiting; 30 min of silence is idle", () => {
		expect(sessionStatus(mk(() => {}), now - 10 * 60_000, now)).toBe("waiting");
		expect(sessionStatus(mk(() => {}), now - 31 * 60_000, now)).toBe("idle");
	});
	it("waiting needs a last assistant message under 2 h old, whatever the file mtime", () => {
		const done = mk((b) => b.assistant({ text: "done" }));
		const at = Date.parse("2026-08-01T10:00:10Z");
		expect(sessionStatus(done, at, at + 119 * 60_000)).toBe("waiting");
		expect(sessionStatus(done, at, at + 121 * 60_000)).toBe("idle");
		expect(sessionStatus(done, at + 100 * 60_000, at + 121 * 60_000)).toBe("idle");
	});
});

describe("verdicts and sub-runs", () => {
	it("appends and reads verdicts, last one wins, skips bad lines", () => {
		const d = tmp();
		appendVerdict("s:e1", "useful", d, 1000);
		appendVerdict("s:e1", "noise", d, 2000);
		appendVerdict("s:e2", "useful", d, 3000);
		writeFileSync(join(d, "verdicts.jsonl"), "garbage\n", { flag: "a" });
		const v = readVerdicts(d);
		expect(v.get("s:e1")?.verdict).toBe("noise");
		expect(v.get("s:e2")?.verdict).toBe("useful");
		expect(readVerdicts(join(d, "none")).size).toBe(0);
		appendVerdict("s:e2", "none", d, 4000);
		expect(readVerdicts(d).has("s:e2")).toBe(false);
		expect(readVerdicts(d).get("s:e1")?.verdict).toBe("noise");
	});
	it("reads the parent of a sub-run dir", () => {
		const d = tmp();
		const run = join(d, "20260902-deploy-ready");
		mkdirSync(run);
		writeFileSync(join(run, "parent"), "parent-id\n");
		expect(subRunInfo(join(run, "session.jsonl"))).toEqual({ name: "20260902-deploy-ready", parentId: "parent-id", runDir: run });
		expect(subRunInfo(join(d, "session.jsonl"))).toBeNull();
	});
});
