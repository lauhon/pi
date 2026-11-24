import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatTodo, pageName, parseTodos, searchTodos } from "./logseq.ts";
import { DEFAULT_CONFIG, acquireLock, releaseLock, runWriter, summarize, type RunDeps } from "./runner.ts";
import { digestSession, findPending, isIgnoredSessionDir } from "./sessions.ts";
import { applyOps, loadItems, parseItems, prune, renderIndex, saveItems, searchItems, slugify, type Item } from "./store.ts";
import { knownItemsFor, parseWriterOps } from "./writer.ts";

const NOW = Date.parse("2026-11-24T12:00:00Z");
const DAY = 86_400_000;

function item(over: Partial<Item> = {}): Item {
	return { id: "a", title: "A", status: "started", done: false, links: [], created: "2026-11-20", updated: "2026-11-20", ...over };
}

let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(path.join(os.tmpdir(), "wm-test-"));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("store", () => {
	it("skips malformed lines so a hand-edit typo does not wipe the log", () => {
		const items = parseItems(`${JSON.stringify(item())}\n{broken\n{"id":"x"}\n`);
		expect(items.map((i) => i.id)).toEqual(["a"]);
	});

	it("round-trips through disk, newest first", () => {
		saveItems(tmp, [item({ id: "old", updated: "2026-01-01" }), item({ id: "new", updated: "2026-11-01" })]);
		expect(loadItems(tmp).map((i) => i.id)).toEqual(["new", "old"]);
	});

	it("prunes after 60 days unless kept", () => {
		const items = [
			item({ id: "fresh", updated: "2026-11-01" }),
			item({ id: "stale", updated: "2026-09-01" }),
			item({ id: "kept", updated: "2026-09-01", keepUntil: "2026-12-31" }),
			item({ id: "expired-keep", updated: "2026-09-01", keepUntil: "2026-11-01" }),
			item({ id: "forever", updated: "2025-01-01", keepUntil: "forever" }),
		];
		expect(prune(items, NOW).map((i) => i.id)).toEqual(["fresh", "kept", "forever"]);
	});

	it("creates with a unique slug id and updates by id", () => {
		const start = [item({ id: "gls-badge-export", title: "GLS badge export" })];
		const res = applyOps(
			start,
			[
				{ title: "GLS badge export", status: "new one" },
				{ id: "gls-badge-export", status: "PR open", links: ["DPSCEP-1"] },
				{ status: "no title, no id: ignored" },
			],
			NOW,
			{ cwd: "/r/gls", link: "/s/1.jsonl" },
		);
		expect(res.added).toEqual(["gls-badge-export-2"]);
		expect(res.updated).toEqual(["gls-badge-export"]);
		const updated = res.items.find((i) => i.id === "gls-badge-export")!;
		expect(updated).toMatchObject({ status: "PR open", updated: "2026-11-24", links: ["DPSCEP-1", "/s/1.jsonl"] });
		expect(updated.cwd).toBeUndefined();
		expect(res.items.find((i) => i.id === "gls-badge-export-2")!.cwd).toBe("/r/gls");
		expect(start[0].status).toBe("started");
	});

	it("never moves updated backwards", () => {
		const res = applyOps([item({ updated: "2026-11-23" })], [{ id: "a", status: "older news" }], Date.parse("2026-11-01T00:00:00Z"));
		expect(res.items[0]).toMatchObject({ status: "older news", updated: "2026-11-23" });
	});

	it("clears keepUntil with null", () => {
		const res = applyOps([item({ keepUntil: "forever" })], [{ id: "a", keepUntil: null }], NOW);
		expect(res.items[0].keepUntil).toBeUndefined();
	});

	it("slugifies to something usable", () => {
		expect(slugify("DPSCEP-2249: RBA Badge Export (GLS)")).toBe("dpscep-2249-rba-badge-export");
		expect(slugify("!!!")).toBe("item");
	});

	it("renders here, elsewhere, overflow and recent done within limits", () => {
		const items = [
			item({ id: "h1", title: "Here one", cwd: "/r/gls", updated: "2026-11-23" }),
			item({ id: "e1", title: "Else one", cwd: "/r/zoe", updated: "2026-11-22" }),
			item({ id: "e2", title: "Else two", cwd: "/r/zoe", updated: "2026-11-21" }),
			item({ id: "d1", title: "Done recently", done: true, updated: "2026-11-23" }),
			item({ id: "d2", title: "Done long ago", done: true, updated: "2026-10-01" }),
		];
		const out = renderIndex(items, "/r/gls/packages/api", NOW, { here: 5, elsewhere: 1, recentDone: 3, recentDoneDays: 7, lineChars: 150 });
		expect(out).toContain("here (api):\n- [h1] Here one: started (1d)");
		expect(out).toContain("elsewhere:\n- [e1] Else one (zoe): started (2d)");
		expect(out).not.toContain("e2");
		expect(out).toContain("+1 more open");
		expect(out).toContain("recently done: Done recently (1d)");
		expect(out).not.toContain("long ago");
	});

	it("renders nothing for an empty log", () => {
		expect(renderIndex([], "/x", NOW)).toBe("");
	});

	it("searches by all terms, hides done unless asked", () => {
		const items = [item({ id: "x", title: "Tetris migrate", links: ["DPSCEP-7"] }), item({ id: "y", title: "Tetris export", done: true })];
		expect(searchItems(items, { query: "tetris" }).map((i) => i.id)).toEqual(["x"]);
		expect(searchItems(items, { query: "tetris", includeDone: true }).map((i) => i.id).sort()).toEqual(["x", "y"]);
		expect(searchItems(items, { query: "dpscep-7 migrate" }).map((i) => i.id)).toEqual(["x"]);
	});
});

