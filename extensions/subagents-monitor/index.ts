/**
 * subagents-monitor — read-only observer of interactive `sub` children
 * (`~/.pi/pi-sub-runs`) plus the `/sub` command.
 *
 * Children are long-lived interactive pi TUIs in a detached tmux session
 * (`-L pi-sub`), driven by `skills/subagents/beacon`. This extension never
 * mutates a child directly — every mutation (`open`, `stop`, `kill`, ...)
 * shells out to `skills/subagents/sub`, which is the one source of truth for
 * lifecycle transitions. See skills/subagents/spec-interactive-children.md.
 *
 * ── States ──────────────────────────────────────────────────────────────
 * Derived from `state.json` + tmux liveness + spawn age, the same way
 * `sub`'s `derive_state` does (see collectRun/deriveState below), so the two
 * never disagree: starting, idle, running, blocked, beaconless, closed, dead.
 * `#{session_attached}` is shown as a widget indicator only, never used in
 * notification logic (spec, "Notification rules").
 *
 * ── Notifications ───────────────────────────────────────────────────────
 * Keyed on the `origin` of the settle recorded in `turns.jsonl`:
 *   - parent/mixed -> completion notice (`deliverAs: "steer"`, auto-continue).
 *   - human        -> silent, accumulated, then one debounced note (10s of no
 *                     further human turns, or an early flush on a transition
 *                     to closed/dead) with the verbatim (truncated) text.
 *   - unknown      -> silent.
 * Records already on disk on the extension's first tick seed bookkeeping but
 * never notify (nothing to "just happen" retroactively).
 *
 * ── Stall hint ──────────────────────────────────────────────────────────
 * A `running` child with no open tool call is waiting on the provider — this
 * is normal (large-context calls routinely take 1-3 minutes) and never
 * notifies, only labels the widget ("waiting on provider, Nm"). A `running`
 * child with a tool call that has been open (no matching `toolResult` entry)
 * for >= TOOL_STALL_MS is worth a look (e.g. an unbounded `find /`); that
 * notifies once per stuck tool-call id, naming the tool.
 *
 * Thresholds (all injectable via MonitorConfig for tests):
 *   BEACONLESS_MS   20_000   tmux alive, no state.json this long -> beaconless (matches `sub`)
 *   TOOL_STALL_MS  180_000   an open tool call this old is surfaced
 *   HUMAN_DEBOUNCE  10_000   spec: quiet period before flushing a human note
 *   LINGER_MS       60_000   keep closed/dead runs in the widget this long
 *   BATCH_MS         4_000   coalesce parent-origin completions landing close together
 *
 * ── Testing seams ───────────────────────────────────────────────────────
 * The observer core is pure: collectRun / classifyTurns / transition / render
 * take already-read data and an explicit `now`, no filesystem or tmux calls.
 * `createMonitor(deps)` wires the pure core to injected filesystem, tmux,
 * clock and parent-messenger seams — the default export below is the only
 * place that touches real `node:fs` / `tmux` / `pi`.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { normalizeContent, type TurnOrigin } from "../../skills/subagents/beacon/reducer.ts";

const execFileP = promisify(execFile);

// ── Types: states, records, config ──────────────────────────────────────

export type ChildState = "starting" | "idle" | "running" | "blocked" | "beaconless" | "closed" | "dead";

export interface TurnRecord {
	readonly turn: number;
	readonly origin: TurnOrigin;
	readonly userEntries: readonly string[];
	readonly inbox: readonly number[];
	readonly out: string;
	readonly ts: number;
}

export interface MonitorConfig {
	/** tmux alive, no state.json this long -> beaconless (mirrors `sub`'s PI_SUB_BEACONLESS_SECS). */
	readonly beaconlessMs: number;
	/** An open tool call (toolCall with no matching toolResult) this old is surfaced. */
	readonly toolStallMs: number;
	/** Quiet period after the last human turn before the debounced note fires. */
	readonly humanDebounceMs: number;
	/** Keep closed/dead runs visible in the widget this long after the transition. */
	readonly lingerMs: number;
	/** Coalesce parent-origin completions landing within this window into one message. */
	readonly batchMs: number;
	readonly autoContinue: boolean;
}

export const DEFAULT_CONFIG: MonitorConfig = {
	beaconlessMs: 20_000,
	toolStallMs: 180_000,
	humanDebounceMs: 10_000,
	lingerMs: 60_000,
	batchMs: 4_000,
	autoContinue: true,
};

export interface StallHint {
	readonly kind: "provider-wait" | "stuck-tool";
	readonly elapsedMs: number;
	readonly tool?: string;
}

export interface SessionStats {
	readonly tokens: number;
	readonly contextTokens: number;
	readonly compactions: number;
	readonly cost: number;
	readonly lastActivity: string;
}

