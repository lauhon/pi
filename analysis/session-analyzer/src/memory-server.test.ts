import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionBuilder } from "../fixtures/build.ts";
import { classifyLink, parseUpdate, prunesOn, MemoryError } from "./memory-view.ts";
import { clearCache, startServer, type RunningServer } from "./serve.ts";

let root: string;
let sessions: string;
let mem: string;
let running: RunningServer | undefined;

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const item = (id: string, over: Record<string, unknown> = {}) => ({ id, title: `Title ${id}`, status: `status ${id}`, done: false, cwd: "/work/gls", links: [], created: day(-90), updated: day(0), ...over });
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const writeItems = (items: object[], extra = "") => writeFileSync(join(mem, "items.jsonl"), items.map((i) => JSON.stringify(i)).join("\n") + "\n" + extra);

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mem-srv-"));
	sessions = join(root, "sessions");
	mem = join(root, "mem");
	mkdirSync(sessions, { recursive: true });
	mkdirSync(mem, { recursive: true });
	process.env.WORK_MEMORY_DIR = mem;
	clearCache();
});
afterEach(async () => {
	await running?.close();
	running = undefined;
	delete process.env.WORK_MEMORY_DIR;
	rmSync(root, { recursive: true, force: true });
});

function http(method: string, path: string, opts: { headers?: Record<string, string>; body?: string } = {}) {
	return new Promise<{ status: number; text: string; json: any }>((done, fail) => {
		const req = request({ host: "127.0.0.1", port: running!.port, method, path, headers: opts.headers }, (res) => {
			let text = "";
			res.on("data", (c) => (text += c));
			res.on("end", () => {
				let json: unknown = null;
				try {
					json = JSON.parse(text);
				} catch {
					// not json
				}
				done({ status: res.statusCode ?? 0, text, json });
			});
		});
		req.on("error", fail);
		req.end(opts.body);
	});
}

async function boot() {
	running = await startServer({ dirs: [sessions], port: 0, attentionDir: join(root, "attention"), cmux: null });
	const page = await http("GET", "/");
	const token = /name="attention-token" content="([0-9a-f]+)"/.exec(page.text)![1];
	const good = { origin: `http://127.0.0.1:${running.port}`, "x-attention-token": token, "content-type": "application/json" };
	const items = (qs = "") => http("GET", `/api/memory/items${qs}`).then((r) => r.json);
	const update = (o: object, headers: Record<string, string> = good) => http("POST", "/api/memory/update", { headers, body: JSON.stringify(o) });
	return { good, items, update };
}

