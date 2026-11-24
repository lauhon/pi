/**
 * Attention inbox data (spec "Attention inbox (v1)"): catches, outcome events, session status,
 * sub-run links and verdicts. Everything is derived from session files plus two small files
 * under $PI_ATTENTION_DIR (verdicts.jsonl, steer/). No model calls.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { assistantToolCalls, isAssistantEntry, isToolResultEntry, isUserEntry } from "./load.ts";
import type { RequestPoint, Session } from "./types.ts";

export const STEER_PREFIX = "[from attention view] ";
export const WORKING_MS = 3 * 60_000;
export const IDLE_MS = 30 * 60_000;
/** A session only counts as "waiting for you" while its last assistant message is younger than this. */
export const WAITING_MAX_MS = 2 * 3_600_000;
export const LINK_TURNS = 3;
const CORRECTION_CHARS = 160;

export function attentionDir(): string {
	return process.env.PI_ATTENTION_DIR || join(homedir(), ".pi", "attention");
}

export type CatchKind = "scope" | "schema" | "other";

export interface Catch {
	sessionPath: string;
	sessionId: string;
	entryId: string;
	requestIndex: number;
	turnIndex: number;
	timestamp: string;
	kind: CatchKind;
	decision: string;
	alternatives: string[];
	basis: string | null;
}

export interface Outcome {
	type: "esc" | "rewind" | "steer";
	sessionPath: string;
	sessionId: string;
	turnIndex: number;
	timestamp: string;
	/** esc and steer: first 160 chars of the user message that followed. */
	correction?: string;
	/** rewind: requests and context tokens on the abandoned branch. */
	requests?: number;
	droppedContextTokens?: number;
	/** Cost of the abandoned branch (rewind only). */
	abandonedCost?: number;
	abandonedTokens?: number;
	/** Key of the linked catch, if any. */
	catchKey: string | null;
}

export interface Saving {
	tokens: number;
	cost: number;
	requests: number;
	via: Outcome["type"];
}

export const catchKey = (c: Pick<Catch, "sessionId" | "entryId">): string => `${c.sessionId}:${c.entryId}`;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function extractCatches(session: Session): Catch[] {
	const out: Catch[] = [];
	for (const rp of session.requestPoints) {
		let n = 0;
		for (const call of rp.toolCalls) {
			if (call.name !== "assumption") continue;
			const kind = call.args.kind === "scope" || call.args.kind === "schema" ? call.args.kind : "other";
			const alts = Array.isArray(call.args.alternatives) ? call.args.alternatives.filter((a): a is string => typeof a === "string") : [];
			out.push({
				sessionPath: session.path,
				sessionId: session.id,
				// parallel calls in one assistant entry get a suffix so keys stay unique
				entryId: n === 0 ? rp.assistantEntryId : `${rp.assistantEntryId}#${n}`,
				requestIndex: rp.index,
				turnIndex: rp.turnIndex,
				timestamp: rp.timestamp,
				kind,
				decision: str(call.args.decision),
				alternatives: alts,
				basis: str(call.args.basis) || null,
			});
			n++;
		}
	}
	return out;
}

function tokensOf(rp: RequestPoint): number {
	return rp.usage.input + rp.usage.output + rp.usage.cacheWrite;
}

/** Outcome events without catch links. */
export function extractOutcomes(session: Session): Outcome[] {
	const out: Outcome[] = [];
	const base = { sessionPath: session.path, sessionId: session.id, catchKey: null };
	for (const rp of session.requestPoints) {
		if (rp.stopReason !== "aborted") continue;
		const next = session.turns.find((t) => t.index === rp.turnIndex + 1);
		if (!next || !next.userEntryId) continue;
		out.push({ ...base, type: "esc", turnIndex: rp.turnIndex, timestamp: next.startedAt, correction: next.userText.slice(0, CORRECTION_CHARS) });
	}
	for (const turn of session.turns) {
		if (turn.userEntryId && turn.userText.startsWith(STEER_PREFIX)) {
			out.push({ ...base, type: "steer", turnIndex: turn.index, timestamp: turn.startedAt, correction: turn.userText.slice(STEER_PREFIX.length, STEER_PREFIX.length + CORRECTION_CHARS) });
		}
	}
	out.push(...rewinds(session, base));
	return out.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}