export interface ParsedSession {
	readonly stats: SessionStats;
	/** user entry id -> normalized text, for resolving human-origin turn text. */
	readonly userText: ReadonlyMap<string, string>;
	/** The most recently opened tool call with no matching toolResult yet, if any. */
	readonly pendingTool: { readonly id: string; readonly name: string } | undefined;
}

/** Already-read, per-run input to `collectRun`. All I/O happens before this. */
export interface RunSnapshot {
	readonly dir: string;
	readonly name: string;
	readonly alive: boolean;
	readonly attached: boolean;
	readonly model: string;
	readonly stateJson: { readonly state?: string; readonly turn?: number; readonly since?: number } | undefined;
	readonly spawnedAtSecs: number | undefined;
	readonly sessionMtimeMs: number | undefined;
	readonly parsedSession: ParsedSession;
}

export interface Run {
	readonly dir: string;
	readonly name: string;
	readonly model: string;
	readonly state: ChildState;
	readonly turn: number;
	/** When the current phase (state.json) was last written, ms epoch. */
	readonly since: number;
	readonly spawnedAtMs: number | undefined;
	/** now - (spawnedAtMs ?? since): overall run age. */
	readonly elapsedMs: number;
	readonly attached: boolean;
	readonly stats: SessionStats;
	readonly sessionMtimeMs: number | undefined;
	readonly pendingTool: { readonly id: string; readonly name: string } | undefined;
	readonly stallHint: StallHint | undefined;
}

export interface PendingHuman {
	readonly turns: readonly { readonly turn: number; readonly text: string }[];
	/** ts (ms) of the most recently accumulated human turn. */
	readonly lastTs: number;
}

export interface CompletionNotice {
	readonly kind: "completion";
	readonly runName: string;
	readonly turn: number;
	readonly line: string;
}
export interface HumanNotice {
	readonly kind: "human";
	readonly runName: string;
	readonly text: string;
}
export interface StallNotice {
	readonly kind: "stall";
	readonly runName: string;
	readonly message: string;
}
export type Notice = CompletionNotice | HumanNotice | StallNotice;

export interface DirMemory {
	readonly seenTurn: number;
	readonly pendingHuman: PendingHuman | undefined;
	readonly lastState: ChildState | undefined;
	/** When this run was last observed to transition into a non-active state. */
	readonly finishedAt: number | undefined;
	/** Tool-call id of the last stuck-tool notice fired, so we notify once per call. */
	readonly notifiedStuckToolId: string | undefined;
}

// ── Formatters (pure) ─────────────────────────────────────────────────────

