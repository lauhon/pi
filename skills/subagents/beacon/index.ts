/**
 * sub-beacon — the child's control surface.
 *
 * Loaded into every interactive subagent child with `-e`. It drains
 * `inbox/<seq>.md`, executes `control/<verb>`, and writes `state.json`,
 * `out-N.md`, `turns.jsonl` and `idle-N` into the run dir. All decisions live
 * in the pure reducer (reducer.ts); this file is only I/O.
 *
 * The run dir comes from `PI_SUB_RUN_DIR`. Without it the beacon is inert, so
 * loading it into an ordinary pi session does nothing.
 *
 * See skills/subagents/spec-interactive-children.md.
 */
import { execFile } from "node:child_process";
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
	createInitialState,
	normalizeContent,
	reduce,
	type BeaconEffect,
	type BeaconEvent,
	type BeaconState,
	type BranchEntry,
	type ControlVerb,
	type InboxItem,
} from "./reducer.ts";

const execFileP = promisify(execFile);

const DEFAULT_POLL_MS = 500;
const DEFAULT_IDLE_TTL_MS = 30 * 60_000;
const MAX_INBOX_BYTES = 256 * 1024;
const INBOX_FILE = /^(\d+)\.md$/;
const CONTROL_VERBS: readonly ControlVerb[] = ["abort", "quit"];

/** Injectable timer: tests hand-crank it, production uses setInterval. */
export interface Scheduler {
	every(ms: number, fn: () => void | Promise<void>): () => void;
}

/** Test-only scheduler shape: `tick()` runs the registered callback once. */
export interface ManualScheduler extends Scheduler {
	tick(): Promise<void>;
	readonly running: boolean;
}

export interface BeaconOptions {
	readonly runDir?: string;
	readonly idleTtlMs?: number;
	readonly pollMs?: number;
	readonly now?: () => number;
	readonly scheduler?: Scheduler;
	/** True while a tmux client is attached to this child (E10 guard). */
	readonly isClientAttached?: () => Promise<boolean>;
	readonly log?: (line: string) => void;
}

export interface Beacon {
	stop(): void;
	/** Current reducer state. Exposed for tests and debugging only. */
	readonly state: BeaconState;
}

// ── Minimal structural types for the pi API we touch ───────────────────

type SendOptions = { deliverAs: "followUp" } | undefined;

interface PiLike {
	on(event: string, handler: (event: unknown, ctx: CtxLike) => unknown): void;
	sendUserMessage(text: string, options?: SendOptions): unknown;
}

interface CtxLike {
	abort?: () => void;
	shutdown?: () => void;
	sessionManager?: { getBranch?: () => unknown[] };
}

// ── Filesystem helpers ─────────────────────────────────────────────────

function intervalScheduler(): Scheduler {
	return {
		every(ms, fn) {
			const timer = setInterval(() => void fn(), ms);
			timer.unref?.();
			return () => clearInterval(timer);
		},
	};
}

/** Text with no replacement characters round-trips; anything else is not UTF-8. */
function decodeUtf8(buffer: Buffer): string | undefined {
	const text = buffer.toString("utf8");
	return Buffer.compare(Buffer.from(text, "utf8"), buffer) === 0 ? text : undefined;
}

function readInbox(runDir: string): InboxItem[] {
	const dir = path.join(runDir, "inbox");
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const items: InboxItem[] = [];
	for (const name of names.sort()) {
		const match = INBOX_FILE.exec(name);
		if (!match) continue;
		const seq = Number.parseInt(match[1], 10);
		let buffer: Buffer;
		try {
			buffer = readFileSync(path.join(dir, name));
		} catch {
			continue; // raced with a rename; the next poll picks it up
		}
		if (buffer.byteLength > MAX_INBOX_BYTES) {
			items.push({
				seq,
				name,
				ok: false,
				reason: `too large (${buffer.byteLength} bytes > ${MAX_INBOX_BYTES})`,
			});
			continue;
		}
		const text = decodeUtf8(buffer);
		if (text === undefined) {
			items.push({ seq, name, ok: false, reason: "not valid utf-8" });
			continue;
		}
		if (text.trim() === "") {
			items.push({ seq, name, ok: false, reason: "empty" });
			continue;
		}
		items.push({ seq, name, ok: true, text });
	}
	return items;
}

/**
 * Rehydration data for a respawn (E4/E6): the highest turn number already
 * recorded and every user entry id already accounted for, so a fresh process
 * resuming the same run dir does not renumber turn 1 over the old one or
 * re-count the previous run's user entries as new.
 */