function sessionFile(lines: unknown[]): string {
	return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

const SESSION = [
	{ type: "session", version: 3, id: "s", timestamp: "2026-11-20T10:00:00Z", cwd: "/r/gls" },
	{ type: "session_info", name: "badge export" },
	{ type: "message", timestamp: "2026-11-20T10:01:00Z", message: { role: "user", content: [{ type: "text", text: "Implement DPSCEP-2249\n\nplease" }] } },
	{
		type: "message",
		message: {
			role: "assistant",
			stopReason: "toolUse",
			content: [
				{ type: "thinking", thinking: "secret thoughts" },
				{ type: "text", text: "let me look" },
				{ type: "toolCall", name: "bash", arguments: { command: "git commit -m 'x'" } },
				{ type: "toolCall", name: "bash", arguments: { command: "ls -la" } },
			],
		},
	},
	{ type: "message", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "HUGE TOOL OUTPUT" }] } },
	{ type: "compaction", summary: "## Goal\nbadge" },
	{ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "PR #12 is open." }] } },
];

describe("sessions", () => {
	it("keeps user text, final answers, compactions and git commands; drops tool output and thinking", () => {
		const d = digestSession(sessionFile(SESSION));
		expect(d).toMatchObject({ cwd: "/r/gls", name: "badge export", userMessages: 1 });
		expect(d.text).toContain("U[11-20T10:01]: Implement DPSCEP-2249 please");
		expect(d.text).toContain("$ git commit -m 'x'");
		expect(d.text).toContain("A: PR #12 is open.");
		expect(d.text).toContain("# COMPACTION: ## Goal badge");
		expect(d.text).not.toContain("HUGE TOOL OUTPUT");
		expect(d.text).not.toContain("secret thoughts");
		expect(d.text).not.toContain("let me look");
		expect(d.text).not.toContain("ls -la");
	});

	it("cuts long digests to head and tail", () => {
		const many = Array.from({ length: 200 }, (_, n) => ({ type: "message", message: { role: "user", content: `message ${n} ${"x".repeat(100)}` } }));
		const d = digestSession(sessionFile([SESSION[0], ...many]), { maxChars: 2000, headChars: 500, maxCommands: 25 });
		expect(d.text.length).toBeLessThan(2100);
		expect(d.text).toContain("[...cut...]");
		expect(d.text).toContain("message 199");
	});

	it("ignores temp dirs used by subagents and tests", () => {
		expect(isIgnoredSessionDir("--private-tmp--")).toBe(true);
		expect(isIgnoredSessionDir("--private-tmp-subA--")).toBe(true);
		expect(isIgnoredSessionDir("--private-var-folders-x--")).toBe(true);
		expect(isIgnoredSessionDir("--Users-laurenz-Workspace--")).toBe(false);
	});

	it("finds idle, recent, unprocessed or grown sessions, oldest first", () => {
		const root = path.join(tmp, "sessions");
		const mk = (dir: string, name: string, ageMs: number, content = "x") => {
			mkdirSync(path.join(root, dir), { recursive: true });
			const f = path.join(root, dir, name);
			writeFileSync(f, content);
			const t = (NOW - ageMs) / 1000;
			utimesSync(f, t, t);
			return f;
		};
		const a = mk("--r-a--", "a.jsonl", 2 * DAY);
		const b = mk("--r-a--", "b.jsonl", 1 * DAY);
		mk("--r-a--", "active.jsonl", 5 * 60_000);
		mk("--r-a--", "ancient.jsonl", 40 * DAY);
		mk("--private-tmp--", "child.jsonl", DAY);
		const done = mk("--r-b--", "done.jsonl", DAY, "same");
		const grown = mk("--r-b--", "grown.jsonl", DAY - 60_000, "longer now");
		const current = mk("--r-b--", "current.jsonl", DAY);
		const pending = findPending(root, { [done]: 4, [grown]: 3 }, { now: NOW, minIdleMs: 30 * 60_000, maxAgeDays: 14, exclude: new Set([current]) });
		expect(pending.map((p) => p.file)).toEqual([a, b, grown]);
	});
});

