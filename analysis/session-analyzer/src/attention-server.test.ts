import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionBuilder } from "../fixtures/build.ts";
import { focusedTitle, matchFocused, parseSteerId, parseTitle, steerId, summarize, writeSubInbox } from "./attention-index.ts";
import { createNotifier } from "./attention-notify.ts";
import { startInbox } from "../../../extensions/attention/inbox.ts";
import { clearCache, startServer, type Cmux, type RunningServer } from "./serve.ts";

const assume = { kind: "schema", decision: "add a nullable column", alternatives: ["new table"], basis: "small" };
let root: string;
let sessions: string;
let adir: string;
let running: RunningServer | undefined;
const notes: { title: string; body: string }[] = [];
let tree: unknown = null;
const cmux: Cmux = { tree: async () => tree, notify: async (title, body) => void notes.push({ title, body }) };

function write(path: string, b: SessionBuilder) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, b.toJsonl());
}
function mainSession(id: string, name: string, cwd: string) {
	const b = new SessionBuilder({ id, cwd, startedAt: new Date(Date.now() - 3600_000).toISOString() });
	b.system();
	b.sessionInfo(name);
	b.user("go");
	b.toolTurn("assumption", assume, "Noted", { usage: { cost: 0.1 } });
	b.assistant({ text: "done" });
	return b;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "attn-srv-"));
	sessions = join(root, "sessions");
	adir = join(root, "attention");
	process.env.WORK_MEMORY_DIR = join(root, "mem");
	notes.length = 0;
	tree = null;
	clearCache();
});
afterEach(async () => {
	await running?.close();
	running = undefined;
	delete process.env.WORK_MEMORY_DIR;
	rmSync(root, { recursive: true, force: true });
});

function http(method: string, path: string, opts: { headers?: Record<string, string>; body?: string } = {}) {
	return new Promise<{ status: number; text: string }>((done, fail) => {
		const req = request({ host: "127.0.0.1", port: running!.port, method, path, headers: opts.headers }, (res) => {
			let text = "";
			res.on("data", (c) => (text += c));
			res.on("end", () => done({ status: res.statusCode ?? 0, text }));
		});
		req.on("error", fail);
		req.end(opts.body);
	});
}

async function boot() {
	running = await startServer({ dirs: [sessions], port: 0, attentionDir: adir, cmux });
	const page = await http("GET", "/");
	const token = /name="attention-token" content="([0-9a-f]+)"/.exec(page.text)![1];
	const good = { origin: `http://127.0.0.1:${running.port}`, "x-attention-token": token, "content-type": "application/json" };
	const get = async () => JSON.parse((await http("GET", "/api/attention")).text);
	return { token, good, get };
}

describe("/api/attention", () => {
	it("lists sessions, catches, nests sub-runs, marks the focused session", async () => {
		write(join(sessions, "a.jsonl"), mainSession("main-1", "reset", "/work/gls"));
		write(join(sessions, "b.jsonl"), mainSession("main-2", "other", "/work/gls"));
		const run = join(sessions, "run-deploy");
		write(join(run, "session.jsonl"), mainSession("sub-1", "ignored", "/work/gls"));
		writeFileSync(join(run, "parent"), "main-1\n");
		tree = { windows: [{ active: true, workspaces: [{ selected: true, panes: [{ focused: true, surfaces: [{ selected: true, title: "π - reset - gls" }] }] }] }] };
		const { get } = await boot();
		const body = await get();
		expect(body.focused).toBe("main-1");
		expect(body.sessions.map((s: { id: string }) => s.id).sort()).toEqual(["main-1", "main-2"]);
		const main1 = body.sessions.find((s: { id: string }) => s.id === "main-1");
		expect(main1.subs.map((s: { name: string }) => s.name)).toEqual(["run-deploy"]);
		expect(main1).toMatchObject({ project: "gls", name: "reset", status: "waiting" });
		expect(main1.ageDays).toBeGreaterThan(0);
		expect(body.catches).toHaveLength(3);
		expect(body.catches[0]).toMatchObject({ kind: "schema", decision: "add a nullable column", verdict: null });
		expect(body.stats.catches).toBe(3);
	});

	it("notifies once per new catch from an unfocused session, none for the focused one or old catches", async () => {
		write(join(sessions, "old.jsonl"), mainSession("old", "old", "/work/gls"));
		tree = { windows: [{ active: true, workspaces: [{ selected: true, panes: [{ focused: true, surfaces: [{ selected: true, title: "π - focus - gls" }] }] }] }] };
		await boot();
		await new Promise((r) => setTimeout(r, 100));
		const later = (id: string, name: string) => {
			const b = new SessionBuilder({ id, cwd: "/work/gls", startedAt: new Date(Date.now() + 5000).toISOString() });
			b.system();
			b.sessionInfo(name);
			b.user("go");
			b.toolTurn("assumption", assume, "Noted");
			return b;
		};
		write(join(sessions, "new.jsonl"), later("new", "elsewhere"));
		write(join(sessions, "focus.jsonl"), later("focus", "focus"));
		await new Promise((r) => setTimeout(r, 1800));
		write(join(sessions, "new.jsonl"), later("new", "elsewhere"));
		await new Promise((r) => setTimeout(r, 1500));
		expect(notes).toEqual([{ title: "gls: assumption", body: "add a nullable column" }]);
	});
});