function rewinds(session: Session, base: { sessionPath: string; sessionId: string; catchKey: null }): Outcome[] {
	const children = new Map<string, string[]>();
	for (const entry of session.entries) {
		if (entry.parentId === null) continue;
		const list = children.get(entry.parentId) ?? [];
		list.push(entry.id);
		children.set(entry.parentId, list);
	}
	const onBranch = new Set(session.branch.map((e) => e.id));
	const out: Outcome[] = [];
	for (const fork of session.forks) {
		let baseline = 0;
		for (let id = fork.parentId; id; id = session.byId.get(id)?.parentId ?? null) {
			const e = session.byId.get(id);
			if (e && isAssistantEntry(e)) {
				const u = e.message.usage;
				baseline = (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
				break;
			}
		}
		const keptChild = fork.childIds.find((id) => onBranch.has(id));
		const at = session.byId.get(keptChild ?? "")?.timestamp;
		for (const ab of fork.abandoned) {
			let requests = 0;
			let maxContext = 0;
			let cost = 0;
			let tokens = 0;
			const stack = [ab.headId];
			const seen = new Set<string>();
			while (stack.length) {
				const id = stack.pop()!;
				if (seen.has(id)) continue;
				seen.add(id);
				const e = session.byId.get(id);
				if (e && isAssistantEntry(e)) {
					const u = e.message.usage;
					requests++;
					maxContext = Math.max(maxContext, (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0));
					cost += u?.cost?.total ?? 0;
					tokens += (u?.input ?? 0) + (u?.output ?? 0) + (u?.cacheWrite ?? 0);
				}
				stack.push(...(children.get(id) ?? []));
			}
			out.push({
				...base,
				type: "rewind",
				turnIndex: fork.turnIndex,
				timestamp: at ?? session.byId.get(ab.headId)?.timestamp ?? session.startedAt,
				requests,
				droppedContextTokens: Math.max(0, maxContext - baseline),
				abandonedCost: cost,
				abandonedTokens: tokens,
			});
		}
	}
	return out;
}

/** Link each outcome to the nearest preceding catch within LINK_TURNS turns of the same session. */
export function linkOutcomes(catches: Catch[], outcomes: Outcome[]): Outcome[] {
	return outcomes.map((o) => {
		let best: Catch | null = null;
		for (const c of catches) {
			if (c.sessionId !== o.sessionId) continue;
			const dist = o.turnIndex - c.turnIndex;
			if (dist < 0 || dist > LINK_TURNS) continue;
			if (Date.parse(c.timestamp) > Date.parse(o.timestamp)) continue;
			if (!best || Date.parse(c.timestamp) > Date.parse(best.timestamp) || (c.timestamp === best.timestamp && c.requestIndex > best.requestIndex)) best = c;
		}
		return { ...o, catchKey: best ? catchKey(best) : null };
	});
}

/**
 * Estimate: work between the catch and the first linked outcome. Tokens are input + output +
 * cache writes (cache reads are not counted). It is spend that the assumption may have
 * wasted, not a measured saving.
 */
export function savingFor(c: Catch, outcomes: Outcome[], session: Session): Saving | null {
	const linked = outcomes.filter((o) => o.catchKey === catchKey(c)).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))[0];
	if (!linked) return null;
	const end = Date.parse(linked.timestamp);
	let tokens = linked.abandonedTokens ?? 0;
	let cost = linked.abandonedCost ?? 0;
	let requests = linked.requests ?? 0;
	for (const rp of session.requestPoints) {
		if (rp.index <= c.requestIndex || Date.parse(rp.timestamp) > end) continue;
		tokens += tokensOf(rp);
		cost += rp.usage.cost;
		requests++;
	}
	return { tokens, cost, requests, via: linked.type };
}

// ── status ─────────────────────────────────────────────────────────────────

export type Status = "working" | "waiting" | "idle";

export type Shape = "working" | "waiting";