describe("writer parsing", () => {
	it("accepts fenced output, keeps known ids, drops unknown ids without title", () => {
		const out = 'Sure:\n```json\n[{"id":"known","status":"merged","done":true},{"id":"ghost","status":"x"},{"id":"ghost2","title":"New thing","status":"started","links":["DPSCEP-1",5]}]\n```';
		const ops = parseWriterOps(out, new Set(["known"]));
		expect(ops).toEqual([
			{ id: "known", status: "merged", done: true },
			{ title: "New thing", status: "started", links: ["DPSCEP-1"] },
		]);
	});

	it("returns no ops for garbage", () => {
		expect(parseWriterOps("I could not find anything", new Set())).toEqual([]);
		expect(parseWriterOps("[not json]", new Set())).toEqual([]);
	});

	it("caps at 4 ops", () => {
		const many = JSON.stringify(Array.from({ length: 9 }, (_, n) => ({ title: `t${n}` })));
		expect(parseWriterOps(many, new Set())).toHaveLength(4);
	});

	it("shows the writer open items plus recently done ones", () => {
		const items = [item({ id: "o" }), item({ id: "d-new", done: true, updated: "2026-11-20" }), item({ id: "d-old", done: true, updated: "2026-10-01" })];
		expect(knownItemsFor(items, "2026-11-10").map((i) => i.id)).toEqual(["o", "d-new"]);
	});
});

describe("runner", () => {
	function setup() {
		const root = path.join(tmp, "mem");
		const sessions = path.join(tmp, "sessions");
		mkdirSync(path.join(sessions, "--r-gls--"), { recursive: true });
		const f1 = path.join(sessions, "--r-gls--", "1.jsonl");
		const f2 = path.join(sessions, "--r-gls--", "2.jsonl");
		const empty = path.join(sessions, "--r-gls--", "empty.jsonl");
		writeFileSync(f1, sessionFile(SESSION));
		writeFileSync(f2, sessionFile(SESSION));
		writeFileSync(empty, sessionFile([SESSION[0], SESSION[1]]));
		for (const [f, age] of [[f1, 2 * DAY], [f2, DAY], [empty, DAY]] as const) utimesSync(f, (NOW - age) / 1000, (NOW - age) / 1000);
		return { root, sessions, f1, f2 };
	}

	function deps(root: string, sessions: string, replies: string[], calls: string[]): RunDeps {
		return {
			root,
			sessionsRoot: sessions,
			exclude: new Set(),
			config: DEFAULT_CONFIG,
			now: () => NOW,
			signal: new AbortController().signal,
			complete: async (model, _s, prompt) => {
				calls.push(`${model}|${prompt.includes("id=dpscep-2249") ? "knows" : "fresh"}`);
				return { text: replies.shift() ?? "[]", cost: 0.01 };
			},
		};
	}

	it("backfills with the cheap model, then switches; second session updates the first's item", async () => {
		const { root, sessions, f1 } = setup();
		const calls: string[] = [];
		const report = await runWriter(
			deps(root, sessions, ['[{"title":"DPSCEP-2249 badge","status":"started"}]', '[{"id":"dpscep-2249-badge","status":"PR open"}]'], calls),
		);
		expect(calls).toEqual(["anthropic/claude-haiku-5-5|fresh", "anthropic/claude-haiku-5-5|knows"]);
		expect(report).toMatchObject({ status: "done", sessions: 2, skipped: 1, added: ["dpscep-2249-badge"], updated: [] });
		const items = loadItems(root);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ status: "PR open", cwd: "/r/gls", created: "2026-11-22", updated: "2026-11-23" });
		expect(items[0].links).toContain(f1);
		expect(existsSync(path.join(root, "backfill-done"))).toBe(true);
		expect(summarize(report)).toBe("work-memory: 2 sessions → 1 new ($0.02)");

		const again = await runWriter(deps(root, sessions, [], calls));
		expect(again.sessions).toBe(0);
		expect(summarize(again)).toBeUndefined();

		writeFileSync(f1, sessionFile([...SESSION, SESSION[2]]));
		utimesSync(f1, (NOW - DAY) / 1000, (NOW - DAY) / 1000);
		await runWriter(deps(root, sessions, [], calls));
		expect(calls.at(-1)).toBe("anthropic/claude-sonnet-5-5|knows");
	});

	it("counts failures, keeps going, and leaves failed sessions for the next run", async () => {
		const { root, sessions } = setup();
		const d = deps(root, sessions, [], []);
		let n = 0;
		d.complete = async () => {
			if (n++ === 0) throw new Error("401 unauthorized");
			return { text: '[{"title":"X"}]', cost: 0 };
		};
		const r = await runWriter(d);
		expect(r).toMatchObject({ failed: 1, sessions: 1, firstError: "401 unauthorized" });
		const processed = JSON.parse(readFileSync(path.join(root, "processed.json"), "utf8"));
		expect(Object.keys(processed)).toHaveLength(2);
	});

	it("does not run while another live process holds the lock", async () => {
		const { root, sessions } = setup();
		mkdirSync(root, { recursive: true });
		writeFileSync(path.join(root, "lock"), JSON.stringify({ pid: process.ppid, ts: NOW }));
		const r = await runWriter(deps(root, sessions, [], []));
		expect(r.status).toBe("locked");
	});

	it("takes over a stale lock and releases its own", () => {
		const root = path.join(tmp, "mem");
		mkdirSync(root, { recursive: true });
		writeFileSync(path.join(root, "lock"), JSON.stringify({ pid: 999_999_999, ts: NOW }));
		expect(acquireLock(root, NOW)).toBe(true);
		releaseLock(root);
		expect(existsSync(path.join(root, "lock"))).toBe(false);
	});
});