function shaped(id: string, name: string, shape: "waiting" | "working" | "working-catch", hoursAgo = 1) {
	const b = new SessionBuilder({ id, cwd: "/work/gls", startedAt: new Date(Date.now() - hoursAgo * 3600_000).toISOString() });
	b.system();
	b.sessionInfo(name);
	b.user("go");
	if (shape === "waiting") b.assistant({ text: "done" });
	if (shape === "working-catch") b.toolTurn("assumption", assume, "Noted", { usage: { cost: 0.1 } });
	return b;
}

describe("rail: status, sort, focus", () => {
	it("orders waiting, working with a catch, working, idle; groups by last update; hides the tail behind earlier", async () => {
		const at = (file: string, agoMs: number) => utimesSync(file, new Date(Date.now() - agoMs), new Date(Date.now() - agoMs));
		const put = (file: string, b: SessionBuilder, agoMs: number) => {
			write(join(sessions, file), b);
			at(join(sessions, file), agoMs);
		};
		put("idle-old.jsonl", shaped("idle-old", "i0", "waiting", 5), 10 * 60_000);
		put("work.jsonl", shaped("work", "w", "working"), 30_000);
		put("work-catch.jsonl", shaped("work-catch", "wc", "working-catch"), 90_000);
		put("wait-a.jsonl", shaped("wait-a", "wa", "waiting", 1), 20 * 60_000);
		put("wait-b.jsonl", shaped("wait-b", "wb", "waiting", 1), 10 * 60_000);
		for (let i = 0; i < 4; i++) put(`idle-${i}.jsonl`, shaped(`idle-${i}`, `i${i}`, "waiting", 6), (2 + i) * 60_000);
		const run = join(sessions, "run-orphan");
		write(join(run, "session.jsonl"), shaped("orph", "o", "waiting", 6));
		writeFileSync(join(run, "parent"), "gone");
		const { get } = await boot();
		const body = await get();
		const list = body.sessions as { id: string; group: string; status: string; earlier: boolean; orphan?: boolean; actionable: number }[];
		const parents = list.filter((s) => !s.orphan);
		expect(parents.map((s) => s.id).slice(0, 5)).toEqual(["wait-b", "wait-a", "work-catch", "work", "idle-0"]);
		expect(parents.map((s) => s.group).slice(0, 5)).toEqual(["waiting", "waiting", "working-catch", "working", "idle"]);
		expect(parents.find((s) => s.id === "work-catch")!.actionable).toBe(1);
		expect(parents.filter((s) => s.earlier).map((s) => s.id)).toEqual(["idle-2", "idle-3", "idle-old"]);
		expect(parents.filter((s) => !s.earlier)).toHaveLength(6);
		expect(list.find((s) => s.orphan)).toMatchObject({ id: "orph", earlier: false });
	});

	it("waiting needs a last assistant message under 2 h old", async () => {
		write(join(sessions, "new.jsonl"), shaped("recent", "r", "waiting", 1));
		write(join(sessions, "old.jsonl"), shaped("stale", "s", "waiting", 3));
		const { get } = await boot();
		const by = Object.fromEntries((await get()).sessions.map((s: { id: string; status: string }) => [s.id, s.status]));
		expect(by).toEqual({ recent: "waiting", stale: "idle" });
	});

	it("focus is unknown when cmux fails or answers null; known when the tree answers", async () => {
		write(join(sessions, "a.jsonl"), mainSession("main-1", "reset", "/work/gls"));
		const failing: Cmux = { tree: async () => Promise.reject(new Error("access denied")), notify: async () => {} };
		running = await startServer({ dirs: [sessions], port: 0, attentionDir: adir, cmux: failing });
		expect(JSON.parse((await http("GET", "/api/attention")).text)).toMatchObject({ focusKnown: false, focused: null });
		await running.close();
		running = undefined;
		const { get } = await boot();
		expect(await get()).toMatchObject({ focusKnown: false, focused: null });
		await running!.close();
		running = undefined;
		tree = { windows: [] };
		expect(await (await boot()).get()).toMatchObject({ focusKnown: true, focused: null });
	});

	it("serves refs, never paths, and resolves a ref only inside the served dirs", async () => {
		write(join(sessions, "a.jsonl"), mainSession("main-1", "reset", "/work/gls"));
		const { get } = await boot();
		const body = await get();
		expect(JSON.stringify(body)).not.toContain(root);
		const ref = body.sessions[0].ref as string;
		expect(ref).toMatch(/^[0-9a-f]{16}$/);
		const series = await http("GET", `/api/session?ref=${ref}`);
		expect(series.status).toBe(200);
		expect(JSON.parse(series.text).points.length).toBeGreaterThan(0);
		expect((await http("GET", `/api/request?ref=${ref}&i=0`)).status).toBe(200);
		expect((await http("GET", `/api/session?ref=${"0".repeat(16)}`)).status).toBe(404);
		expect((await http("GET", "/api/session?ref=../../etc/passwd")).status).toBe(400);
		expect((await http("GET", "/api/session?path=/etc/passwd")).status).toBe(400);
	});
});

