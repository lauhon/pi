/**
 * Unit tests for the pure beacon reducer.
 *
 * No filesystem, no pi, no timers: every test injects `now` and feeds events
 * directly. The ordering rules from the spec (E21, E25, E26, E10, E11) live here.
 */
import { describe, expect, it } from "vitest";
import {
	createInitialState,
	normalizeText,
	reduce,
	type BeaconEffect,
	type BeaconState,
	type InboxItem,
} from "./reducer.ts";

const TTL = 30 * 60_000;

function init(now = 1_000): BeaconState {
	return createInitialState({ idleTtlMs: TTL }, now);
}

function kinds(effects: readonly BeaconEffect[]): string[] {
	return effects.map((e) => e.type);
}

function inbox(seq: number, text: string): InboxItem {
	return { seq, name: `${String(seq).padStart(6, "0")}.md`, ok: true, text };
}

function user(id: string, text: string) {
	return { id, role: "user" as const, text };
}

function assistant(id: string, text: string) {
	return { id, role: "assistant" as const, text };
}

/** Drive a poll that finds nothing: the common "nothing happened" tick. */
function idlePoll(state: BeaconState, now: number, clientAttached = false) {
	return reduce(state, { type: "poll", now, inbox: [], control: [], clientAttached });
}

// ── 1. Injection ordering (E21) ────────────────────────────────────────

describe("injection ordering", () => {
	it("writes state=running before sending the user message", () => {
		const { state, effects } = reduce(init(), {
			type: "poll",
			now: 1_500,
			inbox: [inbox(1, "do the thing")],
			control: [],
			clientAttached: false,
		});

		const writeIdx = effects.findIndex((e) => e.type === "writeState");
		const sendIdx = effects.findIndex((e) => e.type === "sendUser");
		expect(writeIdx).toBeGreaterThanOrEqual(0);
		expect(sendIdx).toBeGreaterThanOrEqual(0);
		expect(writeIdx).toBeLessThan(sendIdx);

		const write = effects[writeIdx];
		expect(write).toMatchObject({ type: "writeState", phase: "running" });
		expect(state.phase).toBe("running");
	});

	it("renames the inbox file before sending, so a second poll cannot re-inject", () => {
		const first = reduce(init(), {
			type: "poll",
			now: 1_500,
			inbox: [inbox(1, "hello")],
			control: [],
			clientAttached: false,
		});
		expect(kinds(first.effects).indexOf("renameInbox")).toBeLessThan(
			kinds(first.effects).indexOf("sendUser"),
		);
		expect(first.effects).toContainEqual({ type: "renameInbox", name: "000001.md", to: "sent" });

		// same file still visible (rename not yet observed by the poller)
		const second = reduce(first.state, {
			type: "poll",
			now: 2_000,
			inbox: [inbox(1, "hello")],
			control: [],
			clientAttached: false,
		});
		expect(kinds(second.effects)).not.toContain("sendUser");
	});

	it("drains several inbox files in sequence order, first one steers a fresh turn", () => {
		const { effects } = reduce(init(), {
			type: "poll",
			now: 1_500,
			inbox: [inbox(2, "second"), inbox(1, "first")],
			control: [],
			clientAttached: false,
		});
		const sends = effects.filter((e) => e.type === "sendUser");
		expect(sends).toEqual([
			{ type: "sendUser", text: "first", deliverAs: undefined },
			{ type: "sendUser", text: "second", deliverAs: "followUp" },
		]);
	});

	it("delivers as followUp while the agent is streaming", () => {
		const started = reduce(init(), { type: "agentStart", now: 1_100 });
		const { effects } = reduce(started.state, {
			type: "poll",
			now: 1_500,
			inbox: [inbox(1, "mid-turn")],
			control: [],
			clientAttached: false,
		});
		expect(effects).toContainEqual({ type: "sendUser", text: "mid-turn", deliverAs: "followUp" });
	});
});

