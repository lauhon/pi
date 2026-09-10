/**
 * subagents-monitor — live insight into `sub` children (~/.pi/pi-sub-runs).
 *
 * - Widget above the editor: state, elapsed, turn, last tool call, context estimate, cumulative tokens, cost
 * - Footer status: running count + total spend
 * - Stall detection: running child with no session activity for >2.5min
 * - Completion notifications + short message injected for the parent LLM
 * - Auto-continue: when children finish while the parent is idle, a turn is triggered
 *   so the parent picks the work back up (disable with PI_SUB_AUTOCONTINUE=0)
 *
 * Read-only observer: the `sub` script (subagents skill) stays the source of truth.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const RUNS_DIR = process.env.PI_SUB_RUNS ?? path.join(os.homedir(), ".pi", "pi-sub-runs");
const TMUX_SOCKET = "pi-sub";
const POLL_MS = 2000;
const STALL_MS = 150_000; // running + no session.jsonl writes for this long -> stalled
const LINGER_MS = 60_000; // keep finished runs in the widget for this long
const BATCH_MS = 4000; // coalesce completions that land close together into one message
const AUTO_CONTINUE = process.env.PI_SUB_AUTOCONTINUE !== "0";

type State = "running" | "stalled" | "done" | "dead";

interface SessionStats {
	turns: number;
	tokens: number;
	contextTokens: number;
	compactions: number;
	cost: number;
	lastActivity: string;
}

interface Run {
	dir: string;
	name: string;
	model: string;
	turn: number;
	state: State;
	exitCode?: number;
	elapsedMs: number;
	stats: SessionStats;
}

interface PendingCompletion {
	name: string;
	line: string;
}

function latestTurn(dir: string): number {
	let n = 1;
	while (existsSync(path.join(dir, `task-${n + 1}.md`))) n++;
	return n;
}

function mtimeMs(file: string): number | undefined {
	try {
		return statSync(file).mtimeMs;
	} catch {
		return undefined;
	}
}

function describeToolCall(name: string, args: Record<string, unknown>): string {
	const str = (v: unknown, max: number) =>
		typeof v === "string" ? v.replace(/\s+/g, " ").slice(0, max) : "";
	if (name === "bash") return `bash ${str(args.command, 32)}`;
	if (typeof args.path === "string") return `${name} ${path.basename(args.path)}`;
	return name;
}

function parseSession(file: string): SessionStats {
	const stats: SessionStats = {
		turns: 0,
		tokens: 0,
		contextTokens: 0,
		compactions: 0,
		cost: 0,
		lastActivity: "",
	};
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return stats;
	}
	for (const line of raw.split("\n")) {
		if (!line) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue; // partial trailing line while the child is writing
		}
		if (entry.type === "compaction") {
			stats.compactions++;
			continue;
		}
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg?.role !== "assistant") continue;
		stats.turns++;
		stats.tokens += msg.usage?.totalTokens ?? 0;
		stats.contextTokens = msg.usage?.totalTokens ?? stats.contextTokens;
		stats.cost += msg.usage?.cost?.total ?? 0;
		let lastTool: string | undefined;
		for (const block of msg.content ?? []) {
			if (block.type === "toolCall") lastTool = describeToolCall(block.name, block.arguments ?? {});
		}
		stats.lastActivity = lastTool ? `\u25b6 ${lastTool}` : "\u270e responding";
	}
	return stats;
}

async function tmuxSessions(): Promise<Set<string>> {
	try {
		const { stdout } = await execFileP("tmux", [
			"-L",
			TMUX_SOCKET,
			"list-sessions",
			"-F",
			"#{session_name}",
		]);
		return new Set(stdout.split("\n").filter(Boolean));
	} catch {
		return new Set(); // no server -> nothing running
	}
}

function fmtElapsed(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

function fmtTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtCost(c: number): string {
	return `$${c.toFixed(c < 0.1 ? 3 : 2)}`;
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let ui: ExtensionContext | undefined;
	let ticking = false;
	let firstTick = true;
	let sessionId = "";

	let pending: PendingCompletion[] = [];
	let flushTimer: ReturnType<typeof setTimeout> | undefined;

	const lastState = new Map<string, State>(); // dir -> state seen last tick
	const finishedAt = new Map<string, number>(); // dir -> when we observed completion
	const stallNotified = new Set<string>();
	const sessionCache = new Map<string, { mtimeMs: number; stats: SessionStats }>();

	function readSessionStats(dir: string): { stats: SessionStats; mtime: number | undefined } {
		const file = path.join(dir, "session.jsonl");
		const mtime = mtimeMs(file);
		if (mtime === undefined) {
			return {
				stats: {
					turns: 0,
					tokens: 0,
					contextTokens: 0,
					compactions: 0,
					cost: 0,
					lastActivity: "",
				},
				mtime,
			};
		}
		const cached = sessionCache.get(dir);
		if (cached && cached.mtimeMs === mtime) return { stats: cached.stats, mtime };
		const stats = parseSession(file);
		sessionCache.set(dir, { mtimeMs: mtime, stats });
		return { stats, mtime };
	}

	function collectRun(dir: string, alive: Set<string>, now: number): Run {
		const name = path.basename(dir).replace(/^\d{8}-\d{6}-/, "");
		const turn = latestTurn(dir);
		const model = (() => {
			try {
				return readFileSync(path.join(dir, "model"), "utf8").split("/").pop() ?? "";
			} catch {
				return "";
			}
		})();
		const { stats, mtime: sessionMtime } = readSessionStats(dir);
		const turnStart = mtimeMs(path.join(dir, `task-${turn}.md`)) ?? now;
		const exitFile = path.join(dir, `exit-code-${turn}`);
		const exitMtime = mtimeMs(exitFile);

		let state: State;
		let exitCode: number | undefined;
		let elapsedMs: number;
		if (exitMtime !== undefined) {
			state = "done";
			exitCode = Number.parseInt(readFileSync(exitFile, "utf8").trim(), 10);
			if (Number.isNaN(exitCode)) exitCode = -1;
			elapsedMs = exitMtime - turnStart;
		} else if (alive.has(path.basename(dir))) {
			const lastWrite = sessionMtime ?? turnStart;
			state = now - lastWrite > STALL_MS ? "stalled" : "running";
			elapsedMs = now - turnStart;
		} else {
			state = "dead";
			elapsedMs = now - turnStart;
		}
		return { dir, name, model, turn, state, exitCode, elapsedMs, stats };
	}

	function handleTransitions(run: Run, now: number) {
		const prev = lastState.get(run.dir);
		lastState.set(run.dir, run.state);
		if (run.state === "running") {
			finishedAt.delete(run.dir); // resumed run
			stallNotified.delete(run.dir);
			return;
		}
		if (firstTick || prev === undefined) return; // pre-existing state, not observed live

		if (run.state === "stalled" && prev === "running" && !stallNotified.has(run.dir)) {
			stallNotified.add(run.dir);
			ui?.ui.notify(
				`subagent '${run.name}' looks stalled (no activity for ${fmtElapsed(STALL_MS)})`,
				"warning",
			);
			return;
		}

		const wasActive = prev === "running" || prev === "stalled";
		if ((run.state === "done" || run.state === "dead") && wasActive) {
			finishedAt.set(run.dir, now);
			const label = run.state === "done" ? `done(${run.exitCode})` : "died without exit code";
			const failed = run.state === "dead" || (run.exitCode ?? 1) !== 0;
			ui?.ui.notify(`subagent '${run.name}' ${label}`, failed ? "error" : "info");
			pending.push({
				name: run.name,
				line:
					`- '${run.name}' ${label} after ${fmtElapsed(run.elapsedMs)} ` +
					`(~${fmtTokens(run.stats.contextTokens)} ctx, ` +
					`\u03a3${fmtTokens(run.stats.tokens)} tok, ` +
					`c${run.stats.compactions}, ${fmtCost(run.stats.cost)}). ` +
					`Output: ${path.join(run.dir, `out-${run.turn}.md`)}`,
			});
			scheduleFlush();
		}
	}

	/** Coalesce completions landing within BATCH_MS into a single parent message. */
	function scheduleFlush() {
		if (flushTimer) clearTimeout(flushTimer);
		flushTimer = setTimeout(() => {
			flushTimer = undefined;
			flushPending();
		}, BATCH_MS);
		flushTimer.unref?.();
	}

	function flushPending() {
		if (!ui || pending.length === 0) return;
		const batch = pending;
		pending = [];
		const stillRunning = [...lastState.entries()]
			.filter(([, s]) => s === "running" || s === "stalled")
			.map(([dir]) => path.basename(dir).replace(/^\d{8}-\d{6}-/, ""));

		const header =
			batch.length === 1
				? `[subagent] '${batch[0].name}' finished:`
				: `[subagent] ${batch.length} subagents finished:`;
		const tail =
			stillRunning.length > 0
				? `Still running: ${stillRunning.join(", ")}.`
				: "No subagents of this session are running anymore.";
		const instruction =
			"Read each output file now, then continue the delegated work yourself: verify the " +
			"results, inspect any file changes, and carry on with the task these children were " +
			"spawned for. Do not stop just to acknowledge this notice. If nothing was pending on " +
			"them, reply with one short line.";

		const idle = ui.isIdle?.() ?? true;
		pi.sendMessage(
			{
				customType: "subagents-monitor",
				content: [header, ...batch.map((b) => b.line), tail, instruction].join("\n"),
				display: false,
			},
			{ deliverAs: "steer", triggerTurn: AUTO_CONTINUE },
		);
		if (AUTO_CONTINUE && idle) {
			ui.ui.notify(
				batch.length === 1
					? `resuming work after '${batch[0].name}'`
					: `resuming work after ${batch.length} subagents`,
				"info",
			);
		}
	}

	function render(runs: Run[], now: number) {
		if (!ui) return;
		const visible = runs.filter((r) => {
			if (r.state === "running" || r.state === "stalled") return true;
			const seen = finishedAt.get(r.dir);
			return seen !== undefined && now - seen < LINGER_MS;
		});
		if (visible.length === 0) {
			ui.ui.setWidget("subagents", undefined);
			ui.ui.setStatus("subagents", undefined);
			return;
		}
		const active = visible.filter((r) => r.state === "running" || r.state === "stalled");
		const tokens = visible.reduce((a, r) => a + r.stats.tokens, 0);
		const cost = visible.reduce((a, r) => a + r.stats.cost, 0);
		const icon: Record<State, string> = {
			running: "\u25cf",
			stalled: "\u26a0",
			done: "\u2714",
			dead: "\u2718",
		};
		const nameWidth = Math.max(...visible.map((r) => r.name.length));
		const lines = [
			`subagents \u00b7 ${active.length} running \u00b7 \u03a3 ${fmtTokens(tokens)} tok \u00b7 ${fmtCost(cost)}`,
		];
		for (const r of visible.sort((a, b) => a.name.localeCompare(b.name))) {
			const mark = r.state === "done" && (r.exitCode ?? 1) !== 0 ? icon.dead : icon[r.state];
			const detail =
				r.state === "done"
					? `done(${r.exitCode})`
					: r.state === "dead"
						? "dead"
						: r.stats.lastActivity || "starting";
			lines.push(
				`  ${mark} ${r.name.padEnd(nameWidth)}  ${fmtElapsed(r.elapsedMs).padStart(6)}  ` +
					`turn ${r.turn}  ${detail.padEnd(38)}  ` +
					`ctx~${fmtTokens(r.stats.contextTokens).padStart(7)}  ` +
					`\u03a3${fmtTokens(r.stats.tokens).padStart(7)}  c${r.stats.compactions}  ` +
					`${fmtCost(r.stats.cost)}  ${r.model}`,
			);
		}
		ui.ui.setWidget("subagents", lines);
		ui.ui.setStatus(
			"subagents",
			active.length > 0 ? `subs \u25cf${active.length} ${fmtCost(cost)}` : undefined,
		);
	}

	async function tick() {
		if (ticking || !ui) return;
		ticking = true;
		try {
			let dirs: string[] = [];
			try {
				dirs = readdirSync(RUNS_DIR)
					.map((d) => path.join(RUNS_DIR, d))
					.filter((d) => {
						try {
							if (!statSync(d).isDirectory()) return false;
							// only show runs spawned from this session (see PI_SUB_PARENT)
							return readFileSync(path.join(d, "parent"), "utf8").trim() === sessionId;
						} catch {
							return false;
						}
					});
			} catch {
				// runs dir doesn't exist
			}
			for (const key of [...sessionCache.keys()]) {
				if (!dirs.includes(key)) {
					sessionCache.delete(key);
					lastState.delete(key);
					finishedAt.delete(key);
					stallNotified.delete(key);
				}
			}
			const now = Date.now();
			const alive = dirs.length > 0 ? await tmuxSessions() : new Set<string>();
			if (!ui) return; // shut down while awaiting
			const runs = dirs.map((d) => collectRun(d, alive, now));
			for (const run of runs) handleTransitions(run, now);
			firstTick = false;
			render(runs, now);
		} catch {
			// never break the host session over monitoring
		} finally {
			ticking = false;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		// tag child runs with this session so each monitor only tracks its own
		sessionId = ctx.sessionManager.getSessionId();
		process.env.PI_SUB_PARENT = sessionId;
		if (!ctx.hasUI) return;
		ui = ctx;
		firstTick = true;
		if (!timer) {
			timer = setInterval(() => void tick(), POLL_MS);
			timer.unref?.();
		}
		void tick();
	});

	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
		timer = undefined;
		if (flushTimer) clearTimeout(flushTimer);
		flushTimer = undefined;
		pending = [];
		ui?.ui.setWidget("subagents", undefined);
		ui?.ui.setStatus("subagents", undefined);
		ui = undefined;
	});
}
