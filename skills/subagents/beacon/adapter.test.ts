/**
 * Filesystem-level tests for the beacon adapter.
 *
 * Real temp run dirs, real file writes, a mocked pi (see premium-usage tests for
 * the mock style), an injected clock and an injected scheduler. Nothing sleeps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBeacon, type Beacon, type ManualScheduler } from "./index.ts";

// ── Mocks ──────────────────────────────────────────────────────────────

type Handler = (event: unknown, ctx: unknown) => unknown;

interface MockPi {
	on: ReturnType<typeof vi.fn>;
	sendUserMessage: ReturnType<typeof vi.fn>;
	_emit: (event: string, payload?: unknown) => Promise<void>;
	_handlers: Record<string, Handler[]>;
	_ctx: MockCtx;
}

interface BranchMessage {
	id: string;
	role: "user" | "assistant";
	content: string | Array<{ type: string; text?: string }>;
}

interface MockCtx {
	abort: ReturnType<typeof vi.fn>;
	shutdown: ReturnType<typeof vi.fn>;
	sessionManager: { getBranch: () => unknown[] };
	_branch: BranchMessage[];
}

function createMockPi(): MockPi {
	const handlers: Record<string, Handler[]> = {};
	const branch: BranchMessage[] = [];
	const ctx: MockCtx = {
		abort: vi.fn(),
		shutdown: vi.fn(),
		sessionManager: {
			getBranch: () =>
				branch.map((m) => ({
					type: "message",
					id: m.id,
					message: { role: m.role, content: m.content },
				})),
		},
		_branch: branch,
	};
	const pi: MockPi = {
		on: vi.fn((event: string, handler: Handler) => {
			(handlers[event] ??= []).push(handler);
		}),
		sendUserMessage: vi.fn(),
		_handlers: handlers,
		_ctx: ctx,
		_emit: async (event, payload) => {
			for (const fn of handlers[event] ?? []) await fn(payload ?? {}, ctx);
		},
	};
	return pi;
}

/** A hand-cranked scheduler: no wall-clock timers anywhere in these tests. */
function manualScheduler(): ManualScheduler {
	let tick: (() => void | Promise<void>) | undefined;
	return {
		every(_ms, fn) {
			tick = fn;
			return () => {
				tick = undefined;
			};
		},
		async tick() {
			await tick?.();
		},
		get running() {
			return tick !== undefined;
		},
	};
}

// ── Fixture ────────────────────────────────────────────────────────────

const TTL = 30 * 60_000;

let runDir: string;
let pi: MockPi;
let scheduler: ManualScheduler;
let beacon: Beacon;
let clock = 1_000;
let logs: string[];

function makeBeacon(overrides: Parameters<typeof createBeacon>[1] extends infer O ? Partial<O> : never = {}) {
	logs = [];
	scheduler = manualScheduler();
	return createBeacon(pi as never, {
		runDir,
		idleTtlMs: TTL,
		pollMs: 500,
		now: () => clock,
		scheduler,
		isClientAttached: async () => false,
		log: (line: string) => logs.push(line),
		...overrides,
	});
}

function writeInbox(seq: number, text: string | Buffer) {
	mkdirSync(path.join(runDir, "inbox"), { recursive: true });
	writeFileSync(path.join(runDir, "inbox", `${String(seq).padStart(6, "0")}.md`), text);
}

function writeControl(verb: string) {
	mkdirSync(path.join(runDir, "control"), { recursive: true });
	writeFileSync(path.join(runDir, "control", verb), "");
}

function readState(): { state: string; turn: number; since: number; pid: number } {
	return JSON.parse(readFileSync(path.join(runDir, "state.json"), "utf8"));
}