// ── 2. The idle predicate ──────────────────────────────────────────────

describe("idle predicate", () => {
	it("settling with an empty inbox and nothing in flight is idle", () => {
		const s = reduce(init(), { type: "agentStart", now: 1_100 }).state;
		const { state, effects } = reduce(s, {
			type: "agentSettled",
			now: 2_000,
			entries: [user("u1", "task"), assistant("a1", "done")],
			inbox: [],
		});
		expect(state.phase).toBe("idle");
		expect(state.since).toBe(2_000);
		expect(effects).toContainEqual({ type: "touchIdle", turn: 1 });
	});

	it("settling with an undrained inbox is NOT idle — it drains and stays running", () => {
		const s = reduce(init(), { type: "agentStart", now: 1_100 }).state;
		const { state, effects } = reduce(s, {
			type: "agentSettled",
			now: 2_000,
			entries: [user("u1", "task"), assistant("a1", "done")],
			inbox: [inbox(2, "next please")],
		});
		expect(state.phase).toBe("running");
		expect(effects).toContainEqual({ type: "sendUser", text: "next please", deliverAs: undefined });
		// the settled turn is still fully recorded
		expect(effects).toContainEqual({ type: "touchIdle", turn: 1 });
		const k = kinds(effects);
		expect(k.indexOf("touchIdle")).toBeLessThan(k.lastIndexOf("writeState"));
	});

	it("settling with an injected message not yet accounted for is NOT idle", () => {
		const injected = reduce(init(), {
			type: "poll",
			now: 1_200,
			inbox: [inbox(1, "please")],
			control: [],
			clientAttached: false,
		}).state;
		// settle arrives before the injected message showed up in the branch
		const { state } = reduce(injected, {
			type: "agentSettled",
			now: 1_300,
			entries: [],
			inbox: [],
		});
		expect(state.phase).toBe("running");
	});

	it("an open UI prompt makes the child blocked, and it survives a settle", () => {
		let s = reduce(init(), { type: "agentStart", now: 1_100 }).state;
		const opened = reduce(s, { type: "uiPromptStart", now: 1_200 });
		s = opened.state;
		expect(s.phase).toBe("blocked");
		expect(opened.effects).toContainEqual({ type: "writeState", phase: "blocked", turn: 0, since: 1_200 });

		const settled = reduce(s, {
			type: "agentSettled",
			now: 1_500,
			entries: [user("u1", "task"), assistant("a1", "done")],
			inbox: [],
		});
		expect(settled.state.phase).toBe("blocked");

		const closed = reduce(settled.state, { type: "uiPromptEnd", now: 1_600 });
		expect(closed.state.phase).toBe("idle");
	});

	it("coalesces nested UI prompts into one blocked span", () => {
		let s = reduce(init(), { type: "agentStart", now: 1_100 }).state;
		s = reduce(s, { type: "uiPromptStart", now: 1_200 }).state;
		s = reduce(s, { type: "uiPromptStart", now: 1_250 }).state;
		s = reduce(s, { type: "uiPromptEnd", now: 1_300 }).state;
		expect(s.phase).toBe("blocked");
		s = reduce(s, { type: "uiPromptEnd", now: 1_350 }).state;
		expect(s.phase).toBe("running");
	});
});

// ── 3. Ordered provenance matching (E25, E26) ──────────────────────────

