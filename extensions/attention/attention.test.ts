import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register, { NOTED, Params } from "./index.ts";
import { PREFIX, startInbox, type Inbox } from "./inbox.ts";

const dirs: string[] = [];
const inboxes: Inbox[] = [];
afterEach(() => {
	for (const i of inboxes.splice(0)) i.stop();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	delete process.env.PI_ATTENTION_DIR;
});
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), "attn-"));
	dirs.push(d);
	return d;
};

describe("assumption tool", () => {
	it("registers, returns immediately, keeps the prompt text short", async () => {
		const tools: any[] = [];
		register({ registerTool: (t: any) => tools.push(t), on: () => {} } as any);
		const t = tools[0];
		expect(t.name).toBe("assumption");
		const res = await t.execute("id", { kind: "scope", decision: "x" });
		expect(res.content[0].text).toBe(NOTED);
		expect(t.promptGuidelines.every((g: string) => g.includes("assumption"))).toBe(true);
		const added = t.promptSnippet.length + t.promptGuidelines.join("").length;
		expect(added).toBeLessThan(600);
	});

	it("schema: kind enum, decision max 200, optional rest", () => {
		const p = Params as any;
		expect(p.required.sort()).toEqual(["decision", "kind"]);
		expect(p.properties.kind.enum).toEqual(["scope", "schema", "other"]);
		expect(p.properties.decision.maxLength).toBe(200);
	});
});

describe("steer inbox", () => {
	function setup(idle: boolean, failPlain = false, failAll = false) {
		const root = tmp();
		const sent: { text: string; opts: unknown }[] = [];
		const pi = {
			sendUserMessage(text: string, opts?: unknown) {
				if (failAll) throw new Error("boom");
				if (failPlain && !opts) throw new Error("streaming");
				sent.push({ text, opts });
			},
		};
		const inbox = startInbox(pi, { dir: root, sessionId: "s1", isIdle: () => idle, every: () => () => {} });
		inboxes.push(inbox);
		const dir = join(root, "steer", "s1");
		return { dir, sent, inbox };
	}

	it("delivers in name order, prefixes, renames to .sent", async () => {
		const { dir, sent, inbox } = setup(true);
		writeFileSync(join(dir, "2-0.md"), "second");
		writeFileSync(join(dir, "1-0.md"), "first");
		writeFileSync(join(dir, "note.txt"), "ignored");
		await inbox.poll();
		expect(sent.map((s) => s.text)).toEqual([PREFIX + "first", PREFIX + "second"]);
		expect(readdirSync(dir).sort()).toEqual(["1-0.md.sent", "2-0.md.sent", "note.txt"]);
		await inbox.poll();
		expect(sent).toHaveLength(2);
	});

	it("idle sends a plain prompt; streaming steers", async () => {
		const a = setup(true);
		writeFileSync(join(a.dir, "1.md"), "x");
		await a.inbox.poll();
		expect(a.sent[0].opts).toBeUndefined();
		const b = setup(false);
		writeFileSync(join(b.dir, "1.md"), "x");
		await b.inbox.poll();
		expect(b.sent[0].opts).toEqual({ deliverAs: "steer" });
	});

	it("retries as steer when the plain send loses the streaming race", async () => {
		const { dir, sent, inbox } = setup(true, true);
		writeFileSync(join(dir, "1.md"), "x");
		await inbox.poll();
		expect(sent[0].opts).toEqual({ deliverAs: "steer" });
		expect(existsSync(join(dir, "1.md.sent"))).toBe(true);
	});

	it("rejects with a reason on failure and on empty files", async () => {
		const { dir, inbox } = setup(true, false, true);
		writeFileSync(join(dir, "1.md"), "x");
		writeFileSync(join(dir, "2.md"), "  \n");
		await inbox.poll();
		expect(readdirSync(dir).sort()).toEqual(["1.md.reason.txt", "1.md.rejected", "2.md.reason.txt", "2.md.rejected"]);
	});

	it("wires session_start and session_shutdown", async () => {
		const root = tmp();
		process.env.PI_ATTENTION_DIR = root;
		const handlers: Record<string, any> = {};
		register({ registerTool() {}, on: (e: string, h: any) => (handlers[e] = h), sendUserMessage() {} } as any);
		await handlers.session_start({}, { isIdle: () => true, sessionManager: { getSessionId: () => "abc" } });
		expect(existsSync(join(root, "steer", "abc"))).toBe(true);
		await handlers.session_shutdown({});
		mkdirSync(join(root, "x"), { recursive: true });
	});
});