describe("GET /api/memory/items", () => {
	it("derives stale, atRisk and prunesOn with the same rule as prune(); filters by state, repo and query", async () => {
		writeItems(
			[
				item("fresh"),
				item("stale-10", { updated: day(-10) }),
				item("risk-54", { updated: day(-54) }),
				item("safe-53", { updated: day(-53) }),
				item("kept", { updated: day(-58), keepUntil: day(30) }),
				item("forever", { updated: day(-100), keepUntil: "forever" }),
				item("finished", { done: true, updated: day(-59) }),
				item("other-repo", { cwd: "/work/sfs", updated: day(-2) }),
			],
			"not json\n",
		);
		const { items } = await boot();
		const all = await items("?state=open");
		expect(all.version).toBe(sha(join(mem, "items.jsonl")));
		expect(all.skippedLines).toBe(1);
		expect(typeof all.readAt).toBe("number");
		const by = Object.fromEntries(all.items.map((i: any) => [i.id, i]));
		expect(by["risk-54"]).toMatchObject({ atRisk: true, stale: true, prunesOn: day(7) });
		expect(by["safe-53"]).toMatchObject({ atRisk: false, stale: true, prunesOn: day(8) });
		expect(by.kept).toMatchObject({ atRisk: false, keepUntil: day(30), prunesOn: day(31) });
		expect(by.forever).toMatchObject({ atRisk: false, prunesOn: null });
		expect(by.fresh).toMatchObject({ stale: false, atRisk: false });
		expect(by["stale-10"]).toMatchObject({ stale: true, atRisk: false });
		expect(by.finished).toBeUndefined();
		expect(all.items[0].id).toBe("risk-54");
		expect(all.counts).toEqual({ relevant: 2, stale: 5, open: 7, done: 1, atRisk: 1 });
		expect((await items("?state=relevant")).items.map((i: any) => i.id).sort()).toEqual(["fresh", "other-repo"]);
		expect((await items("?state=stale")).items).toHaveLength(5);
		expect((await items("?state=done")).items.map((i: any) => i.id)).toEqual(["finished"]);
		expect((await items("?state=open&repo=sfs")).items.map((i: any) => i.id)).toEqual(["other-repo"]);
		expect((await items("?state=open&repo=%2Fwork%2Fgls")).items).toHaveLength(6);
		expect((await items("?state=open&query=title+safe")).items.map((i: any) => i.id)).toEqual(["safe-53"]);
		expect((await http("GET", "/api/memory/items?state=bogus")).status).toBe(400);
	});

	it("is empty with version '' when the file is missing", async () => {
		rmSync(mem, { recursive: true });
		const { items } = await boot();
		expect(await items()).toMatchObject({ items: [], version: "", skippedLines: 0 });
	});
});

describe("POST /api/memory/update", () => {
	it("marks done and undoes it, restoring the previous updated day", async () => {
		writeItems([item("a", { updated: day(-20) })]);
		const { items, update } = await boot();
		const v0 = (await items("?state=open")).version;
		const done = await update({ id: "a", version: v0, done: true });
		expect(done.status).toBe(200);
		expect(done.json.item).toMatchObject({ id: "a", done: true, updated: day(0) });
		expect(done.json.version).toBe(sha(join(mem, "items.jsonl")));
		const undo = await update({ id: "a", version: done.json.version, done: false, updated: day(-20) });
		expect(undo.json.item).toMatchObject({ done: false, updated: day(-20), stale: true });
	});

	it("keeps 30 more days from the later of today and keepUntil, forever, and clears", async () => {
		writeItems([item("a", { updated: day(-55) }), item("b", { keepUntil: day(10) })]);
		const { items, update } = await boot();
		let v = (await items("?state=open")).version;
		const a = await update({ id: "a", version: v, keepUntil: "+30d" });
		expect(a.json.item).toMatchObject({ keepUntil: day(30), atRisk: false });
		const b = await update({ id: "b", version: a.json.version, keepUntil: "+30d" });
		expect(b.json.item.keepUntil).toBe(day(40));
		const f = await update({ id: "a", version: b.json.version, keepUntil: "forever" });
		expect(f.json.item).toMatchObject({ keepUntil: "forever", prunesOn: null });
		const plus = await update({ id: "a", version: f.json.version, keepUntil: "+30d" });
		expect(plus.json.item.keepUntil).toBe("forever");
		const cleared = await update({ id: "a", version: plus.json.version, keepUntil: null });
		expect(cleared.json.item.keepUntil).toBeNull();
		const dated = await update({ id: "a", version: cleared.json.version, keepUntil: day(5) });
		expect(dated.json.item.keepUntil).toBe(day(5));
		v = dated.json.version;
		expect(v).toBe(sha(join(mem, "items.jsonl")));
	});

	it("409 with the current version when the file changed; nothing is written", async () => {
		writeItems([item("a")]);
		const { items, update } = await boot();
		const v0 = (await items("?state=open")).version;
		writeItems([item("a"), item("b")]);
		const before = readFileSync(join(mem, "items.jsonl"), "utf8");
		const r = await update({ id: "a", version: v0, done: true });
		expect(r.status).toBe(409);
		expect(r.json.version).toBe(sha(join(mem, "items.jsonl")));
		expect(readFileSync(join(mem, "items.jsonl"), "utf8")).toBe(before);
		expect((await update({ id: "a", version: r.json.version, done: true })).status).toBe(200);
	});

	it("404 for an unknown id, 400 for bad bodies", async () => {
		writeItems([item("a")]);
		const { items, update } = await boot();
		const version = (await items("?state=open")).version;
		expect((await update({ id: "nope", version, done: true })).status).toBe(404);
		const bads = [{ version, done: true }, { id: "a", done: true }, { id: "a", version: "xyz", done: true }, { id: "a", version }, { id: "a", version, done: "yes" }, { id: "a", version, keepUntil: "2026-13-45" }, { id: "a", version, keepUntil: "soon" }, { id: "a", version, done: true, updated: "yesterday" }, { id: "x".repeat(300), version, done: true }];
		const got: string[] = [];
		for (const bad of bads) {
			const r = await update(bad);
			got.push(`${r.status} ${r.status === 400 ? "" : r.text} ${JSON.stringify(bad).slice(0, 70)}`);
		}
		expect(got.filter((g) => !g.startsWith("400"))).toEqual([]);
		expect(readFileSync(join(mem, "items.jsonl"), "utf8")).toContain('"done":false');
	});

	it("keeps the Host, Origin and token checks and the body bound", async () => {
		writeItems([item("a")]);
		const { good, items, update } = await boot();
		const version = (await items("?state=open")).version;
		const body = { id: "a", version, done: true };
		expect((await update(body, { origin: good.origin })).status).toBe(403);
		expect((await update(body, { ...good, "x-attention-token": "0".repeat(32) })).status).toBe(403);
		expect((await update(body, { ...good, origin: "http://evil.example" })).status).toBe(403);
		expect((await update(body, { ...good, host: "evil.example" })).status).toBe(403);
		expect((await http("POST", "/api/memory/update", { headers: good, body: JSON.stringify({ ...body, pad: "x".repeat(17_000) }) })).status).toBe(413);
		expect((await http("POST", "/api/memory/update", { headers: good, body: "{" })).status).toBe(400);
		expect((await http("GET", "/api/memory/items", { headers: { host: "evil.example" } })).status).toBe(403);
		expect(readFileSync(join(mem, "items.jsonl"), "utf8")).toContain('"done":false');
	});
});