describe("provenance", () => {
	it("attributes an injected message to the parent and an unknown one to the human", () => {
		const s = reduce(init(), {
			type: "poll",
			now: 1_200,
			inbox: [inbox(1, "parent text")],
			control: [],
			clientAttached: false,
		}).state;
		const { effects } = reduce(s, {
			type: "agentSettled",
			now: 2_000,
			entries: [user("u1", "parent text"), assistant("a1", "ok")],
			inbox: [],
		});
		expect(effects).toContainEqual(
			expect.objectContaining({
				type: "appendTurn",
				record: expect.objectContaining({ turn: 1, origin: "parent", inbox: [1], userEntries: ["u1"] }),
			}),
		);
	});

	it("E25: identical text typed by the human is not stolen by the parent's queue entry", () => {
		const s = reduce(init(), {
			type: "poll",
			now: 1_200,
			inbox: [inbox(1, "same words")],
			control: [],
			clientAttached: false,
		}).state;
		// human typed the exact same text right after the injection landed
		const { effects } = reduce(s, {
			type: "agentSettled",
			now: 2_000,
			entries: [user("u1", "same words"), user("u2", "same words"), assistant("a1", "ok")],
			inbox: [],
		});
		const rec = effects.find((e) => e.type === "appendTurn");
		expect(rec).toMatchObject({
			record: { origin: "mixed", inbox: [1], userEntries: ["u1", "u2"] },
		});
	});

	it("E26: several queued messages collapsing into one settle give one mixed record", () => {
		const s = reduce(init(), {
			type: "poll",
			now: 1_200,
			inbox: [inbox(7, "a"), inbox(8, "b")],
			control: [],
			clientAttached: false,
		}).state;
		const { effects } = reduce(s, {
			type: "agentSettled",
			now: 2_000,
			entries: [user("u1", "a"), user("u2", "typed"), user("u3", "b"), assistant("a1", "done")],
			inbox: [],
		});
		const rec = effects.find((e) => e.type === "appendTurn");
		expect(rec).toMatchObject({
			record: { turn: 1, origin: "mixed", inbox: [7, 8], userEntries: ["u1", "u2", "u3"] },
		});
	});

	it("matches the head only: an out-of-order match is a human message, and the queue does not shuffle", () => {
		const s = reduce(init(), {
			type: "poll",
			now: 1_200,
			inbox: [inbox(1, "alpha"), inbox(2, "beta")],
			control: [],
			clientAttached: false,
		}).state;
		// "beta" shows up first. It is NOT our queued "beta": ordered matching says
		// the parent's next message is "alpha", so this one was typed by the human.
		const settled = reduce(s, {
			type: "agentSettled",
			now: 2_000,
			entries: [user("u1", "beta"), assistant("a1", "ok")],
			inbox: [],
		});
		expect(settled.effects.find((e) => e.type === "appendTurn")).toMatchObject({
			record: { origin: "human", userEntries: ["u1"], inbox: [] },
		});
		// both injections are still outstanding, in order
		expect(settled.state.pending.map((p) => p.seq)).toEqual([1, 2]);

		const next = reduce(settled.state, {
			type: "agentSettled",
			now: 3_000,
			entries: [
				user("u1", "beta"),
				assistant("a1", "ok"),
				user("u2", "alpha"),
				user("u3", "beta"),
				assistant("a2", "ok2"),
			],
			inbox: [],
		});
		expect(next.effects.find((e) => e.type === "appendTurn")).toMatchObject({
			record: { origin: "parent", userEntries: ["u2", "u3"], inbox: [1, 2] },
		});
		expect(next.state.pending).toEqual([]);
	});

	it("consumes exactly one queue entry per matching user entry (no duplicate collapse)", () => {
		const s = reduce(init(), {
			type: "poll",
			now: 1_200,
			inbox: [inbox(1, "ping"), inbox(2, "ping")],
			control: [],
			clientAttached: false,
		}).state;
		expect(s.pending).toHaveLength(2);
		const { state, effects } = reduce(s, {
			type: "agentSettled",
			now: 2_000,
			entries: [user("u1", "ping"), assistant("a1", "ok")],
			inbox: [],
		});
		expect(effects.find((e) => e.type === "appendTurn")).toMatchObject({
			record: { origin: "parent", inbox: [1] },
		});
		expect(state.pending.map((p) => p.seq)).toEqual([2]);
	});

	it("matches across the content-array/string normalization difference (V8)", () => {
		expect(normalizeText("hello \n")).toBe(normalizeText("hello"));
		const s = reduce(init(), {
			type: "poll",
			now: 1_200,
			inbox: [inbox(1, "line one\nline two\n")],
			control: [],
			clientAttached: false,
		}).state;
		const { effects } = reduce(s, {
			type: "agentSettled",
			now: 2_000,
			entries: [user("u1", "line one\nline two"), assistant("a1", "ok")],
			inbox: [],
		});
		expect(effects.find((e) => e.type === "appendTurn")).toMatchObject({
			record: { origin: "parent" },
		});
	});

	it("does not re-account user entries that an earlier settle already covered", () => {
		let s = reduce(init(), {
			type: "poll",
			now: 1_200,
			inbox: [inbox(1, "one")],
			control: [],
			clientAttached: false,
		}).state;
		s = reduce(s, {
			type: "agentSettled",
			now: 2_000,
			entries: [user("u1", "one"), assistant("a1", "ok")],
			inbox: [],
		}).state;
		const second = reduce(s, {
			type: "agentSettled",
			now: 3_000,
			entries: [user("u1", "one"), assistant("a1", "ok"), user("u2", "two"), assistant("a2", "ok2")],
			inbox: [],
		});
		expect(second.effects.find((e) => e.type === "appendTurn")).toMatchObject({
			record: { turn: 2, origin: "human", userEntries: ["u2"] },
		});
	});

	it("labels a settle with no new user entry as unknown origin", () => {
		const { effects } = reduce(init(), {
			type: "agentSettled",
			now: 2_000,
			entries: [assistant("a1", "auto-continued")],
			inbox: [],
		});
		expect(effects.find((e) => e.type === "appendTurn")).toMatchObject({
			record: { origin: "unknown", userEntries: [], inbox: [] },
		});
	});
});