function readTurns(): Array<Record<string, unknown>> {
	const raw = readFileSync(path.join(runDir, "turns.jsonl"), "utf8");
	return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** Push a message into the mocked session branch, the way pi would persist it. */
function branchUser(id: string, text: string) {
	pi._ctx._branch.push({ id, role: "user", content: [{ type: "text", text }] });
}
function branchAssistant(id: string, text: string) {
	pi._ctx._branch.push({ id, role: "assistant", content: [{ type: "text", text }] });
}

beforeEach(() => {
	clock = 1_000;
	runDir = mkdtempSync(path.join(os.tmpdir(), "pi-sub-beacon-"));
	pi = createMockPi();
	beacon = makeBeacon();
});

afterEach(() => {
	beacon.stop();
	rmSync(runDir, { recursive: true, force: true });
});

// ── Wiring ─────────────────────────────────────────────────────────────

describe("wiring", () => {
	it("subscribes to the events the lifecycle needs", () => {
		const events = pi.on.mock.calls.map((c) => c[0]);
		expect(events).toEqual(
			expect.arrayContaining([
				"session_start",
				"agent_start",
				"agent_settled",
				"ui_prompt_start",
				"ui_prompt_end",
				"session_shutdown",
			]),
		);
	});

	it("writes state.json=starting on session_start so the child is never mistaken for beaconless", async () => {
		await pi._emit("session_start");
		expect(readState()).toMatchObject({ state: "starting", turn: 0 });
		expect(readState().pid).toBe(process.pid);
		expect(scheduler.running).toBe(true);
	});

	it("stops polling on session_shutdown and records state=closed", async () => {
		await pi._emit("session_start");
		clock = 9_000;
		await pi._emit("session_shutdown");
		expect(readState()).toMatchObject({ state: "closed", since: 9_000 });
		expect(scheduler.running).toBe(false);
	});
});

// ── Inbox drain ────────────────────────────────────────────────────────

describe("inbox drain", () => {
	it("injects turn 1 from the inbox and marks the file .sent", async () => {
		writeInbox(1, "do the thing\n");
		await pi._emit("session_start");

		expect(pi.sendUserMessage).toHaveBeenCalledWith("do the thing\n", undefined);
		expect(readState()).toMatchObject({ state: "running" });
		expect(existsSync(path.join(runDir, "inbox", "000001.md"))).toBe(false);
		expect(existsSync(path.join(runDir, "inbox", "000001.md.sent"))).toBe(true);
	});

	it("E21: state.json says running before sendUserMessage is called", async () => {
		const order: string[] = [];
		pi.sendUserMessage.mockImplementation(() => {
			order.push(`send:${readState().state}`);
		});
		writeInbox(1, "go");
		await pi._emit("session_start");
		expect(order).toEqual(["send:running"]);
	});

	it("E3: drains several files in sequence order on one poll", async () => {
		await pi._emit("session_start");
		writeInbox(3, "third");
		writeInbox(1, "first");
		writeInbox(2, "second");
		await scheduler.tick();
		expect(pi.sendUserMessage.mock.calls.map((c) => c[0])).toEqual(["first", "second", "third"]);
	});

	it("delivers as followUp while the agent is streaming", async () => {
		await pi._emit("session_start");
		await pi._emit("agent_start");
		writeInbox(1, "mid-turn");
		await scheduler.tick();
		expect(pi.sendUserMessage).toHaveBeenCalledWith("mid-turn", { deliverAs: "followUp" });
	});

	it("does not re-inject a file it already drained", async () => {
		writeInbox(1, "once");
		await pi._emit("session_start");
		await scheduler.tick();
		await scheduler.tick();
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
	});

	it("E19: rejects an oversized file with a log line instead of crashing", async () => {
		writeInbox(1, "x".repeat(300_000));
		writeInbox(2, "small");
		await pi._emit("session_start");

		expect(pi.sendUserMessage.mock.calls.map((c) => c[0])).toEqual(["small"]);
		expect(existsSync(path.join(runDir, "inbox", "000001.md.rejected"))).toBe(true);
		expect(logs.join("\n")).toMatch(/000001\.md.*too large/);
	});

	it("E19: rejects a non-UTF8 file", async () => {
		writeInbox(1, Buffer.from([0xff, 0xfe, 0x00, 0x80]));
		await pi._emit("session_start");
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
		expect(existsSync(path.join(runDir, "inbox", "000001.md.rejected"))).toBe(true);
		expect(logs.join("\n")).toMatch(/utf-?8/i);
	});

	it("rejects an empty file rather than injecting a blank turn", async () => {
		writeInbox(1, "");
		await pi._emit("session_start");
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
		expect(existsSync(path.join(runDir, "inbox", "000001.md.rejected"))).toBe(true);
	});

	it("ignores files that do not look like inbox entries", async () => {
		mkdirSync(path.join(runDir, "inbox"), { recursive: true });
		writeFileSync(path.join(runDir, "inbox", "notes.txt"), "ignore me");
		writeFileSync(path.join(runDir, "inbox", "000004.md.sent"), "already sent");
		await pi._emit("session_start");
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
		expect(existsSync(path.join(runDir, "inbox", "notes.txt"))).toBe(true);
	});

	it("falls back to followUp when pi refuses a plain send because it is streaming", async () => {
		await pi._emit("session_start");
		pi.sendUserMessage.mockImplementationOnce(() => {
			throw new Error("Agent is streaming, specify deliverAs");
		});
		writeInbox(1, "racy");
		await scheduler.tick();
		expect(pi.sendUserMessage).toHaveBeenNthCalledWith(1, "racy", undefined);
		expect(pi.sendUserMessage).toHaveBeenNthCalledWith(2, "racy", { deliverAs: "followUp" });
	});
});

// ── Settles, turns, outputs ────────────────────────────────────────────

describe("settle accounting", () => {
	it("writes out-N.md, turns.jsonl, idle-N and state=idle", async () => {
		writeInbox(1, "task one");
		await pi._emit("session_start");
		branchUser("u1", "task one");
		branchAssistant("a1", "the answer");
		clock = 5_000;
		await pi._emit("agent_settled");

		expect(readFileSync(path.join(runDir, "out-1.md"), "utf8")).toBe("the answer");
		expect(existsSync(path.join(runDir, "idle-1"))).toBe(true);
		expect(readState()).toMatchObject({ state: "idle", turn: 1, since: 5_000 });
		expect(readTurns()).toEqual([
			{ turn: 1, origin: "parent", userEntries: ["u1"], inbox: [1], out: "out-1.md", ts: 5_000 },
		]);
	});

	it("E26: several queued inbox files collapsing into one settle give one mixed record", async () => {
		writeInbox(7, "a");
		writeInbox(8, "b");
		await pi._emit("session_start");
		branchUser("u1", "a");
		branchUser("u2", "typed by a human");
		branchUser("u3", "b");
		branchAssistant("a1", "done");
		clock = 6_000;
		await pi._emit("agent_settled");

		expect(readTurns()).toEqual([
			{
				turn: 1,
				origin: "mixed",
				userEntries: ["u1", "u2", "u3"],
				inbox: [7, 8],
				out: "out-1.md",
				ts: 6_000,
			},
		]);
	});

	it("E25: identical text typed by the human is attributed to the human", async () => {
		writeInbox(1, "same words");
		await pi._emit("session_start");
		branchUser("u1", "same words");
		branchUser("u2", "same words");
		branchAssistant("a1", "ok");
		await pi._emit("agent_settled");
		expect(readTurns()[0]).toMatchObject({ origin: "mixed", inbox: [1] });
	});

	it("normalizes string content the same as content arrays (V8)", async () => {
		writeInbox(1, "hello there\n");
		await pi._emit("session_start");
		pi._ctx._branch.push({ id: "u1", role: "user", content: "hello there" });
		branchAssistant("a1", "hi");
		await pi._emit("agent_settled");
		expect(readTurns()[0]).toMatchObject({ origin: "parent" });
	});

	it("ignores thinking and toolCall blocks when picking the assistant output", async () => {
		await pi._emit("session_start");
		pi._ctx._branch.push({
			id: "a1",
			role: "assistant",
			content: [
				{ type: "thinking", text: "hmm" },
				{ type: "text", text: "visible answer" },
			],
		});
		pi._ctx._branch.push({
			id: "a2",
			role: "assistant",
			content: [{ type: "toolCall", text: undefined } as { type: string; text?: string }],
		});
		await pi._emit("agent_settled");
		expect(readFileSync(path.join(runDir, "out-1.md"), "utf8")).toBe("visible answer");
	});

	it("an undrained inbox at settle time keeps the child running (not idle)", async () => {
		writeInbox(1, "one");
		await pi._emit("session_start");
		branchUser("u1", "one");
		branchAssistant("a1", "done one");
		writeInbox(2, "two");
		await pi._emit("agent_settled");

		expect(readState().state).toBe("running");
		expect(existsSync(path.join(runDir, "idle-1"))).toBe(true);
		expect(pi.sendUserMessage).toHaveBeenCalledWith("two", undefined);
	});

	it("E22: an open UI prompt makes state blocked and survives a settle", async () => {
		await pi._emit("session_start");
		await pi._emit("agent_start");
		clock = 2_000;
		await pi._emit("ui_prompt_start");
		expect(readState()).toMatchObject({ state: "blocked", since: 2_000 });
		await pi._emit("agent_settled");
		expect(readState().state).toBe("blocked");
		clock = 3_000;
		await pi._emit("ui_prompt_end");
		expect(readState()).toMatchObject({ state: "idle", since: 3_000 });
	});
});

// ── TTL ────────────────────────────────────────────────────────────────

describe("idle TTL", () => {
	async function becomeIdle() {
		await pi._emit("session_start");
		branchUser("u1", "x");
		branchAssistant("a1", "y");
		clock = 2_000;
		await pi._emit("agent_settled");
	}

	it("shuts down once the injected clock passes the TTL", async () => {
		await becomeIdle();
		clock = 2_000 + TTL - 1;
		await scheduler.tick();
		expect(pi._ctx.shutdown).not.toHaveBeenCalled();
		clock = 2_000 + TTL;
		await scheduler.tick();
		expect(pi._ctx.shutdown).toHaveBeenCalledTimes(1);
	});

	it("E10: never reaps while a client is attached", async () => {
		beacon.stop();
		pi = createMockPi();
		beacon = makeBeacon({ isClientAttached: async () => true });
		await becomeIdle();
		clock = 2_000 + TTL * 2;
		await scheduler.tick();
		expect(pi._ctx.shutdown).not.toHaveBeenCalled();
	});

	it("E11: never reaps with an undrained inbox", async () => {
		await becomeIdle();
		writeInbox(9, "more work");
		clock = 2_000 + TTL * 2;
		await scheduler.tick();
		expect(pi._ctx.shutdown).not.toHaveBeenCalled();
		expect(pi.sendUserMessage).toHaveBeenCalledWith("more work", undefined);
	});

	it("E11: a file the parent can still see blocks the reap even if we already drained it", async () => {
		await becomeIdle();
		// simulate a rename that never landed: the parent still sees a queued turn
		writeInbox(9, "queued");
		await scheduler.tick();
		expect(pi.sendUserMessage).toHaveBeenCalledWith("queued", undefined);
		writeInbox(9, "queued"); // reappears; already drained, so never re-injected
		clock = 2_000 + TTL * 2;
		await scheduler.tick();
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(pi._ctx.shutdown).not.toHaveBeenCalled();
	});

	it("only probes tmux for attachment when the TTL is actually in play", async () => {
		beacon.stop();
		pi = createMockPi();
		const isClientAttached = vi.fn(async () => false);
		beacon = makeBeacon({ isClientAttached });
		await becomeIdle();
		clock = 2_500;
		await scheduler.tick();
		expect(isClientAttached).not.toHaveBeenCalled();
		clock = 2_000 + TTL;
		await scheduler.tick();
		expect(isClientAttached).toHaveBeenCalled();
	});
});

// ── Control verbs ──────────────────────────────────────────────────────

describe("control verbs", () => {
	it("abort calls ctx.abort() and removes the verb file", async () => {
		await pi._emit("session_start");
		await pi._emit("agent_start");
		writeControl("abort");
		await scheduler.tick();
		expect(pi._ctx.abort).toHaveBeenCalledTimes(1);
		expect(existsSync(path.join(runDir, "control", "abort"))).toBe(false);
	});

	it("quit calls ctx.shutdown() (V10: pi defers it until idle) and removes the verb file", async () => {
		await pi._emit("session_start");
		writeControl("quit");
		await scheduler.tick();
		expect(pi._ctx.shutdown).toHaveBeenCalledTimes(1);
		expect(existsSync(path.join(runDir, "control", "quit"))).toBe(false);
	});

	it("aborts before quitting when both verbs are dropped at once", async () => {
		const order: string[] = [];
		await pi._emit("session_start");
		pi._ctx.abort.mockImplementation(() => order.push("abort"));
		pi._ctx.shutdown.mockImplementation(() => order.push("shutdown"));
		writeControl("quit");
		writeControl("abort");
		await scheduler.tick();
		expect(order).toEqual(["abort", "shutdown"]);
	});

	it("ignores unknown verbs", async () => {
		await pi._emit("session_start");
		writeControl("explode");
		await scheduler.tick();
		expect(pi._ctx.abort).not.toHaveBeenCalled();
		expect(pi._ctx.shutdown).not.toHaveBeenCalled();
		expect(existsSync(path.join(runDir, "control", "explode"))).toBe(true);
	});
});

// ── Rehydration on respawn ───────────────────────────────────────────
//
// A respawn (sub kill -> sub open) starts a brand-new beacon process on the
// same run dir/session.jsonl. It must pick up where turns.jsonl left off,
// not renumber from turn 0.

describe("rehydration on respawn", () => {
	function writeTurns(records: Array<Record<string, unknown>>) {
		writeFileSync(
			path.join(runDir, "turns.jsonl"),
			records.map((r) => JSON.stringify(r)).join("\n") + "\n",
		);
	}

	it("continues turn numbering across a respawn instead of restarting at turn 1", async () => {
		writeTurns([
			{ turn: 1, origin: "parent", userEntries: ["u1"], inbox: [1], out: "out-1.md", ts: 1_000 },
		]);
		writeFileSync(path.join(runDir, "out-1.md"), "pre-respawn answer");

		// the new process's branch still contains the pre-respawn entries, the
		// way a real pi session.jsonl would after a respawn on the same file
		branchUser("u1", "task one");
		branchAssistant("a1", "pre-respawn answer");

		await pi._emit("session_start");
		writeInbox(2, "post-respawn task");
		await scheduler.tick();

		branchUser("u2", "post-respawn task");
		branchAssistant("a2", "post-respawn answer");
		clock = 9_000;
		await pi._emit("agent_settled");

		expect(readTurns()).toEqual([
			{ turn: 1, origin: "parent", userEntries: ["u1"], inbox: [1], out: "out-1.md", ts: 1_000 },
			{ turn: 2, origin: "parent", userEntries: ["u2"], inbox: [2], out: "out-2.md", ts: 9_000 },
		]);
		expect(readState()).toMatchObject({ state: "idle", turn: 2 });
		// out-1.md, the pre-respawn output, is never overwritten
		expect(readFileSync(path.join(runDir, "out-1.md"), "utf8")).toBe("pre-respawn answer");
		expect(readFileSync(path.join(runDir, "out-2.md"), "utf8")).toBe("post-respawn answer");
		expect(existsSync(path.join(runDir, "idle-1"))).toBe(false); // never rewritten by the new process
		expect(existsSync(path.join(runDir, "idle-2"))).toBe(true);
	});

	it("does not re-count pre-respawn user entries as fresh (origin stays parent, not mixed)", async () => {
		writeTurns([
			{ turn: 1, origin: "parent", userEntries: ["u1"], inbox: [1], out: "out-1.md", ts: 1_000 },
		]);
		branchUser("u1", "task one");
		branchAssistant("a1", "pre-respawn answer");

		await pi._emit("session_start");
		writeInbox(2, "post-respawn task");
		await scheduler.tick();
		branchUser("u2", "post-respawn task");
		branchAssistant("a2", "post-respawn answer");
		await pi._emit("agent_settled");

		expect(readTurns()[1]).toMatchObject({ origin: "parent", userEntries: ["u2"] });
	});

	it("a fresh run dir with no turns.jsonl starts at turn 1 as before (no false rehydration)", async () => {
		writeInbox(1, "task one");
		await pi._emit("session_start");
		branchUser("u1", "task one");
		branchAssistant("a1", "answer one");
		await pi._emit("agent_settled");
		expect(readTurns()).toEqual([
			{ turn: 1, origin: "parent", userEntries: ["u1"], inbox: [1], out: "out-1.md", ts: expect.any(Number) },
		]);
	});

	it("skips a malformed trailing line in turns.jsonl instead of crashing rehydration", async () => {
		// Simulates a crash mid-write: the last line is truncated JSON.
		writeFileSync(
			path.join(runDir, "turns.jsonl"),
			`${JSON.stringify({ turn: 1, origin: "parent", userEntries: ["u1"], inbox: [1], out: "out-1.md", ts: 1_000 })}\n{"turn":2,"unterm\n`,
		);
		branchUser("u1", "task one");
		branchAssistant("a1", "pre-respawn answer");

		await expect(pi._emit("session_start")).resolves.toBeUndefined();
		// resumes from the last well-formed record (turn 1), not from the
		// truncated one, and did not throw
		expect(readState()).toMatchObject({ turn: 1 });

		writeInbox(2, "next");
		await scheduler.tick();
		branchUser("u2", "next");
		branchAssistant("a2", "next answer");
		await pi._emit("agent_settled");
		expect(readState()).toMatchObject({ turn: 2, state: "idle" });
	});
});

// ── Robustness ─────────────────────────────────────────────────────────

describe("robustness", () => {
	it("E27: state.json is written tmp+rename, so no reader ever sees a partial file", async () => {
		await pi._emit("session_start");
		// every write leaves exactly one state.json and no leftover temp files
		writeInbox(1, "go");
		await scheduler.tick();
		const { readdirSync } = await import("node:fs");
		const leftovers = readdirSync(runDir).filter((f) => f.startsWith("state.json") && f !== "state.json");
		expect(leftovers).toEqual([]);
		expect(() => readState()).not.toThrow();
	});

	it("E14: the run dir vanishing under a live child logs but does not throw", async () => {
		await pi._emit("session_start");
		rmSync(runDir, { recursive: true, force: true });
		writeInbox(1, "revived");
		rmSync(runDir, { recursive: true, force: true });
		await expect(scheduler.tick()).resolves.toBeUndefined();
		await expect(pi._emit("agent_settled")).resolves.toBeUndefined();
		expect(logs.join("\n")).not.toBe("");
	});

	it("keeps working after the run dir comes back", async () => {
		await pi._emit("session_start");
		rmSync(runDir, { recursive: true, force: true });
		await scheduler.tick();
		mkdirSync(runDir, { recursive: true });
		writeInbox(1, "hello again");
		await scheduler.tick();
		expect(pi.sendUserMessage).toHaveBeenCalledWith("hello again", undefined);
	});

	it("does nothing at all when no run dir is configured", async () => {
		beacon.stop();
		pi = createMockPi();
		const inert = createBeacon(pi as never, { runDir: undefined, now: () => clock });
		await pi._emit("session_start");
		expect(existsSync(path.join(runDir, "state.json"))).toBe(false);
		inert.stop();
	});

	it("does not overlap polls: a tick that lands while one is suspended is dropped", async () => {
		beacon.stop();
		pi = createMockPi();
		let release: (() => void) | undefined;
		let attachProbes = 0;
		beacon = makeBeacon({
			isClientAttached: async () => {
				attachProbes++;
				await new Promise<void>((r) => {
					release = r;
				});
				return true;
			},
		});
		await pi._emit("session_start");

		// TTL in play -> the poll suspends inside the attach probe
		clock = 1_000 + TTL;
		const first = scheduler.tick();
		await Promise.resolve();
		expect(attachProbes).toBe(1);

		await scheduler.tick(); // reentrant tick while the first is suspended
		expect(attachProbes).toBe(1);

		release?.();
		await first;
		expect(pi._ctx.shutdown).not.toHaveBeenCalled(); // client attached -> E10
	});
});