describe("POST security", () => {
	it("403 without token, with wrong token, wrong origin, wrong host", async () => {
		write(join(sessions, "a.jsonl"), mainSession("main-1", "reset", "/work/gls"));
		const { good } = await boot();
		const body = JSON.stringify({ sessionId: "main-1", text: "x" });
		const no = (h: Record<string, string>) => http("POST", "/api/steer", { headers: h, body }).then((r) => r.status);
		expect(await no({ origin: good.origin })).toBe(403);
		expect(await no({ ...good, "x-attention-token": "0".repeat(32) })).toBe(403);
		expect(await no({ ...good, origin: "http://evil.example" })).toBe(403);
		expect(await no({ "x-attention-token": good["x-attention-token"] })).toBe(403);
		expect(await no({ ...good, host: "evil.example" })).toBe(403);
		expect(await no({ ...good, host: "evil.example" })).toBe(403);
		expect(await http("GET", "/api/attention", { headers: { host: "evil.example" } }).then((r) => r.status)).toBe(403);
		expect(await http("PUT", "/api/steer", { headers: good }).then((r) => r.status)).toBe(405);
		// only the notifier's own bookkeeping may exist; no rejected POST wrote anything
		expect((existsSync(adir) ? readdirSync(adir) : []).filter((f) => f !== "notified.json")).toEqual([]);
	});

	it("413 over 16 KB; 404 for unknown session; 400 for bad fields", async () => {
		write(join(sessions, "a.jsonl"), mainSession("main-1", "reset", "/work/gls"));
		const { good } = await boot();
		const post = (path: string, o: unknown) => http("POST", path, { headers: good, body: JSON.stringify(o) }).then((r) => r.status);
		expect(await post("/api/steer", { sessionId: "main-1", text: "x".repeat(17_000) })).toBe(413);
		expect(await post("/api/steer", { sessionId: "nope", text: "x" })).toBe(404);
		expect(await post("/api/steer", { sessionId: "main-1", text: "  " })).toBe(400);
		expect(await post("/api/verdict", { catchKey: "main-1:zzz", verdict: "agree" })).toBe(404);
		expect(await http("POST", "/api/steer", { headers: good, body: "{" }).then((r) => r.status)).toBe(400);
	});
});