// ── 4. Turn accounting ─────────────────────────────────────────────────

describe("turn accounting", () => {
	it("numbers turns from 1 and writes out-N, the turn record and idle-N per settle", () => {
		let s = init();
		s = reduce(s, {
			type: "poll",
			now: 1_200,
			inbox: [inbox(1, "one")],
			control: [],
			clientAttached: false,
		}).state;
		const first = reduce(s, {
			type: "agentSettled",
			now: 2_000,
			entries: [user("u1", "one"), assistant("a1", "answer one")],
			inbox: [],
		});
		expect(first.effects).toContainEqual({ type: "writeOutput", turn: 1, text: "answer one" });
		expect(first.effects).toContainEqual({ type: "touchIdle", turn: 1 });
		expect(first.state.turn).toBe(1);

		s = reduce(first.state, {
			type: "poll",
			now: 3_000,
			inbox: [inbox(2, "two")],
			control: [],
			clientAttached: false,
		}).state;
		const second = reduce(s, {
			type: "agentSettled",
			now: 4_000,
			entries: [
				user("u1", "one"),
				assistant("a1", "answer one"),
				user("u2", "two"),
				assistant("a2", "answer two"),
			],
			inbox: [],
		});
		expect(second.effects).toContainEqual({ type: "writeOutput", turn: 2, text: "answer two" });
		expect(second.effects).toContainEqual({ type: "touchIdle", turn: 2 });
		expect(second.effects.find((e) => e.type === "appendTurn")).toMatchObject({
			record: { turn: 2, out: "out-2.md", inbox: [2], ts: 4_000 },
		});
	});

	it("emits out-N before idle-N so a waiter that sees the marker can read the output", () => {
		const s = reduce(init(), { type: "agentStart", now: 1_000 }).state;
		const { effects } = reduce(s, {
			type: "agentSettled",
			now: 2_000,
			entries: [user("u1", "x"), assistant("a1", "y")],
			inbox: [],
		});
		const k = kinds(effects);
		expect(k.indexOf("writeOutput")).toBeLessThan(k.indexOf("appendTurn"));
		expect(k.indexOf("appendTurn")).toBeLessThan(k.indexOf("touchIdle"));
	});
});