function readRehydration(runDir: string): { resumeTurn: number; knownEntryIds: string[] } {
	let raw: string;
	try {
		raw = readFileSync(path.join(runDir, "turns.jsonl"), "utf8");
	} catch {
		return { resumeTurn: 0, knownEntryIds: [] };
	}
	let resumeTurn = 0;
	const knownEntryIds: string[] = [];
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		let record: { turn?: unknown; userEntries?: unknown };
		try {
			record = JSON.parse(line);
		} catch {
			continue; // a partial trailing line from a previous crash; skip it
		}
		if (typeof record.turn === "number" && record.turn > resumeTurn) resumeTurn = record.turn;
		if (Array.isArray(record.userEntries)) {
			for (const id of record.userEntries) {
				if (typeof id === "string") knownEntryIds.push(id);
			}
		}
	}
	return { resumeTurn, knownEntryIds };
}

function readControl(runDir: string): ControlVerb[] {
	const dir = path.join(runDir, "control");
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	return CONTROL_VERBS.filter((verb) => names.includes(verb));
}

/** Flatten the current branch into the (id, role, text) triples the reducer matches on. */
function readBranch(ctx: CtxLike): BranchEntry[] {
	let entries: unknown[];
	try {
		entries = ctx.sessionManager?.getBranch?.() ?? [];
	} catch {
		return [];
	}
	const out: BranchEntry[] = [];
	for (const raw of entries) {
		if (typeof raw !== "object" || raw === null) continue;
		const entry = raw as { type?: string; id?: unknown; message?: unknown };
		if (entry.type !== undefined && entry.type !== "message") continue;
		const message = entry.message;
		if (typeof message !== "object" || message === null) continue;
		const { role, content } = message as {
			role?: unknown;
			content?: string | Array<{ type: string; text?: string }>;
		};
		if (role !== "user" && role !== "assistant") continue;
		if (typeof entry.id !== "string") continue;
		if (content === undefined) continue;
		out.push({ id: entry.id, role, text: normalizeContent(content) });
	}
	return out;
}

