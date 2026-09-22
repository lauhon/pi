/**
 * Tests for the subagents-monitor observer core (extensions/subagents-monitor/index.ts).
 *
 * No real filesystem, no real tmux, no wall-clock sleeps: `collectRun` /
 * `classifyTurns` / `transition` / `render` are pure and take an explicit
 * `now`; `createMonitor` is driven with in-memory fakes for fs/tmux/ui/parent.
 *
 * See skills/subagents/spec-interactive-children.md.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_CONFIG,
	SUB_VERBS,
	classifyTurns,
	collectRun,
	createMonitor,
	deriveState,
	parseSession,
	render,
	selectVisibleRuns,
	transition,
	type ChildState,
	type DirMemory,
	type FsAdapter,
	type MonitorConfig,
	type Notice,
	type PendingHuman,
	type Run,
	type RunSnapshot,
	type TmuxAdapter,
	type TurnRecord,
	type UiAdapter,
} from "./index.ts";

const CONFIG: MonitorConfig = DEFAULT_CONFIG;

// ── Fixture builders ──────────────────────────────────────────────────────

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
	return {
		dir: "/runs/20260101-000000-child",
		name: "child",
		alive: true,
		attached: false,
		model: "github-copilot/claude-haiku-4.5",
		stateJson: { state: "running", turn: 1, since: 1_000 },
		spawnedAtSecs: 1,
		sessionMtimeMs: 1_000,
		parsedSession: { stats: { tokens: 0, contextTokens: 0, compactions: 0, cost: 0, lastActivity: "" }, userText: new Map(), pendingTool: undefined },
		...overrides,
	};
}

function turn(overrides: Partial<TurnRecord> & { turn: number }): TurnRecord {
	return { origin: "parent", userEntries: [], inbox: [], out: `out-${overrides.turn}.md`, ts: 0, ...overrides };
}

function run(overrides: Partial<Run> = {}): Run {
	return {
		dir: "/runs/x",
		name: "x",
		model: "m",
		state: "running",
		turn: 1,
		since: 0,
		spawnedAtMs: 0,
		elapsedMs: 0,
		attached: false,
		stats: { tokens: 0, contextTokens: 0, compactions: 0, cost: 0, lastActivity: "" },
		sessionMtimeMs: undefined,
		pendingTool: undefined,
		stallHint: undefined,
		...overrides,
	};
}

// ── collectRun / deriveState: agree with `sub`'s derive_state on the same fixture ──

describe("collectRun state derivation", () => {
	const cases: Array<[string, Partial<RunSnapshot>, ChildState]> = [
		["alive + recorded running -> running", { alive: true, stateJson: { state: "running" } }, "running"],
		["alive + recorded idle -> idle", { alive: true, stateJson: { state: "idle" } }, "idle"],
		["alive + recorded blocked -> blocked", { alive: true, stateJson: { state: "blocked" } }, "blocked"],
		["alive + recorded closed (tmux still up) -> closed", { alive: true, stateJson: { state: "closed" } }, "closed"],
		["alive + no state.json, young -> starting", { alive: true, stateJson: undefined, spawnedAtSecs: 100 }, "starting"],
		["alive + no state.json, old -> beaconless", { alive: true, stateJson: undefined, spawnedAtSecs: 0 }, "beaconless"],
		["not alive + recorded idle -> dead", { alive: false, stateJson: { state: "idle" } }, "dead"],
		["not alive + recorded closed -> closed", { alive: false, stateJson: { state: "closed" } }, "closed"],
		["not alive + no state.json -> dead", { alive: false, stateJson: undefined }, "dead"],
	];

	for (const [label, overrides, expected] of cases) {
		it(label, () => {
			const input = snapshot(overrides);
			const now = 100_500; // 100s after spawnedAtSecs=100 -> young; way past spawnedAtSecs=0 -> old
			expect(deriveState(input, now, CONFIG.beaconlessMs)).toBe(expected);
			expect(collectRun(input, now, CONFIG).state).toBe(expected);
		});
	}

	it("matches sub's derive_state boundary: beaconless right at the threshold", () => {
		const input = snapshot({ alive: true, stateJson: undefined, spawnedAtSecs: 100 });
		expect(deriveState(input, 100_000 + CONFIG.beaconlessMs - 1, CONFIG.beaconlessMs)).toBe("starting");
		expect(deriveState(input, 100_000 + CONFIG.beaconlessMs, CONFIG.beaconlessMs)).toBe("beaconless");
	});
});

describe("parseSession", () => {
	function line(obj: unknown): string {
		return JSON.stringify(obj);
	}

	it("tracks tokens, cost, compactions and the last user text", () => {
		const raw = [
			line({ type: "message", id: "u1", message: { role: "user", content: "hello" } }),
			line({
				type: "message",
				id: "a1",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hi" }],
					usage: { totalTokens: 42, cost: { total: 0.01 } },
				},
			}),
			line({ type: "compaction" }),
		].join("\n");
		const parsed = parseSession(raw);
		expect(parsed.stats.tokens).toBe(42);
		expect(parsed.stats.contextTokens).toBe(42);
		expect(parsed.stats.compactions).toBe(1);
		expect(parsed.stats.cost).toBeCloseTo(0.01);
		expect(parsed.stats.lastActivity).toContain("responding");
		expect(parsed.userText.get("u1")).toBe("hello");
		expect(parsed.pendingTool).toBeUndefined();
	});

	it("reports a pending tool call with no matching toolResult", () => {
		const raw = [
			line({
				type: "message",
				id: "a1",
				message: { role: "assistant", content: [{ type: "toolCall", id: "call1", name: "bash", arguments: { command: "find / -name x" } }] },
			}),
		].join("\n");
		const parsed = parseSession(raw);
		expect(parsed.pendingTool).toEqual({ id: "call1", name: "bash find / -name x" });
	});

	it("clears the pending tool call once its toolResult lands", () => {
		const raw = [
			line({
				type: "message",
				id: "a1",
				message: { role: "assistant", content: [{ type: "toolCall", id: "call1", name: "ls", arguments: {} }] },
			}),
			line({ type: "message", id: "r1", message: { role: "toolResult", toolCallId: "call1", content: "ok" } }),
		].join("\n");
		expect(parseSession(raw).pendingTool).toBeUndefined();
	});

	it("tolerates a partial trailing line", () => {
		const raw = `${line({ type: "message", id: "u1", message: { role: "user", content: "x" } })}\n{"type":"mess`;
		expect(() => parseSession(raw)).not.toThrow();
		expect(parseSession(raw).userText.get("u1")).toBe("x");
	});
});

// ── Stall hint: provider-wait never notifies, a stuck tool notifies once ──

describe("stall hint", () => {
	it("running with no open tool call is provider-wait, never a notification-worthy state", () => {
		const r = run({ state: "running", since: 0, sessionMtimeMs: 0, pendingTool: undefined });
		const input = snapshot({
			alive: true,
			stateJson: { state: "running", since: 0 },
			sessionMtimeMs: 0,
			parsedSession: { stats: r.stats, userText: new Map(), pendingTool: undefined },
		});
		const collected = collectRun(input, 5 * 60_000, CONFIG); // 5 minutes of "silence"
		expect(collected.stallHint?.kind).toBe("provider-wait");
	});

	it("an open tool call under the threshold produces no stall hint", () => {
		const input = snapshot({
			alive: true,
			stateJson: { state: "running", since: 0 },
			sessionMtimeMs: 0,
			parsedSession: {
				stats: { tokens: 0, contextTokens: 0, compactions: 0, cost: 0, lastActivity: "" },
				userText: new Map(),
				pendingTool: { id: "call1", name: "bash find /" },
			},
		});
		const collected = collectRun(input, CONFIG.toolStallMs - 1, CONFIG);
		expect(collected.stallHint).toBeUndefined();
	});

	it("an open tool call past the threshold is a stuck-tool hint naming the tool", () => {
		const input = snapshot({
			alive: true,
			stateJson: { state: "running", since: 0 },
			sessionMtimeMs: 0,
			parsedSession: {
				stats: { tokens: 0, contextTokens: 0, compactions: 0, cost: 0, lastActivity: "" },
				userText: new Map(),
				pendingTool: { id: "call1", name: "bash find / -name x" },
			},
		});
		const collected = collectRun(input, CONFIG.toolStallMs + 1, CONFIG);
		expect(collected.stallHint).toEqual({ kind: "stuck-tool", elapsedMs: CONFIG.toolStallMs + 1, tool: "bash find / -name x" });
	});

	it("transition notifies once per stuck tool-call id, not every tick", () => {
		const r = run({
			state: "running",
			pendingTool: { id: "call1", name: "find" },
			stallHint: { kind: "stuck-tool", elapsedMs: CONFIG.toolStallMs, tool: "find" },
		});
		const first = transition(undefined, r, [], new Map(), CONFIG, false, 1000);
		expect(first.notices.filter((n) => n.kind === "stall")).toHaveLength(1);

		const second = transition(first.memory, r, [], new Map(), CONFIG, false, 2000);
		expect(second.notices.filter((n) => n.kind === "stall")).toHaveLength(0);

		// a *different* stuck tool call gets its own notice
		const r2 = run({
			...r,
			pendingTool: { id: "call2", name: "grep" },
			stallHint: { kind: "stuck-tool", elapsedMs: CONFIG.toolStallMs, tool: "grep" },
		});
		const third = transition(second.memory, r2, [], new Map(), CONFIG, false, 3000);
		expect(third.notices.filter((n) => n.kind === "stall")).toHaveLength(1);
	});

	it("never notifies for provider-wait, regardless of how long", () => {
		const r = run({ state: "running", stallHint: { kind: "provider-wait", elapsedMs: 10 * 60_000 } });
		const result = transition(undefined, r, [], new Map(), CONFIG, false, 1000);
		expect(result.notices.filter((n) => n.kind === "stall")).toHaveLength(0);
	});
});

// ── classifyTurns: notification rules ──────────────────────────────────

describe("classifyTurns", () => {
	it("a new parent-origin record produces a completion notice", () => {
		const r = run({ state: "idle" });
		const turns = [turn({ turn: 1, origin: "parent", ts: 1000 })];
		const result = classifyTurns({ run: r, turns, seenTurn: 0, pendingHuman: undefined, firstTick: false, now: 1000, userText: new Map() }, CONFIG);
		expect(result.notices).toHaveLength(1);
		expect(result.notices[0].kind).toBe("completion");
		expect(result.seenTurn).toBe(1);
	});

	it("a mixed-origin record is treated as parent", () => {
		const r = run({ state: "idle" });
		const turns = [turn({ turn: 1, origin: "mixed", ts: 1000 })];
		const result = classifyTurns({ run: r, turns, seenTurn: 0, pendingHuman: undefined, firstTick: false, now: 1000, userText: new Map() }, CONFIG);
		expect(result.notices).toHaveLength(1);
		expect(result.notices[0].kind).toBe("completion");
	});

	it("an unknown-origin record is silent", () => {
		const r = run({ state: "idle" });
		const turns = [turn({ turn: 1, origin: "unknown", ts: 1000 })];
		const result = classifyTurns({ run: r, turns, seenTurn: 0, pendingHuman: undefined, firstTick: false, now: 1000, userText: new Map() }, CONFIG);
		expect(result.notices).toHaveLength(0);
		expect(result.pendingHuman).toBeUndefined();
		expect(result.seenTurn).toBe(1);
	});

	it("a human-origin record accumulates but does not notify immediately", () => {
		const r = run({ state: "idle" });
		const userText = new Map([["e1", "actually skip the ingest package"]]);
		const turns = [turn({ turn: 1, origin: "human", userEntries: ["e1"], ts: 1000 })];
		const result = classifyTurns({ run: r, turns, seenTurn: 0, pendingHuman: undefined, firstTick: false, now: 1000, userText }, CONFIG);
		expect(result.notices).toHaveLength(0);
		expect(result.pendingHuman?.turns).toEqual([{ turn: 1, text: "actually skip the ingest package" }]);
	});

	it("flushes one note with the verbatim text after the debounce window", () => {
		const r = run({ state: "idle" });
		const userText = new Map([["e1", "actually skip the ingest package"]]);
		const pendingHuman: PendingHuman = { turns: [{ turn: 1, text: "actually skip the ingest package" }], lastTs: 1000 };
		const result = classifyTurns(
			{ run: r, turns: [], seenTurn: 1, pendingHuman, firstTick: false, now: 1000 + CONFIG.humanDebounceMs, userText },
			CONFIG,
		);
		expect(result.notices).toHaveLength(1);
		expect(result.notices[0].kind).toBe("human");
		expect((result.notices[0] as Extract<Notice, { kind: "human" }>).text).toContain(
			"actually skip the ingest package",
		);
		expect(result.pendingHuman).toBeUndefined();
	});

	it("does not flush before the debounce window elapses", () => {
		const pendingHuman: PendingHuman = { turns: [{ turn: 1, text: "x" }], lastTs: 1000 };
		const result = classifyTurns(
			{ run: run({ state: "idle" }), turns: [], seenTurn: 1, pendingHuman, firstTick: false, now: 1000 + CONFIG.humanDebounceMs - 1, userText: new Map() },
			CONFIG,
		);
		expect(result.notices).toHaveLength(0);
		expect(result.pendingHuman).toBe(pendingHuman);
	});

	it("three human turns inside the window produce exactly one note listing all three", () => {
		const userText = new Map([
			["e1", "actually skip the ingest package"],
			["e2", "no, keep the trace ids"],
			["e3", "run the typecheck"],
		]);
		let seenTurn = 0;
		let pendingHuman: PendingHuman | undefined;
		const r = run({ state: "idle" });

		let result = classifyTurns(
			{ run: r, turns: [turn({ turn: 1, origin: "human", userEntries: ["e1"], ts: 1000 })], seenTurn, pendingHuman, firstTick: false, now: 1000, userText },
			CONFIG,
		);
		seenTurn = result.seenTurn;
		pendingHuman = result.pendingHuman;
		expect(result.notices).toHaveLength(0);

		result = classifyTurns(
			{ run: r, turns: [turn({ turn: 2, origin: "human", userEntries: ["e2"], ts: 1500 })], seenTurn, pendingHuman, firstTick: false, now: 1500, userText },
			CONFIG,
		);
		seenTurn = result.seenTurn;
		pendingHuman = result.pendingHuman;
		expect(result.notices).toHaveLength(0);

		result = classifyTurns(
			{ run: r, turns: [turn({ turn: 3, origin: "human", userEntries: ["e3"], ts: 2000 })], seenTurn, pendingHuman, firstTick: false, now: 2000, userText },
			CONFIG,
		);
		seenTurn = result.seenTurn;
		pendingHuman = result.pendingHuman;
		expect(result.notices).toHaveLength(0);

		// Now the quiet period elapses with no further human turns.
		result = classifyTurns(
			{ run: r, turns: [], seenTurn, pendingHuman, firstTick: false, now: 2000 + CONFIG.humanDebounceMs, userText },
			CONFIG,
		);
		expect(result.notices).toHaveLength(1);
		const text = (result.notices[0] as Extract<Notice, { kind: "human" }>).text;
		expect(text).toContain("(3 turns)");
		expect(text).toContain("actually skip the ingest package");
		expect(text).toContain("no, keep the trace ids");
		expect(text).toContain("run the typecheck");
	});

	it("a transition to closed flushes pending human turns early, without waiting out the debounce", () => {
		const pendingHuman: PendingHuman = { turns: [{ turn: 1, text: "quick fix" }], lastTs: 1000 };
		const result = classifyTurns(
			{ run: run({ state: "closed" }), turns: [], seenTurn: 1, pendingHuman, firstTick: false, now: 1001, userText: new Map() },
			CONFIG,
		);
		expect(result.notices).toHaveLength(1);
		expect(result.notices[0].kind).toBe("human");
	});

	it("records already present on the first tick seed the watermark but never notify", () => {
		const turns = [turn({ turn: 1, origin: "parent", ts: 1000 }), turn({ turn: 2, origin: "human", userEntries: ["e1"], ts: 1500 })];
		const result = classifyTurns(
			{ run: run({ state: "idle" }), turns, seenTurn: 0, pendingHuman: undefined, firstTick: true, now: 1500, userText: new Map([["e1", "hi"]]) },
			CONFIG,
		);
		expect(result.notices).toHaveLength(0);
		expect(result.pendingHuman).toBeUndefined();
		expect(result.seenTurn).toBe(2);
	});

	it("a child that merely went idle after a human turn never produces a completion notice", () => {
		// Only 'parent'/'mixed' settles make a completion notice; a human-origin
		// settle that leaves the child idle must never be misread as "finished".
		const turns = [turn({ turn: 1, origin: "human", userEntries: ["e1"], ts: 1000 })];
		const result = classifyTurns(
			{ run: run({ state: "idle" }), turns, seenTurn: 0, pendingHuman: undefined, firstTick: false, now: 1000, userText: new Map([["e1", "hi"]]) },
			CONFIG,
		);
		expect(result.notices.some((n) => n.kind === "completion")).toBe(false);
	});
});

// ── render / selectVisibleRuns ──────────────────────────────────────────

describe("render", () => {
	it("renders a mixed set of states with an attach indicator", () => {
		const runs: Run[] = [
			run({ dir: "/a", name: "alpha", state: "running", attached: true, model: "anthropic/claude-sonnet-5" }),
			run({ dir: "/b", name: "beta", state: "blocked" }),
			run({ dir: "/c", name: "gamma", state: "beaconless" }),
			run({ dir: "/d", name: "delta", state: "closed" }),
		];
		const { lines, status } = render(runs, 10_000, CONFIG);
		expect(lines[0]).toContain("subagents");
		const alphaLine = lines.find((l) => l.includes("alpha"));
		expect(alphaLine).toBeDefined();
		expect(alphaLine).toContain("\u25c9"); // attach marker present
		expect(alphaLine).toContain("anthropic/claude-sonnet-5"); // full provider/model id, not just the trailing segment
		const betaLine = lines.find((l) => l.includes("beta"));
		expect(betaLine).toContain("needs you");
		const gammaLine = lines.find((l) => l.includes("gamma"));
		expect(gammaLine).toContain("beaconless");
		expect(status).toContain("3"); // running/blocked/beaconless are active; closed is not
		expect(lines.some((l) => l.includes("ctx~"))).toBe(false); // context-size column dropped
	});

	it("returns no lines/status for an empty run list", () => {
		expect(render([], 0, CONFIG)).toEqual({ lines: [], status: undefined });
	});
});

describe("selectVisibleRuns", () => {
	it("keeps active runs and lingers finished ones within lingerMs", () => {
		const active = run({ dir: "/a", state: "running" });
		const justClosed = run({ dir: "/b", state: "closed" });
		const longClosed = run({ dir: "/c", state: "closed" });
		const memories = new Map<string, DirMemory>([
			["/b", { seenTurn: 0, pendingHuman: undefined, lastState: "closed", finishedAt: 9_000, notifiedStuckToolId: undefined }],
			["/c", { seenTurn: 0, pendingHuman: undefined, lastState: "closed", finishedAt: 10_000 - CONFIG.lingerMs - 1, notifiedStuckToolId: undefined }],
		]);
		const visible = selectVisibleRuns([active, justClosed, longClosed], memories, 10_000, CONFIG);
		expect(visible.map((r) => r.dir).sort()).toEqual(["/a", "/b"]);
	});
});

// ── createMonitor: filesystem/tmux/clock/parent-messenger all injected ──

interface FakeFile {
	content?: string;
	mtimeMs?: number;
}

function makeFakeFs(files: Map<string, FakeFile>, dirs: string[]): FsAdapter & { touched: string[] } {
	const touched: string[] = [];
	return {
		listRunDirs: () => [...dirs],
		readFile: (p) => files.get(p)?.content,
		mtimeMs: (p) => files.get(p)?.mtimeMs,
		touch: (p) => {
			touched.push(p);
			files.set(p, { ...(files.get(p) ?? {}), content: "" });
		},
		touched,
	};
}

function makeFakeTmux(alive: Set<string>, attached: Set<string> = new Set()): TmuxAdapter {
	return {
		listSessions: async () => new Set(alive),
		isAttached: async (session) => attached.has(session),
	};
}

function makeFakeUi(): UiAdapter & { widgets: (readonly string[] | undefined)[]; statuses: (string | undefined)[]; notices: { message: string; level: string }[] } {
	const widgets: (readonly string[] | undefined)[] = [];
	const statuses: (string | undefined)[] = [];
	const notices: { message: string; level: string }[] = [];
	return {
		widgets,
		statuses,
		notices,
		setWidget: (lines) => widgets.push(lines),
		setStatus: (text) => statuses.push(text),
		notify: (message, level) => notices.push({ message, level }),
	};
}

function turnLine(rec: Partial<TurnRecord> & { turn: number }): string {
	return JSON.stringify(turn(rec));
}

describe("createMonitor", () => {
	function baseRun(dir: string, name: string, extra: Record<string, string | number> = {}) {
		return { dir, name };
	}

	it("touches parent-alive on every tick, and only for this parent's runs", async () => {
		const files = new Map<string, FakeFile>([
			[path.join("/runs/mine", "parent"), { content: "session-a" }],
			[path.join("/runs/other", "parent"), { content: "session-b" }],
			[path.join("/runs/mine", "state.json"), { content: JSON.stringify({ state: "idle", turn: 1, since: 0 }) }],
			[path.join("/runs/other", "state.json"), { content: JSON.stringify({ state: "idle", turn: 1, since: 0 }) }],
		]);
		const fs = makeFakeFs(files, ["/runs/mine", "/runs/other"]);
		const tmux = makeFakeTmux(new Set());
		const ui = makeFakeUi();
		const sent: string[] = [];
		const monitor = createMonitor({
			runsDir: "/runs",
			sessionId: () => "session-a",
			now: () => 1000,
			fs,
			tmux,
			ui,
			sendToParent: (content) => sent.push(content),
			isParentIdle: () => true,
			config: CONFIG,
		});
		await monitor.tick();
		expect(fs.touched).toEqual([path.join("/runs/mine", "parent-alive")]);
	});

	it("emits a parent-origin completion as a steer message with auto-continue after the batch window", async () => {
		const dir = "/runs/child";
		const files = new Map<string, FakeFile>([
			[path.join(dir, "parent"), { content: "session-a" }],
			[path.join(dir, "state.json"), { content: JSON.stringify({ state: "idle", turn: 1, since: 0 }) }],
			[path.join(dir, "turns.jsonl"), { content: "" }],
		]);
		const fs = makeFakeFs(files, [dir]);
		const tmux = makeFakeTmux(new Set());
		const ui = makeFakeUi();
		const sent: { content: string; opts: unknown }[] = [];
		const monitor = createMonitor({
			runsDir: "/runs",
			sessionId: () => "session-a",
			now: () => 0,
			fs,
			tmux,
			ui,
			sendToParent: (content, opts) => sent.push({ content, opts }),
			isParentIdle: () => true,
			config: CONFIG,
		});

		// First tick: nothing yet (also seeds firstTick).
		await monitor.tick();
		expect(sent).toHaveLength(0);

		// A parent-origin settle lands.
		files.set(path.join(dir, "turns.jsonl"), { content: turnLine({ turn: 1, origin: "parent", ts: 1000 }) });
		let now = 1000;
		const monitor2 = createMonitor({
			runsDir: "/runs",
			sessionId: () => "session-a",
			now: () => now,
			fs,
			tmux,
			ui,
			sendToParent: (content, opts) => sent.push({ content, opts }),
			isParentIdle: () => true,
			config: CONFIG,
		});
		await monitor2.tick(); // firstTick again for monitor2: seeds without notifying
		files.set(path.join(dir, "turns.jsonl"), {
			content: [turnLine({ turn: 1, origin: "parent", ts: 1000 }), turnLine({ turn: 2, origin: "parent", ts: 1100 })].join("\n"),
		});
		now = 1200;
		await monitor2.tick(); // new record observed, queued
		expect(sent).toHaveLength(0); // still inside the batch window

		now = 1200 + CONFIG.batchMs;
		await monitor2.tick();
		expect(sent).toHaveLength(1);
		expect(sent[0].opts).toMatchObject({ deliverAs: "steer", triggerTurn: true });
		expect(sent[0].content).toContain("[subagent]");
	});

	it("sends a human note with triggerTurn:false, never triggering a turn", async () => {
		const dir = "/runs/child";
		const files = new Map<string, FakeFile>([
			[path.join(dir, "parent"), { content: "session-a" }],
			[path.join(dir, "state.json"), { content: JSON.stringify({ state: "idle", turn: 1, since: 0 }) }],
			[path.join(dir, "turns.jsonl"), { content: "" }],
			[path.join(dir, "session.jsonl"), { content: JSON.stringify({ type: "message", id: "e1", message: { role: "user", content: "steer this" } }) }],
		]);
		const fs = makeFakeFs(files, [dir]);
		const tmux = makeFakeTmux(new Set([path.basename(dir)]));
		const ui = makeFakeUi();
		const sent: { content: string; opts: unknown }[] = [];
		let now = 0;
		const monitor = createMonitor({
			runsDir: "/runs",
			sessionId: () => "session-a",
			now: () => now,
			fs,
			tmux,
			ui,
			sendToParent: (content, opts) => sent.push({ content, opts }),
			isParentIdle: () => true,
			config: CONFIG,
		});
		await monitor.tick(); // firstTick: seed only

		files.set(path.join(dir, "turns.jsonl"), { content: turnLine({ turn: 1, origin: "human", userEntries: ["e1"], ts: 1000 }) });
		now = 1000;
		await monitor.tick();
		expect(sent).toHaveLength(0); // debounced

		now = 1000 + CONFIG.humanDebounceMs;
		await monitor.tick();
		expect(sent).toHaveLength(1);
		expect(sent[0].opts).toMatchObject({ deliverAs: "steer", triggerTurn: false });
		expect(sent[0].content).toContain("steer this");
	});
});

// ── Layout guard ─────────────────────────────────────────────────────────
//
// pi auto-discovers `extensions/*.ts` and `extensions/*/index.ts` (docs:
// extensions.md, "Discovery"). A test file sitting directly in extensions/ is
// therefore loaded as an *extension* at session start, where importing vitest
// throws "Vitest failed to access its internal state" and takes down every
// extension with it. Tests must live one level down, next to an index.ts.
describe("extensions layout", () => {
	it("has no auto-discovered test files directly in extensions/", () => {
		const extDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
		const offenders = readdirSync(extDir).filter((f) => /\.test\.ts$/.test(f));
		expect(offenders).toEqual([]);
	});
});

// ── Visibility of runs that were already finished before we started ──────
//
// pi resumes the same session id across a restart, so every child this session
// ever spawned is still "ours". A child that finished hours ago must not
// reappear in the widget just because this tick is the first one — same rule
// that keeps first-tick records from notifying.
describe("first-tick visibility", () => {
	it("does not linger a run that was already closed before the first tick", () => {
		const now = 1_000_000;
		const r = run({ dir: "/old", state: "closed" });
		const { memory } = transition(undefined, r, [], new Map(), DEFAULT_CONFIG, true, now);
		expect(memory.finishedAt).toBeUndefined();
		expect(selectVisibleRuns([r], new Map([["/old", memory]]), now, DEFAULT_CONFIG)).toEqual([]);
	});

	it("still lingers a run observed finishing live", () => {
		const now = 1_000_000;
		const active = run({ dir: "/live", state: "running" });
		const first = transition(undefined, active, [], new Map(), DEFAULT_CONFIG, false, now);
		const finished = run({ dir: "/live", state: "closed" });
		const second = transition(first.memory, finished, [], new Map(), DEFAULT_CONFIG, false, now + 10);
		expect(second.memory.finishedAt).toBe(now + 10);
		expect(
			selectVisibleRuns([finished], new Map([["/live", second.memory]]), now + 20, DEFAULT_CONFIG),
		).toHaveLength(1);
	});
});

// ── Idle children read as idle, not as their last activity ───────────────
describe("idle rendering", () => {
	it("labels an idle child idle rather than echoing its last tool call", () => {
		const { lines } = render(
			[run({ name: "solo", state: "idle", stats: { tokens: 0, contextTokens: 0, compactions: 0, cost: 0, lastActivity: "\u270e responding" } })],
			1_000,
			DEFAULT_CONFIG,
		);
		const line = lines.find((l) => l.includes("solo")) ?? "";
		expect(line).toContain("idle");
		expect(line).not.toContain("responding");
	});

	it("counts live children as live, not as running, when they are merely idle", () => {
		const { lines } = render([run({ name: "solo", state: "idle" })], 1_000, DEFAULT_CONFIG);
		expect(lines[0]).not.toMatch(/1 running/);
		expect(lines[0]).toMatch(/1 live/);
	});
});

// ── /sub verbs stay in step with the sub script ──────────────────────────
//
// The command is a thin front-end over `skills/subagents/sub`. A verb the
// script implements but the command never offers is invisible (this is how
// `clean` went missing); a verb the command offers but the script lacks is a
// broken menu entry. Both directions are checked against the script itself.
describe("/sub verbs", () => {
	const subScript = readFileSync(
		path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "subagents", "sub"),
		"utf8",
	);
	const implemented = new Set(
		[...subScript.matchAll(/^cmd_([a-z]+)\(\)/gm)].map((m) => m[1]),
	);
	// Driven by the parent agent through the CLI, deliberately not menu entries.
	const notInMenu = new Set(["spawn", "resume", "wait", "out", "peek"]);

	it("offers only verbs the script implements", () => {
		for (const { verb } of SUB_VERBS) expect(implemented).toContain(verb);
	});

	it("offers every script verb that is meant to be human-driven", () => {
		const offered = new Set(SUB_VERBS.map((v) => v.verb));
		const missing = [...implemented].filter((v) => !offered.has(v) && !notInMenu.has(v));
		expect(missing).toEqual([]);
	});
});