describe("POST actions", () => {
	it("steer writes a main-session file and a sub-run inbox file", async () => {
		write(join(sessions, "a.jsonl"), mainSession("main-1", "reset", "/work/gls"));
		const run = join(sessions, "run-x");
		write(join(run, "session.jsonl"), mainSession("sub-1", "s", "/work/gls"));
		writeFileSync(join(run, "parent"), "main-1");
		mkdirSync(join(run, "inbox"));
		writeFileSync(join(run, "inbox", "000004.md.sent"), "old");
		const { good } = await boot();
		const post = (o: unknown) => http("POST", "/api/steer", { headers: good, body: JSON.stringify(o) });
		expect((await post({ sessionId: "main-1", text: "also the UI" })).status).toBe(200);
		expect((await post({ sessionId: "main-1", text: "second" })).status).toBe(200);
		const files = readdirSync(join(adir, "steer", "main-1")).sort();
		expect(files).toHaveLength(2);
		expect(files[0]).toMatch(/^\d{13}-\d{4}\.md$/);
		expect(readFileSync(join(adir, "steer", "main-1", files[0]), "utf8")).toBe("also the UI");
		expect((await post({ sessionId: "sub-1", text: "to sub" })).status).toBe(200);
		expect(readFileSync(join(run, "inbox", "000005.md"), "utf8")).toBe("[from attention view] to sub");
	});

	it("verdict appends to verdicts.jsonl and shows on the catch; memory creates an item", async () => {
		write(join(sessions, "a.jsonl"), mainSession("main-1", "reset", "/work/gls"));
		const { good, get } = await boot();
		const key = (await get()).catches[0].key as string;
		const v = await http("POST", "/api/verdict", { headers: good, body: JSON.stringify({ catchKey: key, verdict: "agree" }) });
		expect(v.status).toBe(200);
		expect((await http("POST", "/api/verdict", { headers: good, body: JSON.stringify({ catchKey: key, verdict: "bogus" }) })).status).toBe(400);
		expect(JSON.parse(readFileSync(join(adir, "verdicts.jsonl"), "utf8").trim())).toMatchObject({ catchKey: key, verdict: "agree" });
		expect((await get()).catches[0].verdict).toBe("agree");
		expect((await http("POST", "/api/verdict", { headers: good, body: JSON.stringify({ catchKey: key, verdict: "none" }) })).status).toBe(200);
		expect((await get()).catches[0].verdict).toBeNull();
		await http("POST", "/api/verdict", { headers: good, body: JSON.stringify({ catchKey: key, verdict: "agree" }) });
		const m = await http("POST", "/api/memory", { headers: good, body: JSON.stringify({ catchKey: key }) });
		expect(m.status).toBe(200);
		const item = JSON.parse(readFileSync(join(root, "mem", "items.jsonl"), "utf8").trim());
		expect(item.title).toContain("add a nullable column");
		expect(item.cwd).toBe("/work/gls");
		expect(item.links).toContain(join(sessions, "a.jsonl"));
	});
});

const later = (id: string, name: string, kind = "schema") => {
	const b = new SessionBuilder({ id, cwd: "/work/gls", startedAt: new Date(Date.now() + 5000).toISOString() });
	b.system();
	b.sessionInfo(name);
	b.user("go");
	b.toolTurn("assumption", { ...assume, kind }, "Noted");
	return b;
};
const focusTree = (title: string) => ({ windows: [{ active: true, workspaces: [{ selected: true, panes: [{ focused: true, surfaces: [{ selected: true, title }] }] }] }] });