export function fmtElapsed(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export function fmtTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

export function fmtCost(c: number): string {
	return `$${c.toFixed(c < 0.1 ? 3 : 2)}`;
}

function describeToolCall(name: string, args: Record<string, unknown>): string {
	const str = (v: unknown, max: number) =>
		typeof v === "string" ? v.replace(/\s+/g, " ").slice(0, max) : "";
	if (name === "bash") return `bash ${str(args.command, 32)}`;
	if (typeof args.path === "string") return `${name} ${path.basename(args.path as string)}`;
	return name;
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 1)}\u2026` : s;
}

export function isActive(state: ChildState): boolean {
	return state !== "closed" && state !== "dead";
}

// ── Parsing (pure over already-read strings) ─────────────────────────────

export function parseStateJson(
	raw: string | undefined,
): { state?: string; turn?: number; since?: number } | undefined {
	if (raw === undefined) return undefined;
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		return parsed as { state?: string; turn?: number; since?: number };
	} catch {
		return undefined; // E27: a poller can catch state.json mid-write; treat like absent
	}
}

export function parseTurns(raw: string | undefined): TurnRecord[] {
	if (!raw) return [];
	const out: TurnRecord[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let rec: unknown;
		try {
			rec = JSON.parse(line);
		} catch {
			continue; // a partial trailing line while the beacon is writing
		}
		if (typeof rec === "object" && rec !== null && typeof (rec as TurnRecord).turn === "number") {
			out.push(rec as TurnRecord);
		}
	}
	return out;
}

export function parseSession(raw: string | undefined): ParsedSession {
	const userText = new Map<string, string>();
	let tokens = 0;
	let contextTokens = 0;
	let compactions = 0;
	let cost = 0;
	let lastActivity = "";
	const openToolCalls = new Map<string, string>(); // toolCallId -> description, insertion order

	if (raw) {
		for (const line of raw.split("\n")) {
			if (!line) continue;
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue; // partial trailing line while the child is writing
			}
			if (entry?.type === "compaction") {
				compactions++;
				continue;
			}
			if (entry?.type !== "message") continue;
			const msg = entry.message;
			if (!msg || typeof msg !== "object") continue;

			if (msg.role === "user" && typeof entry.id === "string") {
				userText.set(entry.id, normalizeContent(msg.content ?? ""));
				continue;
			}
			if (msg.role === "toolResult" && typeof msg.toolCallId === "string") {
				openToolCalls.delete(msg.toolCallId);
				continue;
			}
			if (msg.role !== "assistant") continue;

			tokens += msg.usage?.totalTokens ?? 0;
			contextTokens = msg.usage?.totalTokens ?? contextTokens;
			cost += msg.usage?.cost?.total ?? 0;

			const content = Array.isArray(msg.content) ? msg.content : [];
			let sawTool = false;
			for (const block of content) {
				if (block?.type === "toolCall" && typeof block.id === "string") {
					openToolCalls.set(block.id, describeToolCall(block.name, block.arguments ?? {}));
					sawTool = true;
				}
			}
			if (sawTool) {
				const last = [...openToolCalls.values()].pop();
				if (last) lastActivity = `\u25b6 ${last}`;
			} else if (content.some((b: any) => b?.type === "text" && typeof b.text === "string" && b.text)) {
				lastActivity = "\u270e responding";
			}
		}
	}

	const lastPending = [...openToolCalls.entries()].pop();
	return {
		stats: { tokens, contextTokens, compactions, cost, lastActivity },
		userText,
		pendingTool: lastPending ? { id: lastPending[0], name: lastPending[1] } : undefined,
	};
}

// ── State derivation (mirrors `sub`'s derive_state, so they never disagree) ──

export function deriveState(input: RunSnapshot, now: number, beaconlessMs: number): ChildState {
	const recorded = input.stateJson?.state;
	if (input.alive) {
		if (recorded === "running" || recorded === "blocked" || recorded === "idle" || recorded === "closed") {
			return recorded;
		}
		// recorded is undefined/unknown/"starting": disambiguate by spawn age, same as `sub`.
		const spawnedMs = input.spawnedAtSecs !== undefined ? input.spawnedAtSecs * 1000 : 0;
		const age = now - spawnedMs;
		return age >= beaconlessMs ? "beaconless" : "starting";
	}
	return recorded === "closed" ? "closed" : "dead";
}

function computeStallHint(run: Run, now: number, config: MonitorConfig): StallHint | undefined {
	if (run.state !== "running") return undefined;
	if (run.pendingTool) {
		const startedAt = run.sessionMtimeMs ?? run.since;
		const elapsedMs = Math.max(0, now - startedAt);
		return elapsedMs >= config.toolStallMs
			? { kind: "stuck-tool", elapsedMs, tool: run.pendingTool.name }
			: undefined;
	}
	// No open tool call: either the turn hasn't produced anything yet, or the last
	// tool call already returned and we're waiting on the next model response.
	// Both are the provider-wait case (spec: this is routine, never notify).
	const waitStart = Math.max(run.since, run.sessionMtimeMs ?? run.since);
	return { kind: "provider-wait", elapsedMs: Math.max(0, now - waitStart) };
}

export function collectRun(input: RunSnapshot, now: number, config: MonitorConfig): Run {
	const state = deriveState(input, now, config.beaconlessMs);
	const spawnedAtMs = input.spawnedAtSecs !== undefined ? input.spawnedAtSecs * 1000 : undefined;
	const since = input.stateJson?.since ?? spawnedAtMs ?? now;
	const turn = input.stateJson?.turn ?? 0;
	const elapsedMs = Math.max(0, now - (spawnedAtMs ?? since));

	const base: Run = {
		dir: input.dir,
		name: input.name,
		model: input.model,
		state,
		turn,
		since,
		spawnedAtMs,
		elapsedMs,
		attached: input.attached,
		stats: input.parsedSession.stats,
		sessionMtimeMs: input.sessionMtimeMs,
		pendingTool: input.parsedSession.pendingTool,
		stallHint: undefined,
	};
	return { ...base, stallHint: computeStallHint(base, now, config) };
}

// ── Notification classification ─────────────────────────────────────────

function resolveTurnText(rec: TurnRecord, userText: ReadonlyMap<string, string>): string {
	const parts = rec.userEntries.map((id) => userText.get(id)).filter((t): t is string => typeof t === "string");
	return truncate(parts.join(" / ") || "(no text)", 200);
}

function makeCompletionNotice(run: Run, turns: readonly TurnRecord[], rec: TurnRecord): CompletionNotice {
	const idx = turns.findIndex((t) => t.turn === rec.turn);
	const prevTs = idx > 0 ? turns[idx - 1].ts : run.spawnedAtMs;
	const elapsedMs = Math.max(0, rec.ts - (prevTs ?? rec.ts));
	const line =
		`- '${run.name}' turn ${rec.turn} settled after ${fmtElapsed(elapsedMs)} ` +
		`(~${fmtTokens(run.stats.contextTokens)} ctx, \u03a3${fmtTokens(run.stats.tokens)} tok, ` +
		`c${run.stats.compactions}, ${fmtCost(run.stats.cost)}). Output: ${path.join(run.dir, `out-${rec.turn}.md`)}`;
	return { kind: "completion", runName: run.name, turn: rec.turn, line };
}

function makeHumanNotice(run: Run, pendingHuman: PendingHuman): HumanNotice {
	const n = pendingHuman.turns.length;
	const lines = pendingHuman.turns.map((t, i) => `  ${i + 1}. "${t.text}"`);
	const latestTurn = pendingHuman.turns[pendingHuman.turns.length - 1]?.turn ?? run.turn;
	const text = [
		`[subagent] you steered '${run.name}' directly (${n} turn${n === 1 ? "" : "s"}):`,
		...lines,
		`Child is ${run.state}. out: ${path.join(run.dir, `out-${latestTurn}.md`)} \u00b7 ` +
			`session: ${path.join(run.dir, "session.jsonl")}`,
	].join("\n");
	return { kind: "human", runName: run.name, text };
}

export interface ClassifyInput {
	readonly run: Run;
	readonly turns: readonly TurnRecord[];
	readonly seenTurn: number;
	readonly pendingHuman: PendingHuman | undefined;
	readonly firstTick: boolean;
	readonly now: number;
	readonly userText: ReadonlyMap<string, string>;
}

export interface ClassifyResult {
	readonly notices: readonly Notice[];
	readonly seenTurn: number;
	readonly pendingHuman: PendingHuman | undefined;
}

/**
 * Turns new `turns.jsonl` records into notices. `parent`/`mixed` settle ->
 * immediate completion notice per turn. `human` -> accumulated and flushed as
 * one note after a quiet period, or immediately if the child just went
 * inactive (closed/dead) so nothing is swallowed. `unknown` -> silent.
 * Records present before `firstTick` seed `seenTurn` without notifying.
 */
export function classifyTurns(input: ClassifyInput, config: MonitorConfig): ClassifyResult {
	const { run, turns, firstTick, now, userText } = input;
	let seenTurn = input.seenTurn;
	let pendingHuman = input.pendingHuman;
	const notices: Notice[] = [];

	const fresh = turns.filter((t) => t.turn > seenTurn).sort((a, b) => a.turn - b.turn);
	for (const rec of fresh) {
		seenTurn = Math.max(seenTurn, rec.turn);
		if (firstTick) continue;
		if (rec.origin === "parent" || rec.origin === "mixed") {
			notices.push(makeCompletionNotice(run, turns, rec));
		} else if (rec.origin === "human") {
			const text = resolveTurnText(rec, userText);
			pendingHuman = {
				turns: [...(pendingHuman?.turns ?? []), { turn: rec.turn, text }],
				lastTs: rec.ts,
			};
		}
		// "unknown" -> silent (spec: nobody typed it, don't misattribute to the human)
	}

	const quietLongEnough = pendingHuman !== undefined && now - pendingHuman.lastTs >= config.humanDebounceMs;
	const shouldFlush = pendingHuman !== undefined && (quietLongEnough || !isActive(run.state));
	if (shouldFlush && pendingHuman !== undefined) {
		notices.push(makeHumanNotice(run, pendingHuman));
		pendingHuman = undefined;
	}

	return { notices, seenTurn, pendingHuman };
}

/** Per-tick bookkeeping for one run dir: turn watermark, human debounce, linger, stall dedup. */
export function transition(
	prev: DirMemory | undefined,
	run: Run,
	turns: readonly TurnRecord[],
	userText: ReadonlyMap<string, string>,
	config: MonitorConfig,
	firstTick: boolean,
	now: number,
): { readonly memory: DirMemory; readonly notices: readonly Notice[] } {
	const notices: Notice[] = [];

	const classified = classifyTurns(
		{ run, turns, seenTurn: prev?.seenTurn ?? 0, pendingHuman: prev?.pendingHuman, firstTick, now, userText },
		config,
	);
	notices.push(...classified.notices);

	let finishedAt = prev?.finishedAt;
	if (!isActive(run.state)) {
		// A run already finished on the first tick was finished before this session
		// started looking (pi keeps the same session id across a restart, so old
		// children stay "ours" forever). Linger is for finishes we actually watched.
		if (firstTick && prev === undefined) {
			finishedAt = undefined;
		} else if (finishedAt === undefined || (prev?.lastState !== undefined && isActive(prev.lastState))) {
			finishedAt = now;
		}
	} else {
		finishedAt = undefined;
	}

	let notifiedStuckToolId = prev?.notifiedStuckToolId;
	if (run.stallHint?.kind === "stuck-tool") {
		if (notifiedStuckToolId !== run.pendingTool?.id) {
			notices.push({
				kind: "stall",
				runName: run.name,
				message:
					`subagent '${run.name}' has a tool call stuck for ${fmtElapsed(run.stallHint.elapsedMs)}: ` +
					`${run.stallHint.tool}`,
			});
			notifiedStuckToolId = run.pendingTool?.id;
		}
	} else {
		notifiedStuckToolId = undefined;
	}

	return {
		memory: {
			seenTurn: classified.seenTurn,
			pendingHuman: classified.pendingHuman,
			lastState: run.state,
			finishedAt,
			notifiedStuckToolId,
		},
		notices,
	};
}

// ── Rendering (pure) ──────────────────────────────────────────────────────

const STATE_ICON: Record<ChildState, string> = {
	starting: "\u22ef",
	idle: "\u25c7",
	running: "\u25cf",
	blocked: "\u2691",
	beaconless: "\u26a0",
	closed: "\u2714",
	dead: "\u2718",
};

export function selectVisibleRuns(
	runs: readonly Run[],
	memories: ReadonlyMap<string, DirMemory>,
	now: number,
	config: MonitorConfig,
): Run[] {
	return runs.filter((r) => {
		if (isActive(r.state)) return true;
		const finishedAt = memories.get(r.dir)?.finishedAt;
		return finishedAt !== undefined && now - finishedAt < config.lingerMs;
	});
}

function describeDetail(r: Run): string {
	if (r.state === "blocked") return "\u2691 needs you";
	if (r.state === "beaconless") return "\u26a0 beaconless (no state.json)";
	if (r.state === "closed") return "closed";
	if (r.state === "dead") return "dead";
	if (r.state === "starting") return "starting\u2026";
	// An idle child is waiting for a turn; echoing the last tool call of the turn
	// it already finished reads as if it were still working.
	if (r.state === "idle") return "idle";
	if (r.stallHint?.kind === "stuck-tool") {
		return `\u26a0 stuck: ${r.stallHint.tool} (${fmtElapsed(r.stallHint.elapsedMs)})`;
	}
	if (r.stallHint?.kind === "provider-wait") {
		return `waiting on provider, ${fmtElapsed(r.stallHint.elapsedMs)}`;
	}
	return r.stats.lastActivity || r.state;
}

export function render(
	runs: readonly Run[],
	_now: number,
	_config: MonitorConfig,
): { lines: readonly string[]; status: string | undefined } {
	if (runs.length === 0) return { lines: [], status: undefined };
	const active = runs.filter((r) => isActive(r.state));
	const tokens = runs.reduce((a, r) => a + r.stats.tokens, 0);
	const cost = runs.reduce((a, r) => a + r.stats.cost, 0);
	const nameWidth = Math.max(...runs.map((r) => r.name.length));

	const lines = [
		`subagents \u00b7 ${active.length} live \u00b7 \u03a3 ${fmtTokens(tokens)} tok \u00b7 ${fmtCost(cost)}`,
	];
	for (const r of [...runs].sort((a, b) => a.name.localeCompare(b.name))) {
		const attachMark = r.attached ? "\u25c9" : " ";
		const detail = describeDetail(r);
		lines.push(
			`  ${attachMark}${STATE_ICON[r.state]} ${r.name.padEnd(nameWidth)}  ${fmtElapsed(r.elapsedMs).padStart(6)}  ` +
				`turn ${r.turn}  ${detail.padEnd(38)}  ` +
				`\u03a3${fmtTokens(r.stats.tokens).padStart(7)}  c${r.stats.compactions}  ` +
				`${fmtCost(r.stats.cost)}  ${r.model}`,
		);
	}
	const status = active.length > 0 ? `subs \u25cf${active.length} ${fmtCost(cost)}` : undefined;
	return { lines, status };
}

// ── createMonitor: pure core wired to injected deps ──────────────────────

export interface FsAdapter {
	/** Absolute paths of every run directory under the runs dir (existence-checked). */
	listRunDirs(): string[];
	readFile(path: string): string | undefined;
	mtimeMs(path: string): number | undefined;
	/** Touch (create if missing) the parent-alive lease file. */
	touch(path: string): void;
}

export interface TmuxAdapter {
	listSessions(): Promise<Set<string>>;
	isAttached(session: string): Promise<boolean>;
}

export interface UiAdapter {
	setWidget(lines: readonly string[] | undefined): void;
	setStatus(text: string | undefined): void;
	notify(message: string, level: "info" | "warning" | "error"): void;
}

export interface MonitorDeps {
	readonly runsDir: string;
	readonly sessionId: () => string;
	readonly now: () => number;
	readonly fs: FsAdapter;
	readonly tmux: TmuxAdapter;
	readonly ui: UiAdapter;
	readonly sendToParent: (content: string, opts: { deliverAs: "steer"; triggerTurn: boolean }) => void;
	readonly isParentIdle: () => boolean;
	readonly config: MonitorConfig;
}

export function displayName(dir: string): string {
	const base = path.basename(dir);
	const m = /^\d{8}-\d{6}-(.+)$/.exec(base);
	return m ? m[1] : base;
}

function readSnapshot(fs: FsAdapter, dir: string, name: string, alive: boolean, attached: boolean): RunSnapshot {
	// The widget shows the full "provider/model" id (not just the trailing model
	// segment) so children on the same model but different providers stay distinguishable.
	const model = (fs.readFile(path.join(dir, "meta.model")) ?? "").trim();
	const stateJson = parseStateJson(fs.readFile(path.join(dir, "state.json")));
	const spawnedRaw = fs.readFile(path.join(dir, "spawned"));
	const spawnedNum = spawnedRaw !== undefined ? Number.parseInt(spawnedRaw.trim(), 10) : Number.NaN;
	const sessionPath = path.join(dir, "session.jsonl");
	const parsedSession = parseSession(fs.readFile(sessionPath));
	return {
		dir,
		name,
		alive,
		attached,
		model,
		stateJson,
		spawnedAtSecs: Number.isFinite(spawnedNum) ? spawnedNum : undefined,
		sessionMtimeMs: fs.mtimeMs(sessionPath),
		parsedSession,
	};
}

export interface Monitor {
	tick(): Promise<void>;
}

export function createMonitor(deps: MonitorDeps): Monitor {
	const memories = new Map<string, DirMemory>();
	let firstTick = true;
	let pendingCompletions: { items: CompletionNotice[]; firstAt: number } | undefined;

	function flushCompletions(currentRuns: readonly Run[]): void {
		if (!pendingCompletions) return;
		const batch = pendingCompletions.items;
		pendingCompletions = undefined;

		const stillRunning = currentRuns.filter((r) => isActive(r.state)).map((r) => r.name);
		const header =
			batch.length === 1
				? `[subagent] '${batch[0].runName}' finished a turn:`
				: `[subagent] ${batch.length} subagent turns finished:`;
		const tail =
			stillRunning.length > 0
				? `Still running: ${stillRunning.join(", ")}.`
				: "No subagents of this session are running anymore.";
		const instruction =
			"Read each output file now, then continue the delegated work yourself: verify the " +
			"results, inspect any file changes, and carry on with the task these children were " +
			"spawned for. Do not stop just to acknowledge this notice. If nothing was pending on " +
			"them, reply with one short line.";

		const wasIdle = deps.isParentIdle();
		deps.sendToParent([header, ...batch.map((b) => b.line), tail, instruction].join("\n"), {
			deliverAs: "steer",
			triggerTurn: deps.config.autoContinue,
		});
		if (deps.config.autoContinue && wasIdle) {
			deps.ui.notify(
				batch.length === 1
					? `resuming work after '${batch[0].runName}'`
					: `resuming work after ${batch.length} subagent turns`,
				"info",
			);
		}
	}

	async function tick(): Promise<void> {
		const now = deps.now();
		let dirs: string[];
		try {
			dirs = deps.fs.listRunDirs();
		} catch {
			dirs = [];
		}

		const sid = deps.sessionId();
		const owned = dirs.filter((d) => (deps.fs.readFile(path.join(d, "parent")) ?? "").trim() === sid);

		for (const key of [...memories.keys()]) {
			if (!owned.includes(key)) memories.delete(key);
		}

		const aliveSet = owned.length > 0 ? await deps.tmux.listSessions() : new Set<string>();
		const runs: Run[] = [];

		for (const dir of owned) {
			deps.fs.touch(path.join(dir, "parent-alive")); // lease, not a pid (spec)

			const sessionName = path.basename(dir);
			const alive = aliveSet.has(sessionName);
			const attached = alive ? await deps.tmux.isAttached(sessionName) : false;
			const snapshot = readSnapshot(deps.fs, dir, displayName(dir), alive, attached);
			const run = collectRun(snapshot, now, deps.config);
			runs.push(run);

			const turns = parseTurns(deps.fs.readFile(path.join(dir, "turns.jsonl")));
			const prevMem = memories.get(dir);
			const { memory, notices } = transition(
				prevMem,
				run,
				turns,
				snapshot.parsedSession.userText,
				deps.config,
				firstTick,
				now,
			);
			memories.set(dir, memory);

			for (const notice of notices) {
				if (notice.kind === "completion") {
					if (!pendingCompletions) pendingCompletions = { items: [], firstAt: now };
					pendingCompletions.items.push(notice);
				} else if (notice.kind === "human") {
					deps.sendToParent(notice.text, { deliverAs: "steer", triggerTurn: false });
				} else {
					deps.ui.notify(notice.message, "warning");
				}
			}
		}

		if (pendingCompletions && now - pendingCompletions.firstAt >= deps.config.batchMs) {
			flushCompletions(runs);
		}

		firstTick = false;
		const visible = selectVisibleRuns(runs, memories, now, deps.config);
		const { lines, status } = render(visible, now, deps.config);
		deps.ui.setWidget(lines.length > 0 ? lines : undefined);
		deps.ui.setStatus(status);
	}

	return { tick };
}

// ── /sub command ──────────────────────────────────────────────────────────

function listOwnedChildren(runsDir: string, sessionId: string): string[] {
	let dirs: string[];
	try {
		dirs = readdirSync(runsDir).map((d) => path.join(runsDir, d));
	} catch {
		return [];
	}
	const names: string[] = [];
	for (const dir of dirs) {
		try {
			if (!statSync(dir).isDirectory()) continue;
			if (readFileSync(path.join(dir, "parent"), "utf8").trim() !== sessionId) continue;
			names.push(displayName(dir));
		} catch {
			continue;
		}
	}
	return names;
}

async function runSub(subBin: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
	try {
		const { stdout, stderr } = await execFileP(subBin, args, { env: process.env });
		return { stdout, stderr };
	} catch (error: any) {
		return { stdout: error?.stdout ?? "", stderr: error?.stderr ?? String(error?.message ?? error) };
	}
}

/**
 * Verbs `/sub` offers. Each must exist as `cmd_<verb>` in skills/subagents/sub
 * (asserted by a test) — the command is a thin front-end, never its own
 * implementation. `takesName` drives child-name autocompletion.
 */
export const SUB_VERBS: readonly { readonly verb: string; readonly takesName: boolean }[] = [
	{ verb: "open", takesName: true },
	{ verb: "list", takesName: false },
	{ verb: "stop", takesName: true },
	{ verb: "kill", takesName: true },
	{ verb: "orphans", takesName: false },
	{ verb: "clean", takesName: false },
];

function registerSubCommand(
	pi: ExtensionAPI,
	opts: { readonly subBin: string; readonly runsDir: string; readonly sessionIdRef: () => string },
): void {
	pi.registerCommand("sub", {
		description: "Manage subagent children: open [name], list, stop <name>, kill <name>, orphans, clean",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const trimmed = prefix.trimStart();
			const spaceIdx = trimmed.indexOf(" ");
			if (spaceIdx === -1) {
				const items = SUB_VERBS.filter((v) => v.verb.startsWith(trimmed)).map((v) => ({
					value: v.verb,
					label: v.verb,
				}));
				return items.length > 0 ? items : null;
			}
			const verb = trimmed.slice(0, spaceIdx);
			if (!SUB_VERBS.some((v) => v.verb === verb && v.takesName)) return null;
			const namePrefix = trimmed.slice(spaceIdx + 1);
			const names = listOwnedChildren(opts.runsDir, opts.sessionIdRef());
			const items = names
				.filter((n) => n.startsWith(namePrefix))
				.map((n) => ({ value: `${verb} ${n}`, label: n }));
			return items.length > 0 ? items : null;
		},
		handler: async (args: string, ctx: any) => {
			const [verb, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const name = rest.join(" ");
			switch (verb) {
				case "list": {
					const { stdout, stderr } = await runSub(opts.subBin, ["list"]);
					ctx.ui.notify(stdout.trim() || stderr.trim() || "(no children)", "info");
					return;
				}
				case "orphans": {
					const { stdout, stderr } = await runSub(opts.subBin, ["orphans"]);
					ctx.ui.notify(stdout.trim() || stderr.trim() || "(no orphans)", "info");
					return;
				}
				case "clean": {
					// `sub clean` only sweeps runs owned by this parent session.
					const { stdout, stderr } = await runSub(opts.subBin, ["clean", ...rest]);
					ctx.ui.notify(stdout.trim() || stderr.trim() || "(nothing to clean)", "info");
					return;
				}
				case "open": {
					let target = name;
					if (!target) {
						const names = listOwnedChildren(opts.runsDir, opts.sessionIdRef());
						if (names.length === 0) {
							ctx.ui.notify("no children in this session", "warning");
							return;
						}
						const picked = await ctx.ui.select("Open which child?", names);
						if (!picked) return;
						target = picked;
					}
					const { stdout, stderr } = await runSub(opts.subBin, ["open", target]);
					ctx.ui.notify(stdout.trim() || stderr.trim(), stderr && !stdout ? "error" : "info");
					return;
				}
				case "stop":
				case "kill": {
					if (!name) {
						ctx.ui.notify(`usage: /sub ${verb} <name>`, "warning");
						return;
					}
					const { stdout, stderr } = await runSub(opts.subBin, [verb, name]);
					ctx.ui.notify(stdout.trim() || stderr.trim(), stderr && !stdout ? "error" : "info");
					return;
				}
				default:
					ctx.ui.notify(
						"usage: /sub open [name] | list | stop <name> | kill <name> | orphans | clean [--all]",
						"warning",
					);
			}
		},
	});
}

// ── Real wiring ────────────────────────────────────────────────────────────

const RUNS_DIR = process.env.PI_SUB_RUNS ?? path.join(os.homedir(), ".pi", "pi-sub-runs");
const TMUX_SOCKET = process.env.PI_SUB_SOCKET ?? "pi-sub";
const POLL_MS = 2000;

export default function (pi: ExtensionAPI) {
	const subBin =
		process.env.PI_SUB_BIN ??
		path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "subagents", "sub");
	const config: MonitorConfig = { ...DEFAULT_CONFIG, autoContinue: process.env.PI_SUB_AUTOCONTINUE !== "0" };

	let ui: ExtensionContext | undefined;
	let sessionId = "";
	let timer: ReturnType<typeof setInterval> | undefined;
	let ticking = false;

	const fs: FsAdapter = {
		listRunDirs() {
			return readdirSync(RUNS_DIR)
				.map((d) => path.join(RUNS_DIR, d))
				.filter((d) => {
					try {
						return statSync(d).isDirectory();
					} catch {
						return false;
					}
				});
		},
		readFile(p) {
			try {
				return readFileSync(p, "utf8");
			} catch {
				return undefined;
			}
		},
		mtimeMs(p) {
			try {
				return statSync(p).mtimeMs;
			} catch {
				return undefined;
			}
		},
		touch(p) {
			const now = new Date();
			try {
				utimesSync(p, now, now);
			} catch {
				try {
					writeFileSync(p, "");
				} catch {
					// run dir may be gone (E14): the lease just goes stale, `sub orphans` reports it
				}
			}
		},
	};

	const tmux: TmuxAdapter = {
		async listSessions() {
			try {
				const { stdout } = await execFileP("tmux", ["-L", TMUX_SOCKET, "list-sessions", "-F", "#{session_name}"]);
				return new Set(stdout.split("\n").filter(Boolean));
			} catch {
				return new Set(); // no server -> nothing alive
			}
		},
		async isAttached(session) {
			try {
				const { stdout } = await execFileP("tmux", [
					"-L",
					TMUX_SOCKET,
					"display-message",
					"-p",
					"-t",
					session,
					"#{session_attached}",
				]);
				return Number.parseInt(stdout.trim(), 10) > 0;
			} catch {
				return false;
			}
		},
	};

	function buildMonitor(): Monitor {
		return createMonitor({
			runsDir: RUNS_DIR,
			sessionId: () => sessionId,
			now: () => Date.now(),
			fs,
			tmux,
			config,
			ui: {
				setWidget: (lines) => ui?.ui.setWidget("subagents", lines ? [...lines] : undefined),
				setStatus: (text) => ui?.ui.setStatus("subagents", text),
				notify: (message, level) => ui?.ui.notify(message, level),
			},
			sendToParent: (content, opts) => {
				pi.sendMessage({ customType: "subagents-monitor", content, display: false }, opts);
			},
			isParentIdle: () => ui?.isIdle?.() ?? true,
		});
	}

	let monitor: Monitor | undefined;

	async function tick() {
		if (ticking || !ui || !monitor) return;
		ticking = true;
		try {
			await monitor.tick();
		} catch {
			// never break the host session over monitoring
		} finally {
			ticking = false;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		sessionId = ctx.sessionManager.getSessionId();
		process.env.PI_SUB_PARENT = sessionId;
		if (!ctx.hasUI) return;
		ui = ctx;
		// fresh bookkeeping (turn watermarks, debounce, linger) per session start
		monitor = buildMonitor();
		if (!timer) {
			timer = setInterval(() => void tick(), POLL_MS);
			timer.unref?.();
		}
		void tick();
	});

	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
		timer = undefined;
		ui?.ui.setWidget("subagents", undefined);
		ui?.ui.setStatus("subagents", undefined);
		ui = undefined;
	});

	registerSubCommand(pi, { subBin, runsDir: RUNS_DIR, sessionIdRef: () => sessionId });
}