// ── 5. TTL guards (E10, E11) ───────────────────────────────────────────

describe("idle TTL", () => {
	function settled(now: number): BeaconState {
		const s = reduce(init(), { type: "agentStart", now: now - 100 }).state;
		return reduce(s, {
			type: "agentSettled",
			now,
			entries: [user("u1", "x"), assistant("a1", "y")],
			inbox: [],
		}).state;
	}

	it("reaps once the injected clock passes the TTL", () => {
		const s = settled(2_000);
		expect(kinds(idlePoll(s, 2_000 + TTL - 1).effects)).not.toContain("shutdown");
		const reaped = idlePoll(s, 2_000 + TTL);
		expect(kinds(reaped.effects)).toContain("shutdown");
		expect(reaped.state.quitting).toBe(true);
		// and only once
		expect(kinds(idlePoll(reaped.state, 2_000 + TTL + 5_000).effects)).not.toContain("shutdown");
	});

	it("E10: never reaps while a client is attached", () => {
		const s = settled(2_000);
		expect(kinds(idlePoll(s, 2_000 + TTL + 1, true).effects)).not.toContain("shutdown");
	});

	it("E11: never reaps with an undrained inbox — it takes the work instead", () => {
		const s = settled(2_000);
		const { effects } = reduce(s, {
			type: "poll",
			now: 2_000 + TTL + 1,
			inbox: [inbox(5, "more work")],
			control: [],
			clientAttached: false,
		});
		expect(kinds(effects)).not.toContain("shutdown");
		expect(kinds(effects)).toContain("sendUser");
	});

	it("E11: never reaps while any inbox file is still on disk, even one we already drained", () => {
		// the rename to .sent failed (read-only run dir, E14): the parent still
		// sees a queued turn, so reaping here would silently drop it
		const drainedButPresent = inbox(5, "already injected");
		let s = reduce(init(), {
			type: "poll",
			now: 1_100,
			inbox: [drainedButPresent],
			control: [],
			clientAttached: false,
		}).state;
		expect(s.drained).toContain(drainedButPresent.name);
		s = reduce(s, {
			type: "agentSettled",
			now: 2_000,
			entries: [user("u1", "already injected"), assistant("a1", "ok")],
			inbox: [],
		}).state;
		expect(s.phase).toBe("idle");

		const { effects } = reduce(s, {
			type: "poll",
			now: 2_000 + TTL + 1,
			inbox: [drainedButPresent],
			control: [],
			clientAttached: false,
		});
		expect(kinds(effects)).not.toContain("sendUser"); // not re-injected
		expect(kinds(effects)).not.toContain("shutdown"); // and not reaped
	});

	it("never reaps while running or blocked", () => {
		const running = reduce(init(), { type: "agentStart", now: 1_000 }).state;
		expect(kinds(idlePoll(running, 1_000 + TTL * 2).effects)).not.toContain("shutdown");
		const blocked = reduce(running, { type: "uiPromptStart", now: 1_100 }).state;
		expect(kinds(idlePoll(blocked, 1_100 + TTL * 2).effects)).not.toContain("shutdown");
	});

	it("reaps a child that never got a task (still starting) once the TTL passes", () => {
		expect(kinds(idlePoll(init(1_000), 1_000 + TTL).effects)).toContain("shutdown");
	});
});

// ── 6. Control verbs ───────────────────────────────────────────────────