describe("decisions", () => {
	it("tiers scope/schema on working sessions first, unfocused before focused, oldest first, repeats collapsed; handled drop out", async () => {
		const mk = (id: string, name: string, startedMin: number, calls: { kind: string; decision: string }[], working: boolean) => {
			const b = new SessionBuilder({ id, cwd: "/work/gls", startedAt: new Date(Date.now() - startedMin * 60_000).toISOString() });
			b.system();
			b.sessionInfo(name);
			b.user("go");
			b.assistant({ toolCalls: calls.map((c) => ({ name: "assumption", args: { ...assume, ...c } })) });
			if (!working) b.assistant({ text: "done" });
			else b.toolTurn("bash", {}, "r");
			return b;
		};
		write(join(sessions, "a.jsonl"), mk("old-scope", "a", 50, [{ kind: "scope", decision: "A" }], true));
		write(join(sessions, "b.jsonl"), mk("new-scope", "b", 10, [{ kind: "scope", decision: "B1" }, { kind: "schema", decision: "B2" }], true));
		write(join(sessions, "c.jsonl"), mk("focused-scope", "c", 90, [{ kind: "scope", decision: "C" }], true));
		write(join(sessions, "d.jsonl"), mk("waiting", "d", 5, [{ kind: "other", decision: "D" }], false));
		write(join(sessions, "e.jsonl"), mk("idle", "e", 600, [{ kind: "scope", decision: "E" }], false));
		write(join(sessions, "f.jsonl"), mk("idle-recent", "f", 180, [{ kind: "scope", decision: "F" }], false));
		tree = focusTree("π - c - gls");
		const { get, good } = await boot();
		const body = await get();
		const text = (keys: string[]) => keys.map((k) => body.catches.find((c: { key: string }) => c.key === k).decision);
		expect(body.decisions.map((d: { keys: string[]; tier: number }) => [d.tier, text(d.keys)])).toEqual([
			[1, ["A"]],
			[1, ["B1", "B2"]],
			[1, ["C"]],
			[2, ["F"]],
			[2, ["D"]],
		]);
		const e = body.catches.find((c: { decision: string }) => c.decision === "E");
		expect([e.actionable, e.passed]).toEqual([false, true]);
		expect(body.stats.passed).toBe(1);
		const first = body.catches.find((c: { decision: string }) => c.decision === "A").key;
		await http("POST", "/api/verdict", { headers: good, body: JSON.stringify({ catchKey: first, verdict: "noise" }) });
		expect((await get()).decisions).toHaveLength(4);
		const f = body.catches.find((c: { decision: string }) => c.decision === "F").key;
		await http("POST", "/api/verdict", { headers: good, body: JSON.stringify({ catchKey: f, verdict: "agree" }) });
		const after = await get();
		expect(after.decisions).toHaveLength(3);
		expect(after.stats).toMatchObject({ agree: 1, noise: 1, passed: 1 });
		expect(after.catches.find((c: { key: string }) => c.key === f)).toMatchObject({ verdict: "agree", actionable: false, passed: false });
	});
});

describe("notifications", () => {
	it("one per new catch from an unfocused, non-idle session; nothing when focus is unknown", async () => {
		write(join(sessions, "old.jsonl"), mainSession("old", "old", "/work/gls"));
		tree = null;
		await boot();
		await new Promise((r) => setTimeout(r, 100));
		write(join(sessions, "new.jsonl"), later("new", "elsewhere"));
		await new Promise((r) => setTimeout(r, 1800));
		expect(notes).toEqual([]);
		expect(JSON.parse(readFileSync(join(adir, "notified.json"), "utf8")).keys.length).toBeGreaterThan(1);
	});

	it("rate limits per session, combines repeats, and persists keys across restarts", async () => {
		const sent: { title: string; body: string }[] = [];
		const dir = join(root, "n");
		const open = () => createNotifier({ dir, windowMs: 120, send: async (title, body) => void sent.push({ title, body }) });
		let n = open();
		const item = (key: string, sessionId = "s1") => ({ key, sessionId, project: "gls", decision: `d-${key}` });
		n.queue([item("k1")]);
		n.queue([item("k2"), item("k3")]);
		n.queue([item("k4", "s2")]);
		await new Promise((r) => setTimeout(r, 40));
		expect(sent.map((s) => s.body)).toEqual(["d-k1", "d-k4"]);
		await new Promise((r) => setTimeout(r, 200));
		expect(sent.map((s) => [s.title, s.body])).toEqual([
			["gls: assumption", "d-k1"],
			["gls: assumption", "d-k4"],
			["gls: 2 assumptions", "d-k2 (+1 more)"],
		]);
		n.close();
		n = open();
		expect(["k1", "k2", "k3", "k4"].every((k) => n.has(k))).toBe(true);
		expect(n.has("k5")).toBe(false);
		n.close();
	});

	it("drops a queued catch that was handled before the window ended", async () => {
		const sent: string[] = [];
		const handled = new Set<string>();
		const n = createNotifier({ dir: join(root, "n2"), windowMs: 80, send: async (_t, b) => void sent.push(b), stillOpen: (k) => !handled.has(k) });
		const item = (key: string) => ({ key, sessionId: "s", project: "p", decision: key });
		n.queue([item("a")]);
		n.queue([item("b")]);
		handled.add("b");
		await new Promise((r) => setTimeout(r, 200));
		expect(sent).toEqual(["a"]);
		n.close();
	});
});