describe("logseq", () => {
	it("decodes page names", () => {
		expect(pageName("work___gls%3F.md", "pages")).toBe("work/gls?");
		expect(pageName("2026_11_20.md", "journals")).toBe("2026-11-20");
	});

	it("parses markers with nesting and dates, ignores DONE", () => {
		const md = "- TODO write spec\n  SCHEDULED: <2026-11-30 Mon>\n\t- DOING nested [[gls]]\n- DONE finished\n- LATER someday #ops\n  DEADLINE: <2026-12-01 Tue>\n";
		const todos = parseTodos(md, "p", ["TODO", "DOING", "LATER", "NOW"], 0);
		expect(todos.map((t) => `${t.marker}:${t.text}:${t.scheduled ?? ""}:${t.deadline ?? ""}`)).toEqual([
			"TODO:write spec:2026-11-30:",
			"DOING:nested [[gls]]::",
			"LATER:someday #ops::2026-12-01",
		]);
		expect(formatTodo(todos[0])).toBe("- p: TODO write spec (scheduled 2026-11-30)");
	});

	it("filters by query, page, tag, marker and limit, newest file first", () => {
		const g = path.join(tmp, "graph");
		mkdirSync(path.join(g, "journals"), { recursive: true });
		mkdirSync(path.join(g, "pages"), { recursive: true });
		writeFileSync(path.join(g, "journals", "2026_11_20.md"), "- TODO call Anna about gls\n- LATER read book\n");
		writeFileSync(path.join(g, "pages", "gls.md"), "- TODO fix export #work\n- TODO plan #private\n");
		utimesSync(path.join(g, "pages", "gls.md"), (NOW - DAY) / 1000, (NOW - DAY) / 1000);
		utimesSync(path.join(g, "journals", "2026_11_20.md"), NOW / 1000, NOW / 1000);

		expect(searchTodos(g, { query: "gls" }).todos.map((t) => t.text)).toEqual(["call Anna about gls", "fix export #work", "plan #private"]);
		expect(searchTodos(g, { page: "gls" }).total).toBe(2);
		expect(searchTodos(g, { tag: "work" }).todos.map((t) => t.text)).toEqual(["fix export #work"]);
		expect(searchTodos(g, { markers: ["LATER"] }).todos.map((t) => t.text)).toEqual(["read book"]);
		const limited = searchTodos(g, { limit: 1 });
		expect(limited.todos).toHaveLength(1);
		expect(limited.total).toBe(4);
	});
});