describe("links and session counts", () => {
	const refOf = (p: string) => (p === "/served/a.jsonl" ? "0123456789abcdef" : null);

	it("classifies Jira keys, GitHub PRs, URLs by host; never links a local path", () => {
		expect(classifyLink("GLS-123", refOf)).toEqual({ kind: "jira", label: "GLS-123", href: "https://redbull-gms.atlassian.net/browse/GLS-123" });
		expect(classifyLink("AB2-9", refOf)).toMatchObject({ kind: "jira" });
		expect(classifyLink("gls-123", refOf)).toEqual({ kind: "text", label: "gls-123" });
		expect(classifyLink("G-1", refOf)).toMatchObject({ kind: "text" });
		expect(classifyLink("GLS-1 extra", refOf)).toMatchObject({ kind: "text" });
		expect(classifyLink("https://github.com/redbull/gls/pull/42/files?x=1", refOf)).toEqual({ kind: "pr", label: "PR #42", href: "https://github.com/redbull/gls/pull/42" });
		expect(classifyLink("https://github.com/redbull/gls/issues/42", refOf)).toMatchObject({ kind: "url", label: "github.com" });
		expect(classifyLink("https://docs.example.com/a/b?c=d", refOf)).toEqual({ kind: "url", label: "docs.example.com", href: "https://docs.example.com/a/b?c=d" });
		expect(classifyLink("javascript:alert(1)", refOf)).toEqual({ kind: "text", label: "javascript:alert(1)" });
		expect(classifyLink("file:///etc/passwd", refOf).kind).toBe("text");
		expect(classifyLink("/Users/x/notes.md", refOf)).toEqual({ kind: "text", label: "/Users/x/notes.md" });
		expect(classifyLink("/served/a.jsonl", refOf)).toEqual({ kind: "session", label: "Last session", ref: "0123456789abcdef" });
		expect(classifyLink("/elsewhere/b.jsonl", refOf)).toEqual({ kind: "text", label: "Session file (not available here)" });
	});

	it("serves session links as refs for served files only; counts open items per exact session file", async () => {
		const file = (name: string, id: string) => {
			const b = new SessionBuilder({ id, cwd: "/work/gls", startedAt: new Date(Date.now() - 600_000).toISOString() });
			b.system();
			b.user("go");
			b.assistant({ text: "done" });
			writeFileSync(join(sessions, name), b.toJsonl());
			return join(sessions, name);
		};
		const a = file("a.jsonl", "sess-a");
		const b = file("b.jsonl", "sess-b");
		const outside = join(root, "outside.jsonl");
		writeFileSync(outside, "{}\n");
		writeItems([
			item("one", { links: ["GLS-7", "https://github.com/o/r/pull/9", a] }),
			item("two", { links: [a, a, b] }),
			item("closed", { done: true, links: [a] }),
			item("out", { links: [outside, join(sessions, "gone.jsonl"), join(sessions, "..", "outside.jsonl")] }),
		]);
		const { items } = await boot();
		const list = (await items("?state=open")).items as any[];
		const one = list.find((i) => i.id === "one");
		expect(one.links.map((l: any) => l.label)).toEqual(["GLS-7", "PR #9"]);
		expect(one.sessionLinks).toHaveLength(1);
		expect(Object.keys(one.sessionLinks[0]).sort()).toEqual(["kind", "label", "ref"]);
		const out = list.find((i) => i.id === "out");
		expect(out.sessionLinks).toEqual([]);
		expect(out.links.map((l: any) => l.kind)).toEqual(["text", "text", "text"]);
		expect(JSON.stringify(list)).not.toContain(root);
		const att = (await http("GET", "/api/attention")).json;
		const count = (id: string) => att.sessions.find((s: any) => s.id === id).memoryCount;
		expect(count("sess-a")).toBe(2);
		expect(count("sess-b")).toBe(1);
		const ref = one.sessionLinks[0].ref;
		expect(att.sessions.find((s: any) => s.id === "sess-a").ref).toBe(ref);
		expect((await http("GET", `/api/session?ref=${ref}`)).status).toBe(200);
	});
});