describe("steer status", () => {
	it("returns an id; reports pending, sent and rejected from the inbox file suffix (extension contract)", async () => {
		write(join(sessions, "a.jsonl"), mainSession("main-1", "reset", "/work/gls"));
		const { good } = await boot();
		const status = async (id: string) => http("GET", `/api/steer/status?id=${id}`).then((r) => ({ code: r.status, ...JSON.parse(r.text) }));
		const post = (text: string) => http("POST", "/api/steer", { headers: good, body: JSON.stringify({ sessionId: "main-1", text }) }).then((r) => JSON.parse(r.text));
		const first = await post("hello");
		expect(first.inbox).toBe("none");
		expect(await status(first.id)).toMatchObject({ code: 200, state: "pending" });
		const dir = join(adir, "steer", "main-1");
		const second = await post("big");
		expect((await post("again")).inbox).toBe("open");
		const big = readdirSync(dir).sort()[1];
		writeFileSync(join(dir, big), "x".repeat(70 * 1024));
		const delivered: string[] = [];
		const inbox = startInbox({ sendUserMessage: (t) => void delivered.push(t as string) }, { dir: adir, sessionId: "main-1", isIdle: () => true, every: () => () => {} });
		await inbox.poll();
		expect(delivered).toEqual(["[from attention view] hello", "[from attention view] again"]);
		expect(await status(first.id)).toMatchObject({ code: 200, state: "sent" });
		expect(await status(second.id)).toMatchObject({ code: 200, state: "rejected", reason: expect.stringContaining("too large") });
	});

	it("covers sub-run inbox files and rejects bad ids", async () => {
		write(join(sessions, "a.jsonl"), mainSession("main-1", "reset", "/work/gls"));
		const run = join(sessions, "run-x");
		write(join(run, "session.jsonl"), mainSession("sub-1", "s", "/work/gls"));
		writeFileSync(join(run, "parent"), "main-1");
		const { good } = await boot();
		const posted = JSON.parse((await http("POST", "/api/steer", { headers: good, body: JSON.stringify({ sessionId: "sub-1", text: "to sub" }) })).text);
		const get = (id: string) => http("GET", `/api/steer/status?id=${encodeURIComponent(id)}`);
		expect(JSON.parse((await get(posted.id)).text).state).toBe("pending");
		renameSync(join(run, "inbox", "000001.md"), join(run, "inbox", "000001.md.sent"));
		expect(JSON.parse((await get(posted.id)).text).state).toBe("sent");
		expect((await get("%2e%2e")).status).toBe(400);
		expect((await get("")).status).toBe(400);
		expect((await get(steerId({ sessionId: "nobody", name: "000001.md" }))).status).toBe(404);
		expect((await get(steerId({ sessionId: "sub-1", name: "000009.md" }))).status).toBe(404);
		expect(parseSteerId(Buffer.from(JSON.stringify(["main-1", "../../x.md"])).toString("base64url"))).toBeNull();
	});
});

describe("save to memory from a catch", () => {
	it("appends saved.jsonl, shows Saved on the catch with the item id, creates no second item", async () => {
		write(join(sessions, "a.jsonl"), mainSession("main-1", "reset", "/work/gls"));
		const { good, get } = await boot();
		const c0 = (await get()).catches[0];
		expect(c0).toMatchObject({ saved: null, memoryDraft: { title: expect.stringContaining("add a nullable column"), status: "assumption to review" } });
		const save = (o: object) => http("POST", "/api/memory", { headers: good, body: JSON.stringify({ catchKey: c0.key, ...o }) }).then((r) => JSON.parse(r.text));
		const a = await save({ title: "My title", status: "check later" });
		expect(a).toMatchObject({ ok: true, existing: false });
		const b = await save({ title: "Other title" });
		expect(b).toMatchObject({ itemId: a.itemId, existing: true, added: [] });
		const lines = readFileSync(join(root, "mem", "items.jsonl"), "utf8").trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0])).toMatchObject({ id: a.itemId, title: "My title", status: "check later" });
		const saved = readFileSync(join(adir, "saved.jsonl"), "utf8").trim().split("\n");
		expect(saved).toHaveLength(1);
		expect(JSON.parse(saved[0])).toMatchObject({ catchKey: c0.key, itemId: a.itemId });
		expect((await get()).catches[0].saved).toMatchObject({ itemId: a.itemId });
	});
});