describe("control verbs", () => {
	it("abort deletes the verb file and aborts the turn", () => {
		const running = reduce(init(), { type: "agentStart", now: 1_000 }).state;
		const { effects } = reduce(running, {
			type: "poll",
			now: 1_100,
			inbox: [],
			control: ["abort"],
			clientAttached: false,
		});
		expect(effects).toContainEqual({ type: "deleteControl", verb: "abort" });
		expect(effects).toContainEqual({ type: "abort" });
	});

	it("quit deletes the verb file and requests shutdown (deferred by pi until idle, V10)", () => {
		const running = reduce(init(), { type: "agentStart", now: 1_000 }).state;
		const { state, effects } = reduce(running, {
			type: "poll",
			now: 1_100,
			inbox: [],
			control: ["quit"],
			clientAttached: false,
		});
		expect(effects).toContainEqual({ type: "deleteControl", verb: "quit" });
		expect(effects).toContainEqual({ type: "shutdown", reason: "control" });
		expect(state.quitting).toBe(true);
	});

	it("abort runs before quit when both verbs are present", () => {
		const running = reduce(init(), { type: "agentStart", now: 1_000 }).state;
		const { effects } = reduce(running, {
			type: "poll",
			now: 1_100,
			inbox: [],
			control: ["quit", "abort"],
			clientAttached: false,
		});
		const k = kinds(effects);
		expect(k.indexOf("abort")).toBeLessThan(k.indexOf("shutdown"));
	});

	it("a quitting child does not take new inbox work", () => {
		const running = reduce(init(), { type: "agentStart", now: 1_000 }).state;
		const quitting = reduce(running, {
			type: "poll",
			now: 1_100,
			inbox: [],
			control: ["quit"],
			clientAttached: false,
		}).state;
		const { effects } = reduce(quitting, {
			type: "poll",
			now: 1_200,
			inbox: [inbox(3, "too late")],
			control: [],
			clientAttached: false,
		});
		expect(kinds(effects)).not.toContain("sendUser");
	});

	it("session shutdown records the closed state", () => {
		const s = reduce(init(), { type: "agentStart", now: 1_000 }).state;
		const { state, effects } = reduce(s, { type: "sessionShutdown", now: 5_000 });
		expect(state.phase).toBe("closed");
		expect(effects).toContainEqual({ type: "writeState", phase: "closed", turn: 0, since: 5_000 });
	});
});

// ── 7. Malformed inbox files (E19) ─────────────────────────────────────

describe("rejected inbox files", () => {
	it("logs and sidelines an unreadable file instead of injecting it", () => {
		const { state, effects } = reduce(init(), {
			type: "poll",
			now: 1_500,
			inbox: [
				{ seq: 1, name: "000001.md", ok: false, reason: "too large (300000 bytes > 262144)" },
				inbox(2, "fine"),
			],
			control: [],
			clientAttached: false,
		});
		expect(effects).toContainEqual({ type: "renameInbox", name: "000001.md", to: "rejected" });
		expect(effects.some((e) => e.type === "log" && e.message.includes("000001.md"))).toBe(true);
		const sends = effects.filter((e) => e.type === "sendUser");
		expect(sends).toHaveLength(1);
		expect(sends[0]).toMatchObject({ text: "fine" });
		expect(state.phase).toBe("running");
	});

	it("a poll that only finds rejects does not flip the child to running", () => {
		const { state, effects } = reduce(init(), {
			type: "poll",
			now: 1_500,
			inbox: [{ seq: 1, name: "000001.md", ok: false, reason: "not valid utf-8" }],
			control: [],
			clientAttached: false,
		});
		expect(state.phase).toBe("starting");
		expect(kinds(effects)).not.toContain("sendUser");
	});
});

// ── 8. Rehydration on respawn (spec: "Turn numbers belong to the run dir") ──
//
// A respawn (E4/E6) reuses the same session.jsonl and run dir, but
// createInitialState always starts a fresh process at turn 0 with an empty
// `accounted`. Without rehydration this renumbers turn 1 over the previous
// run's, overwrites out-1.md, leaves a stale idle-1, and re-counts the old
// run's user entries as new (so a parent-only turn comes out "mixed").

