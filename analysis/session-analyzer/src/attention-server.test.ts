import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionBuilder } from "../fixtures/build.ts";
import { focusedTitle, matchFocused, parseTitle, summarize, writeSubInbox } from "./attention-index.ts";
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
		expect(readdirSync(root)).not.toContain("attention");
	});

	it("413 over 16 KB; 404 for unknown session; 400 for bad fields", async () => {
		write(join(sessions, "a.jsonl"), mainSession("main-1", "reset", "/work/gls"));
		const { good } = await boot();
		const post = (path: string, o: unknown) => http("POST", path, { headers: good, body: JSON.stringify(o) }).then((r) => r.status);
		expect(await post("/api/steer", { sessionId: "main-1", text: "x".repeat(17_000) })).toBe(413);
		expect(await post("/api/steer", { sessionId: "nope", text: "x" })).toBe(404);
		expect(await post("/api/steer", { sessionId: "main-1", text: "  " })).toBe(400);
		expect(await post("/api/verdict", { catchKey: "main-1:zzz", verdict: "useful" })).toBe(404);
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
		const v = await http("POST", "/api/verdict", { headers: good, body: JSON.stringify({ catchKey: key, verdict: "useful" }) });
		expect(v.status).toBe(200);
		expect((await http("POST", "/api/verdict", { headers: good, body: JSON.stringify({ catchKey: key, verdict: "bogus" }) })).status).toBe(400);
		expect(JSON.parse(readFileSync(join(adir, "verdicts.jsonl"), "utf8").trim())).toMatchObject({ catchKey: key, verdict: "useful" });
		expect((await get()).catches[0].verdict).toBe("useful");
		const m = await http("POST", "/api/memory", { headers: good, body: JSON.stringify({ catchKey: key }) });
		expect(m.status).toBe(200);
		const item = JSON.parse(readFileSync(join(root, "mem", "items.jsonl"), "utf8").trim());
		expect(item.title).toContain("add a nullable column");
		expect(item.cwd).toBe("/work/gls");
		expect(item.links).toContain(join(sessions, "a.jsonl"));
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