describe("helpers", () => {
	it("parses titles and finds the focused surface and session", () => {
		expect(parseTitle("π - reset - gls")).toEqual({ name: "reset", project: "gls" });
		expect(parseTitle("π - a - b - gls")).toEqual({ name: "a - b", project: "gls" });
		expect(parseTitle("π - gls")).toEqual({ name: null, project: "gls" });
		expect(parseTitle("Terminal")).toBeNull();
		expect(focusedTitle({ windows: [{ workspaces: [] }] })).toBeNull();
		expect(focusedTitle(null)).toBeNull();
	});

	it("looks past the view's own window to the pi tab on the other monitor", () => {
		const win = (active: boolean, title: string) => ({
			active,
			visible: true,
			workspaces: [{ selected: true, panes: [{ focused: true, surfaces: [{ selected: true, title }] }] }],
		});
		expect(focusedTitle({ windows: [win(false, "π - gls"), win(true, "pi context")] })).toBe("π - gls");
		expect(focusedTitle({ windows: [win(false, "π - gls"), win(true, "π - sfs")] })).toBe("π - sfs");
		expect(focusedTitle({ windows: [{ ...win(false, "π - gls"), visible: false }] })).toBeNull();
	});

	it("matches by project and name, null when unknown", () => {
		const dir = mkdtempSync(join(tmpdir(), "attn-h-"));
		const f = join(dir, "a.jsonl");
		write(f, mainSession("m", "reset", "/w/gls"));
		const s = summarize(f, Date.now(), readFileSync(f).length)!;
		expect(matchFocused("π - reset - gls", [s])).toBe("m");
		expect(matchFocused("π - other - gls", [s])).toBeNull();
		expect(matchFocused("π - gls", [s])).toBeNull();
		expect(matchFocused(null, [s])).toBeNull();
		rmSync(dir, { recursive: true });
	});

	it("sub inbox sequence skips taken names", () => {
		const dir = mkdtempSync(join(tmpdir(), "attn-i-"));
		mkdirSync(join(dir, "inbox"));
		writeFileSync(join(dir, "inbox", "000002.md.rejected"), "");
		expect(writeSubInbox(dir, "x")).toBe(join(dir, "inbox", "000003.md"));
		rmSync(dir, { recursive: true });
	});
});

describe("page routes", () => {
	const ref = "0123456789abcdef";
	const pages = ["/", "/memory", "/memory/pick-up-x-1", "/memory?state=done&q=a%20b&repo=%2Fw&session=" + ref, "/decision/s-1:e-2", "/decision/s-1%3Ae-2", "/session/" + ref, "/session/" + ref + "?request=3"];
	const bad = ["/review", "/decision", "/decision/", "/decision/nocolon", "/decision/a:b:c", "/decision/a%2F:b", "/memory/", "/memory/Upper", "/memory/" + "a".repeat(81), "/memory/a/b", "/session/abc", "/session/" + ref.toUpperCase(), "/session/" + ref + "/x", "/decision/%E0%A4%A:x", "/index.html"];

	it("serves the page with token and boot meta on every route", async () => {
		await boot();
		const root = (await http("GET", "/")).text;
		for (const path of pages) {
			const r = await http("GET", path);
			expect(r.status, path).toBe(200);
			expect(r.text, path).toMatch(/name="attention-token" content="[0-9a-f]{32}"/);
			expect(r.text, path).toMatch(/name="attention-boot" content="[0-9a-f]{16}"/);
			expect(r.text.replace(/content="[0-9a-f]+"/g, ""), path).toBe(root.replace(/content="[0-9a-f]+"/g, ""));
		}
	});

	it("404s other shapes and bad segments", async () => {
		await boot();
		for (const path of bad) expect((await http("GET", path)).status, path).toBe(404);
	});

	it("still applies the Host check and leaves POST on page paths rejected", async () => {
		await boot();
		for (const path of pages) expect((await http("GET", path, { headers: { host: "evil.example" } })).status, path).toBe(403);
		expect((await http("POST", "/memory", { headers: { origin: `http://127.0.0.1:${running!.port}` }, body: "{}" })).status).toBe(403);
	});
});