describe("memory change events", () => {
	it("pushes an SSE memory event with the new version when items.jsonl changes", async () => {
		writeItems([item("a")]);
		await boot();
		const events = await new Promise<string>((done, fail) => {
			let text = "";
			const req = request({ host: "127.0.0.1", port: running!.port, path: "/events" }, (res) => {
				res.on("data", (c) => {
					text += c;
					if (text.includes("event: memory")) {
						req.destroy();
						done(text);
					}
				});
				setTimeout(() => writeItems([item("a"), item("b")]), 100);
				setTimeout(() => fail(new Error("no memory event")), 4000);
			});
			req.on("error", () => {});
			req.end();
		});
		expect(events).toContain(`"version":"${sha(join(mem, "items.jsonl"))}"`);
	});
});

describe("helpers", () => {
	it("prunesOn follows the prune() rule", () => {
		expect(prunesOn({ ...item("x"), updated: "2026-01-01", links: [] } as any)).toBe("2026-03-03");
		expect(prunesOn({ ...item("x"), updated: "2026-01-01", keepUntil: "2026-06-01", links: [] } as any)).toBe("2026-06-02");
		expect(prunesOn({ ...item("x"), updated: "2026-01-01", keepUntil: "forever", links: [] } as any)).toBeNull();
	});
	it("parseUpdate rejects empty updates", () => {
		expect(() => parseUpdate({ id: "a", version: "" })).toThrow(MemoryError);
	});
});