/** What the last message entry says: a turn in progress, or the agent waiting for the user. */
export function lastShape(session: Session): Shape {
	for (let i = session.entries.length - 1; i >= 0; i--) {
		const e = session.entries[i];
		if (isUserEntry(e) || isToolResultEntry(e)) return "working";
		if (isAssistantEntry(e)) return assistantToolCalls(e.message).length > 0 ? "working" : "waiting";
	}
	return "waiting";
}

/** Timestamp of the last assistant message, or null when there is none. */
export function lastAssistantMs(session: Session): number | null {
	for (let i = session.entries.length - 1; i >= 0; i--) {
		const e = session.entries[i];
		if (!isAssistantEntry(e)) continue;
		const t = Date.parse(e.timestamp);
		return Number.isFinite(t) ? t : null;
	}
	return null;
}

/**
 * working: the last entry is mid-turn and the file changed within 3 min.
 * waiting: the agent stopped and its last message is under 2 h old, or a mid-turn file went quiet
 *   for 3 to 30 min (a stalled run needs a look too).
 * idle: everything else.
 */
export function statusFrom(shape: Shape, mtimeMs: number, now = Date.now(), lastAssistant: number | null = null): Status {
	const age = now - mtimeMs;
	if (shape === "working") return age <= WORKING_MS ? "working" : age <= IDLE_MS ? "waiting" : "idle";
	return now - (lastAssistant ?? mtimeMs) < WAITING_MAX_MS ? "waiting" : "idle";
}

export function sessionStatus(session: Session, mtimeMs: number, now = Date.now()): Status {
	return statusFrom(lastShape(session), mtimeMs, now, lastAssistantMs(session));
}

export function projectOf(session: Session, path: string): string {
	const cwd = session.cwd ? basename(session.cwd) : "";
	return cwd || basename(dirname(path));
}

export function nameOf(session: Session): string | null {
	for (let i = session.entries.length - 1; i >= 0; i--) {
		const entry = session.entries[i] as { type: string; name?: unknown };
		if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) return entry.name.trim();
	}
	return null;
}

export function ageDays(session: Session, now = Date.now()): number {
	const t = Date.parse(session.entries[0]?.timestamp ?? session.startedAt);
	return Number.isFinite(t) ? Math.max(0, (now - t) / 86_400_000) : 0;
}

export function totalCost(session: Session): number {
	return session.requestPoints.reduce((s, rp) => s + rp.usage.cost, 0);
}

/** A session file in a sub-run dir has a `parent` file next to it holding the parent session id. */
export function subRunInfo(sessionPath: string): { name: string; parentId: string; runDir: string } | null {
	const runDir = dirname(sessionPath);
	try {
		const parentId = readFileSync(join(runDir, "parent"), "utf8").trim();
		if (!parentId) return null;
		return { name: basename(runDir), parentId, runDir };
	} catch {
		return null;
	}
}

// ── verdicts ───────────────────────────────────────────────────────────────

export type Verdict = "useful" | "noise";

export function verdictsFile(dir = attentionDir()): string {
	return join(dir, "verdicts.jsonl");
}

export function readVerdicts(dir = attentionDir()): Map<string, { verdict: Verdict; at: string }> {
	const out = new Map<string, { verdict: Verdict; at: string }>();
	if (!existsSync(verdictsFile(dir))) return out;
	for (const line of readFileSync(verdictsFile(dir), "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const v = JSON.parse(line) as { catchKey?: unknown; verdict?: unknown; at?: unknown };
			if (typeof v.catchKey === "string" && (v.verdict === "useful" || v.verdict === "noise")) out.set(v.catchKey, { verdict: v.verdict, at: str(v.at) });
		} catch {
			// a partial line from a crash
		}
	}
	return out;
}

export function appendVerdict(catchKeyValue: string, verdict: Verdict, dir = attentionDir(), now = Date.now()): void {
	mkdirSync(dir, { recursive: true });
	appendFileSync(verdictsFile(dir), `${JSON.stringify({ catchKey: catchKeyValue, verdict, at: new Date(now).toISOString() })}\n`);
}