/** E27: never let a poller read a half-written state.json. */
function writeJsonAtomic(file: string, data: unknown): void {
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(data)}\n`);
	renameSync(tmp, file);
}

async function tmuxClientAttached(): Promise<boolean> {
	const session = process.env.PI_SUB_SESSION;
	const socket = process.env.PI_SUB_SOCKET ?? "pi-sub";
	if (!session) return false;
	try {
		const { stdout } = await execFileP(process.env.TMUX_BIN ?? "tmux", [
			"-L",
			socket,
			"display-message",
			"-p",
			"-t",
			session,
			"#{session_attached}",
		]);
		return Number.parseInt(stdout.trim(), 10) > 0;
	} catch {
		return false; // no server, no session, no client
	}
}

// ── Beacon ─────────────────────────────────────────────────────────────

export function createBeacon(pi: PiLike, options: BeaconOptions = {}): Beacon {
	const runDir = options.runDir;
	const now = options.now ?? Date.now;
	const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
	const idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
	const scheduler = options.scheduler ?? intervalScheduler();
	const isClientAttached = options.isClientAttached ?? tmuxClientAttached;
	const log =
		options.log ??
		((line: string) => {
			if (runDir) {
				try {
					appendFileSync(path.join(runDir, "beacon.log"), `${new Date().toISOString()} ${line}\n`);
				} catch {
					// the run dir may be gone (E14) — losing a log line is fine
				}
			}
		});

	let state = createInitialState({ idleTtlMs }, now());
	let stopPolling: (() => void) | undefined;
	let busy = false;

	function runEffects(effects: readonly BeaconEffect[], ctx: CtxLike): void {
		if (!runDir) return;
		for (const effect of effects) {
			try {
				applyEffect(effect, ctx);
			} catch (error) {
				// E14: the run dir can vanish under a live child. Log and keep going.
				log(`effect ${effect.type} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	function applyEffect(effect: BeaconEffect, ctx: CtxLike): void {
		if (!runDir) return;
		switch (effect.type) {
			case "writeState":
				writeJsonAtomic(path.join(runDir, "state.json"), {
					state: effect.phase,
					turn: effect.turn,
					since: effect.since,
					pid: process.pid,
				});
				break;

			case "renameInbox":
				renameSync(
					path.join(runDir, "inbox", effect.name),
					path.join(runDir, "inbox", `${effect.name}.${effect.to}`),
				);
				break;

			case "deleteControl":
				rmSync(path.join(runDir, "control", effect.verb), { force: true });
				break;

			case "sendUser":
				sendUser(effect.text, effect.deliverAs);
				break;

			case "writeOutput":
				writeFileSync(path.join(runDir, `out-${effect.turn}.md`), effect.text);
				break;

			case "appendTurn":
				appendFileSync(path.join(runDir, "turns.jsonl"), `${JSON.stringify(effect.record)}\n`);
				break;

			case "touchIdle":
				writeFileSync(path.join(runDir, `idle-${effect.turn}`), "");
				break;

			case "abort":
				ctx.abort?.();
				break;

			case "shutdown":
				log(`shutdown requested (${effect.reason})`);
				ctx.shutdown?.();
				break;

			case "log":
				log(effect.message);
				break;
		}
	}

	/**
	 * `sendUserMessage` throws when the agent started streaming between our
	 * decision and this call. Retrying as a follow-up is exactly what the file
	 * would have got one poll later.
	 */
	function sendUser(text: string, deliverAs: "followUp" | undefined): void {
		try {
			pi.sendUserMessage(text, deliverAs === undefined ? undefined : { deliverAs });
		} catch (error) {
			if (deliverAs !== undefined) throw error;
			log(`plain send rejected, retrying as followUp: ${error instanceof Error ? error.message : error}`);
			pi.sendUserMessage(text, { deliverAs: "followUp" });
		}
	}

	function dispatch(event: BeaconEvent, ctx: CtxLike): void {
		const result = reduce(state, event);
		state = result.state;
		runEffects(result.effects, ctx);
	}

	async function poll(ctx: CtxLike): Promise<void> {
		if (!runDir || busy) return;
		busy = true;
		try {
			const inbox = readInbox(runDir);
			const control = readControl(runDir);
			const at = now();
			// Probing tmux on every tick would be 2 processes/second forever; the
			// answer only matters when the TTL is otherwise about to fire.
			const ttlInPlay =
				(state.phase === "idle" || state.phase === "starting") &&
				!state.quitting &&
				at - state.since >= idleTtlMs;
			const clientAttached = ttlInPlay ? await isClientAttached() : false;
			dispatch({ type: "poll", now: now(), inbox, control, clientAttached }, ctx);
		} catch (error) {
			log(`poll failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			busy = false;
		}
	}

	function stop(): void {
		stopPolling?.();
		stopPolling = undefined;
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!runDir) return;
		try {
			mkdirSync(path.join(runDir, "inbox"), { recursive: true });
			mkdirSync(path.join(runDir, "control"), { recursive: true });
		} catch (error) {
			log(`could not create run dir subdirs: ${error instanceof Error ? error.message : error}`);
		}
		// Turn numbers and provenance accounting belong to the run dir, not this
		// process: a respawn on the same session.jsonl must not renumber turn 1
		// over the previous run's or re-count its user entries as fresh.
		const { resumeTurn, knownEntryIds } = readRehydration(runDir);
		dispatch({ type: "sessionStart", resumeTurn, knownEntryIds }, ctx);
		runEffects([{ type: "writeState", phase: state.phase, turn: state.turn, since: state.since }], ctx);
		if (!stopPolling) stopPolling = scheduler.every(pollMs, () => poll(ctx));
		await poll(ctx); // turn 1 lands without waiting a full poll interval
	});

	pi.on("agent_start", (_event, ctx) => {
		dispatch({ type: "agentStart", now: now() }, ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!runDir) return;
		dispatch(
			{ type: "agentSettled", now: now(), entries: readBranch(ctx), inbox: readInbox(runDir) },
			ctx,
		);
	});

	pi.on("ui_prompt_start", (_event, ctx) => {
		dispatch({ type: "uiPromptStart", now: now() }, ctx);
	});

	pi.on("ui_prompt_end", (_event, ctx) => {
		dispatch({ type: "uiPromptEnd", now: now() }, ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stop();
		dispatch({ type: "sessionShutdown", now: now() }, ctx);
	});

	return {
		stop,
		get state() {
			return state;
		},
	};
}

export default function (pi: PiLike): void {
	const ttl = Number.parseInt(process.env.PI_SUB_IDLE_TTL ?? "", 10);
	const pollMs = Number.parseInt(process.env.PI_SUB_POLL_MS ?? "", 10);
	createBeacon(pi, {
		runDir: process.env.PI_SUB_RUN_DIR,
		idleTtlMs: Number.isFinite(ttl) && ttl > 0 ? ttl * 1000 : undefined,
		pollMs: Number.isFinite(pollMs) && pollMs > 0 ? pollMs : undefined,
	});
}