describe("rehydration on respawn", () => {
	it("a fresh run dir (no prior turns) is unaffected: sessionStart with turn 0 and no entries is a no-op", () => {
		const { state, effects } = reduce(init(), {
			type: "sessionStart",
			resumeTurn: 0,
			knownEntryIds: [],
		});
		expect(state.turn).toBe(0);
		expect(state.accounted).toEqual([]);
		expect(effects).toEqual([]);
	});

	it("seeds turn from the highest prior turn, so the next settle numbers turn 2, not a duplicate turn 1", () => {
		const rehydrated = reduce(init(), {
			type: "sessionStart",
			resumeTurn: 1,
			knownEntryIds: ["u1"],
		}).state;
		expect(rehydrated.turn).toBe(1);

		const settled = reduce(rehydrated, {
			type: "agentSettled",
			now: 5_000,
			entries: [user("u1", "task one"), assistant("a1", "answer one"), user("u2", "task two"), assistant("a2", "answer two")],
			inbox: [],
		});

		expect(settled.state.turn).toBe(2);
		expect(settled.effects).toContainEqual({ type: "writeOutput", turn: 2, text: "answer two" });
		expect(settled.effects).toContainEqual({ type: "touchIdle", turn: 2 });
		// no duplicate turn:1 record, and out-1.md is never touched again
		expect(settled.effects.filter((e) => e.type === "writeOutput")).toHaveLength(1);
		expect(settled.effects.find((e) => e.type === "appendTurn")).toMatchObject({
			record: { turn: 2 },
		});
	});

	it("seeded accounted ids are not re-counted: a turn covering only old entries plus one new one is not mixed", () => {
		const rehydrated = reduce(init(), {
			type: "sessionStart",
			resumeTurn: 1,
			knownEntryIds: ["u1"], // u1 was a parent-origin entry from before the respawn
		}).state;

		const s = reduce(rehydrated, {
			type: "poll",
			now: 1_200,
			inbox: [inbox(1, "post-respawn task")],
			control: [],
			clientAttached: false,
		}).state;

		// getBranch() still returns the whole session, including the pre-respawn
		// entries — u1 must not be re-attributed now that it is already accounted.
		const settled = reduce(s, {
			type: "agentSettled",
			now: 2_000,
			entries: [user("u1", "task one"), assistant("a1", "answer one"), user("u2", "post-respawn task"), assistant("a2", "answer two")],
			inbox: [],
		});

		expect(settled.effects.find((e) => e.type === "appendTurn")).toMatchObject({
			record: { turn: 2, origin: "parent", userEntries: ["u2"], inbox: [1] },
		});
	});

	it("seeding both turn and accounted together reproduces the exact smoke-tested defect fix", () => {
		// Simulates: spawn -> kill -> open (respawn) -> resume, where turns.jsonl
		// already has {turn:1, userEntries:["u1"]} from the pre-respawn run.
		const rehydrated = reduce(init(), {
			type: "sessionStart",
			resumeTurn: 1,
			knownEntryIds: ["u1"],
		}).state;

		const injected = reduce(rehydrated, {
			type: "poll",
			now: 1_200,
			inbox: [inbox(2, "resumed task")],
			control: [],
			clientAttached: false,
		}).state;
		expect(injected.phase).toBe("running");

		const settled = reduce(injected, {
			type: "agentSettled",
			now: 2_000,
			entries: [user("u1", "task one"), assistant("a1", "answer one"), user("u2", "resumed task"), assistant("a2", "answer two")],
			inbox: [],
		});

		const record = settled.effects.find((e) => e.type === "appendTurn");
		expect(record).toMatchObject({
			record: { turn: 2, origin: "parent", userEntries: ["u2"], inbox: [2], out: "out-2.md" },
		});
		expect(settled.effects).toContainEqual({ type: "writeOutput", turn: 2, text: "answer two" });
		expect(settled.effects).toContainEqual({ type: "touchIdle", turn: 2 });
		// out-1.md (the pre-respawn output) is never in this settle's effects
		expect(settled.effects.filter((e) => e.type === "writeOutput" && e.turn === 1)).toEqual([]);
	});
});
